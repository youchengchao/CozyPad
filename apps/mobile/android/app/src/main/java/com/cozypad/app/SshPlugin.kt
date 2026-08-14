package com.cozypad.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.IOUtils
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.io.OutputStream
import java.security.PublicKey
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * 手機端的原生 SSH transport。
 *
 * WebView 沒有 raw TCP，因此和桌面由 Electron main process 持有 ssh2 一樣，
 * 這裡由原生層持有連線，JS 只透過這個 plugin 操作——對應同一個 PlatformBridge。
 */
@CapacitorPlugin(name = "CozyPadSsh")
class SshPlugin : Plugin() {

    @Volatile private var client: SSHClient? = null
    @Volatile private var clientProfileId: String? = null
    @Volatile private var pendingConnect: PendingConnect? = null
    private val credentialPersistence by lazy { AndroidSshCredentialPersistence(context) }
    private val credentialVault by lazy { SshCredentialVault(credentialPersistence) }
    private val legacyMigration by lazy { LegacySshMigration(context, credentialPersistence) }
    private val hostKeyStore by lazy { SshHostKeyStore(context) }
    private val shells = ConcurrentHashMap<String, ShellSession>()
    private val terminalIds = AtomicInteger(0)
    private val pendingHostKeys = ConcurrentHashMap<String, HostKeyDecision>()
    private val hostKeyIds = AtomicInteger(0)
    private val connectAttempts = SshConnectAttemptGate()
    @Volatile private var backgroundEnabled = false
    @Volatile private var backgroundHost = ""
    private val agentBridge by lazy {
        SshAgentBridge(context) { event, payload -> notifyListeners(event, payload) }
    }

    private class ShellSession(
        val session: Session,
        val shell: Session.Shell,
        val output: OutputStream,
    )

    private class HostKeyDecision(
        val attemptId: Int,
        val profileId: String,
        val host: String,
        val port: Int,
        val fingerprint: String,
    ) {
        val latch = CountDownLatch(1)
        @Volatile var accepted = false
    }

    private class PendingConnect(
        val attemptId: Int,
        val requestId: String?,
        val profileId: String,
        val ssh: SSHClient,
    )

    override fun load() {
        super.load()
        // Runs before the WebView app requests profile data.
        try {
            legacyMigration.migrateAll()
            hostKeyStore.migrateLegacy()
        } catch (_: Exception) {
            // A damaged legacy store must not disable the native SSH plugin.
        }
    }

    // ── 連線 ────────────────────────────────────────────────────────────────

    @PluginMethod
    fun configureCredential(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("profileId is required")
        val target = readTarget(call) ?: return
        val authMethod = call.getString("authMethod") ?: "password"
        val remember = call.getBoolean("rememberCredential") ?: true
        val supplied = when (authMethod) {
            "password" ->
                call.getString("password")?.takeIf { it.isNotEmpty() }?.let {
                    SshCredential.Password(target, it)
                }
            "privateKey" ->
                call.getString("privateKey")?.takeIf { it.isNotBlank() }?.let {
                    SshCredential.PrivateKey(
                        target,
                        it,
                        call.getString("passphrase")?.takeIf(String::isNotEmpty),
                    )
                }
            else -> return call.reject("unsupported authMethod: $authMethod")
        }

        try {
            credentialVault.configure(
                profileId,
                target,
                authMethod,
                remember,
                supplied,
            )
            call.resolve(credentialStatusJson(credentialVault.status(profileId, target, authMethod)))
        } catch (error: Exception) {
            call.reject(error.message ?: "unable to store SSH credential")
        }
    }

    @PluginMethod
    fun hasCredential(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("profileId is required")
        val target = readTarget(call) ?: return
        val authMethod = call.getString("authMethod") ?: "password"
        try {
            call.resolve(credentialStatusJson(credentialVault.status(profileId, target, authMethod)))
        } catch (error: Exception) {
            call.reject(error.message ?: "unable to inspect SSH credential")
        }
    }

    @PluginMethod
    fun deleteCredential(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("profileId is required")
        try {
            credentialVault.remove(profileId)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message ?: "unable to remove SSH credential")
        }
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("profileId is required")
        val requestId = call.getString("requestId")
        val target = readTarget(call) ?: return
        val authMethod = call.getString("authMethod") ?: "password"
        val credential = try {
            credentialVault.get(profileId, target, authMethod)
        } catch (error: Exception) {
            return call.reject(error.message ?: "invalid SSH profile")
        } ?: return call.reject(
            if (authMethod == "privateKey") {
                "SSH private key is required"
            } else {
                "SSH password is required"
            },
        )
        val host = target.host
        val port = target.port
        val username = target.username
        val attemptId = connectAttempts.begin()
        cancelPendingHostKeys()
        abortPendingConnect()

        thread(name = "cozypad-ssh-connect") {
            var pending: PendingConnect? = null
            try {
                SshCryptoProvider.ensureInstalled()
                val config = DefaultConfig()
                config.keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
                SshSecurityPolicy.configure(config)
                val ssh = SSHClient(config)
                pending = PendingConnect(attemptId, requestId, profileId, ssh)
                val registered = connectAttempts.runIfCurrent(attemptId) {
                    synchronized(this) {
                        pendingConnect = pending
                    }
                }
                if (!registered) {
                    forceClose(ssh)
                    call.reject("SSH connection superseded")
                    return@thread
                }
                ssh.connectTimeout = 15_000
                ssh.timeout = 0
                ssh.addHostKeyVerifier(promptingVerifier(profileId, host, port, attemptId))
                SshConnectionPolicy.configureBeforeConnect(ssh)
                ssh.connect(host, port)
                // Host-key confirmation is interactive and is allowed to wait. Once
                // transport setup finishes, authentication itself must be bounded.
                ssh.timeout = 15_000
                when (credential) {
                    is SshCredential.PrivateKey -> {
                        val keyProvider = SshPrivateKeyLoader.load(
                            ssh,
                            credential.privateKey,
                            credential.passphrase,
                        )
                        ssh.authPublickey(username, keyProvider)
                    }
                    is SshCredential.Password -> ssh.authPassword(username, credential.password)
                }
                ssh.timeout = 0
                var previousClient: SSHClient? = null
                val installed = connectAttempts.runIfCurrent(attemptId) {
                    synchronized(this) {
                        if (pendingConnect === pending) pendingConnect = null
                        previousClient = client
                        client = ssh
                        clientProfileId = profileId
                    }
                }
                if (!installed) {
                    clearPendingConnect(pending)
                    forceClose(ssh)
                    call.reject("SSH connection superseded")
                    return@thread
                }
                closeAllShells()
                closeGracefully(previousClient)

                // 網路掉線或對端關閉時也要通知 UI，而不是靜靜地失效。
                thread(name = "cozypad-ssh-watch") {
                    try {
                        while (SshConnectionPolicy.isAlive(ssh)) {
                            Thread.sleep(SshConnectionPolicy.WATCH_INTERVAL_MS)
                        }
                    } catch (_: Exception) {
                    } finally {
                        markDisconnected(ssh)
                    }
                }

                if (backgroundEnabled) {
                    backgroundHost = "$username@$host"
                    SshForegroundService.start(context, backgroundHost)
                }
                notifyListeners(
                    "connectionState",
                    JSObject().put("state", "connected").put("profileId", profileId),
                )
                call.resolve()
            } catch (error: Exception) {
                pending?.let {
                    clearPendingConnect(it)
                    val wasInstalled = synchronized(this) {
                        if (client !== it.ssh) {
                            false
                        } else {
                            client = null
                            clientProfileId = null
                            true
                        }
                    }
                    if (wasInstalled) closeAllShells()
                    forceClose(it.ssh)
                }
                if (!connectAttempts.isCurrent(attemptId)) {
                    call.reject("SSH connection superseded")
                    return@thread
                }
                notifyListeners(
                    "connectionState",
                    JSObject()
                        .put("state", "error")
                        .put("profileId", profileId)
                        .put("error", error.message ?: "connect failed"),
                )
                call.reject(error.message ?: "connect failed", error)
            }
        }
    }

    /**
     * Host key 驗證：指紋與已知值相同才靜默通過，否則交給 UI 決定
     * （首次信任／變更警告），在使用者回應前阻擋這條連線。
     */
    private fun readTarget(call: PluginCall): SshTarget? {
        val host = call.getString("host")
        if (host.isNullOrBlank()) {
            call.reject("host is required")
            return null
        }
        val port = call.getInt("port") ?: 22
        if (port !in 1..65535) {
            call.reject("port must be between 1 and 65535")
            return null
        }
        val username = call.getString("username")
        if (username.isNullOrBlank()) {
            call.reject("username is required")
            return null
        }
        return SshTarget(host, port, username)
    }

    private fun credentialStatusJson(status: SshCredentialStatus): JSObject =
        JSObject()
            .put("hasCredential", status.hasCredential)
            .put("credentialPersisted", status.persisted)

    private fun promptingVerifier(
        profileId: String,
        host: String,
        port: Int,
        attemptId: Int,
    ): HostKeyVerifier =
        object : HostKeyVerifier {
            override fun verify(hostname: String, p: Int, key: PublicKey): Boolean {
                if (!connectAttempts.isCurrent(attemptId)) return false
                val fingerprint = SshHostKeyFingerprint.sha256(key)
                val known = hostKeyStore.get(host, port)
                when (SshHostKeyFingerprint.match(known, key)) {
                    HostKeyFingerprintMatch.CURRENT -> return true
                    HostKeyFingerprintMatch.LEGACY_ANDROID -> {
                        hostKeyStore.put(host, port, fingerprint)
                        return true
                    }
                    HostKeyFingerprintMatch.NONE -> Unit
                }

                val requestId = "hk-${hostKeyIds.incrementAndGet()}"
                val decision = HostKeyDecision(attemptId, profileId, host, port, fingerprint)
                val registered = connectAttempts.runIfCurrent(attemptId) {
                    pendingHostKeys[requestId] = decision
                    notifyListeners(
                        "hostKeyPrompt",
                        JSObject()
                            .put("requestId", requestId)
                            .put("profileId", profileId)
                            .put("host", host)
                            .put("port", port)
                            .put("keyType", key.algorithm ?: "unknown")
                            .put("fingerprintSha256", fingerprint)
                            .put("status", if (known == null) "new" else "changed")
                            .put("previousFingerprint", known ?: ""),
                    )
                }
                if (!registered) return false
                val answered = decision.latch.await(60, TimeUnit.SECONDS)
                if (!connectAttempts.isCurrent(attemptId)) return false
                pendingHostKeys.remove(requestId)
                return answered && decision.accepted
            }

            override fun findExistingAlgorithms(hostname: String, p: Int): List<String> = emptyList()
        }

    @PluginMethod
    fun respondHostKey(call: PluginCall) {
        val requestId = call.getString("requestId") ?: return call.reject("requestId is required")
        val accept = call.getBoolean("accept") ?: false
        val decision = pendingHostKeys.remove(requestId)
            ?: return call.reject("unknown or expired SSH host key request")
        if (!connectAttempts.isCurrent(decision.attemptId)) {
            decision.latch.countDown()
            return call.reject("expired SSH host key request")
        }
        if (accept) {
            try {
                hostKeyStore.put(decision.host, decision.port, decision.fingerprint)
            } catch (error: Exception) {
                decision.accepted = false
                decision.latch.countDown()
                return call.reject(error.message ?: "unable to save SSH host key")
            }
        }
        decision.accepted = accept
        decision.latch.countDown()
        call.resolve()
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val requestedProfileId = call.getString("profileId")
        stopBackgroundService()
        val disconnectedProfileId = disconnectInternal() ?: requestedProfileId
        val event = JSObject().put("state", "disconnected")
        if (!disconnectedProfileId.isNullOrBlank()) {
            event.put("profileId", disconnectedProfileId)
        }
        notifyListeners("connectionState", event)
        call.resolve()
    }

    @PluginMethod
    fun cancelRequest(call: PluginCall) {
        val requestId = call.getString("requestId") ?: return call.reject("requestId is required")
        val pending = synchronized(this) {
            pendingConnect?.takeIf { it.requestId == requestId }
        }
        if (pending == null || !connectAttempts.invalidateIfCurrent(pending.attemptId)) {
            call.resolve(JSObject().put("cancelled", false))
            return
        }
        cancelPendingHostKeys(pending.attemptId)
        clearPendingConnect(pending)
        forceClose(pending.ssh)
        call.resolve(JSObject().put("cancelled", true))
    }

    @PluginMethod
    fun startAgentBridge(call: PluginCall) {
        val ssh = client ?: return call.reject("not connected")
        val profileId = call.getString("profileId")
            ?: return call.reject("profileId is required")
        val name = call.getString("name") ?: "Remote host"
        val host = call.getString("host") ?: return call.reject("host is required")
        val port = call.getInt("port") ?: 22
        val username = call.getString("username")
            ?: return call.reject("username is required")
        val fingerprint = hostKeyStore.get(host, port)
            ?: return call.reject("trusted host fingerprint is unavailable")
        thread(name = "cozypad-agent-start") {
            try {
                agentBridge.start(
                    ssh,
                    AgentHostConfig(
                        profileId,
                        name,
                        host,
                        port,
                        username,
                        fingerprint,
                    ),
                )
                call.resolve()
            } catch (error: Exception) {
                call.reject(error.message ?: "unable to start Agent bridge", error)
            }
        }
    }

    @PluginMethod
    fun stopAgentBridge(call: PluginCall) {
        agentBridge.stop()
        call.resolve()
    }

    @PluginMethod
    fun agentRequest(call: PluginCall) {
        val line = call.getString("line") ?: return call.reject("line is required")
        thread(name = "cozypad-agent-request") {
            try {
                agentBridge.send(line)
                call.resolve()
            } catch (error: Exception) {
                call.reject(error.message ?: "unable to send Agent request", error)
            }
        }
    }

    // ── 背景維持連線 ────────────────────────────────────────────────────

    @PluginMethod
    fun getBackgroundMode(call: PluginCall) {
        call.resolve(
            JSObject().put("supported", true).put("enabled", backgroundEnabled),
        )
    }

    @PluginMethod
    fun setBackgroundMode(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        backgroundEnabled = enabled
        if (enabled) {
            requestNotificationPermission()
            val host = call.getString("host") ?: "remote host"
            backgroundHost = host
            if (client != null) SshForegroundService.start(context, host)
        } else {
            stopBackgroundService()
        }
        call.resolve()
    }

    /**
     * Android 13+ 沒有這個執行期權限時，前景服務仍會執行但常駐通知不會顯示——
     * 使用者會完全看不出連線正在背景維持。
     */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return
        activity?.let {
            ActivityCompat.requestPermissions(
                it,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                4711,
            )
        }
    }

    /** 連線是否仍活著；程序被凍結後回到前景時用來確認。 */
    @PluginMethod
    fun isConnected(call: PluginCall) {
        call.resolve(JSObject().put("connected", SshConnectionPolicy.isAlive(client)))
    }

    private fun stopBackgroundService() {
        try {
            SshForegroundService.stop(context)
        } catch (_: Exception) {
        }
    }

    private fun closeGracefully(ssh: SSHClient?) {
        if (ssh == null) return
        try {
            ssh.disconnect()
        } catch (_: Exception) {
        }
    }

    /** Closing the socket first interrupts connect/auth reads immediately. */
    private fun forceClose(ssh: SSHClient) {
        try {
            ssh.socket?.close()
        } catch (_: Exception) {
        }
        closeGracefully(ssh)
    }

    private fun clearPendingConnect(pending: PendingConnect?): Boolean = synchronized(this) {
        if (pending == null || pendingConnect !== pending) return@synchronized false
        pendingConnect = null
        true
    }

    private fun abortPendingConnect(): PendingConnect? {
        val pending = synchronized(this) {
            val current = pendingConnect
            pendingConnect = null
            current
        }
        pending?.let { forceClose(it.ssh) }
        return pending
    }

    private fun disconnectCurrentClient(): String? {
        var profileId: String? = null
        val ssh = synchronized(this) {
            val current = client
            profileId = clientProfileId
            client = null
            clientProfileId = null
            current
        }
        closeAllShells()
        closeGracefully(ssh)
        return profileId
    }

    private fun cancelPendingHostKeys(attemptId: Int? = null) {
        for ((requestId, decision) in pendingHostKeys) {
            if (attemptId != null && decision.attemptId != attemptId) continue
            if (!pendingHostKeys.remove(requestId, decision)) continue
            decision.accepted = false
            decision.latch.countDown()
        }
    }

    private fun disconnectInternal(): String? {
        connectAttempts.invalidate()
        cancelPendingHostKeys()
        agentBridge.stop()
        val pending = abortPendingConnect()
        return disconnectCurrentClient() ?: pending?.profileId
    }

    private fun markDisconnected(ssh: SSHClient, error: String? = null) {
        var profileId: String? = null
        val wasCurrent = synchronized(this) {
            if (client !== ssh) {
                false
            } else {
                profileId = clientProfileId
                client = null
                clientProfileId = null
                true
            }
        }
        if (!wasCurrent) return

        agentBridge.stop()
        try {
            ssh.disconnect()
        } catch (_: Exception) {
        }
        closeAllShells()
        stopBackgroundService()
        val event = JSObject().put("state", "disconnected")
        if (!profileId.isNullOrBlank()) event.put("profileId", profileId)
        if (!error.isNullOrBlank()) event.put("error", error)
        notifyListeners("connectionState", event)
    }

    private fun closeAllShells() {
        for ((terminalId, shell) in shells) {
            try {
                shell.shell.close()
                shell.session.close()
            } catch (_: Exception) {
            }
            notifyListeners("terminalClosed", JSObject().put("terminalId", terminalId))
        }
        shells.clear()
    }

    // ── 一次性命令（telemetry、檔案操作、tmux 佈建都走這裡）──────────────

    @PluginMethod
    fun exec(call: PluginCall) {
        val command = call.getString("command") ?: return call.reject("command is required")
        val timeoutMs = call.getInt("timeoutMs") ?: 15_000
        val streamId = call.getString("streamId")
        val ssh = client ?: return call.reject("not connected")

        thread(name = "cozypad-ssh-exec") {
            var session: Session? = null
            var timedOut = false
            var watchdog: Thread? = null
            try {
                session = ssh.startSession()
                val activeSession = session
                val command1 = activeSession.exec(command)

                // 讀取會一直阻塞到 EOF，所以逾時必須由外部關閉 session 來打斷，
                // 否則一個不產出輸出又不結束的命令會永遠卡住。
                watchdog = thread(name = "cozypad-ssh-exec-timeout", isDaemon = true) {
                    try {
                        Thread.sleep(timeoutMs.toLong())
                        timedOut = true
                        activeSession.close()
                    } catch (_: InterruptedException) {
                    } catch (_: Exception) {
                    }
                }

                val output = StringBuilder()
                if (streamId == null) {
                    output.append(IOUtils.readFully(command1.inputStream).toString("UTF-8"))
                } else {
                    // 逐行回報，長時間作業（如建置 tmux）才有即時進度。
                    command1.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                        for (line in lines) {
                            output.append(line).append('\n')
                            notifyListeners(
                                "execLine",
                                JSObject().put("streamId", streamId).put("line", line),
                            )
                        }
                    }
                }

                if (timedOut) {
                    call.reject("remote command timed out after ${timeoutMs}ms")
                    return@thread
                }

                command1.join(5, TimeUnit.SECONDS)
                val exitCode = command1.exitStatus ?: 0
                val stderr = IOUtils.readFully(command1.errorStream).toString("UTF-8")
                if (output.isEmpty() && exitCode != 0) {
                    call.reject(if (stderr.isBlank()) "command exited with $exitCode" else stderr.trim())
                } else {
                    call.resolve(JSObject().put("output", output.toString()))
                }
            } catch (error: Exception) {
                if (timedOut) {
                    call.reject("remote command timed out after ${timeoutMs}ms")
                } else {
                    if (!SshConnectionPolicy.isAlive(ssh)) {
                        markDisconnected(ssh, error.message)
                    }
                    call.reject(error.message ?: "exec failed", error)
                }
            } finally {
                watchdog?.interrupt()
                try {
                    session?.close()
                } catch (_: Exception) {
                }
            }
        }
    }

    // ── 互動式終端機（PTY）─────────────────────────────────────────────

    @PluginMethod
    fun openTerminal(call: PluginCall) {
        val cols = call.getInt("cols") ?: 80
        val rows = call.getInt("rows") ?: 24
        val cwd = call.getString("cwd") ?: return call.reject("cwd is required")
        val ssh = client ?: return call.reject("not connected")

        try {
            val session = ssh.startSession()
            session.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap<PTYMode, Int>())
            val shell = session.startShell()
            val terminalId = "mobile-term-${terminalIds.incrementAndGet()}"
            shells[terminalId] = ShellSession(session, shell, shell.outputStream)
            val cwdCommand = when {
                cwd == "~" -> "cd -- \"\$HOME\" || exit 1"
                cwd.startsWith("~/") ->
                    "cd -- \"\$HOME\"/${quoteForShell(cwd.removePrefix("~/"))} || exit 1"
                else -> "cd -- ${quoteForShell(cwd)} || exit 1"
            }
            shell.outputStream.write("$cwdCommand\n".toByteArray())
            shell.outputStream.flush()

            // PTY 位元組原樣以 base64 送給 JS，維持 binary-safe。
            thread(name = "cozypad-ssh-pty-$terminalId") {
                val buffer = ByteArray(8192)
                try {
                    while (true) {
                        val read = shell.inputStream.read(buffer)
                        if (read < 0) break
                        if (read == 0) continue
                        notifyListeners(
                            "terminalOutput",
                            JSObject()
                                .put("terminalId", terminalId)
                                .put(
                                    "dataBase64",
                                    Base64.encodeToString(buffer.copyOf(read), Base64.NO_WRAP),
                                ),
                        )
                    }
                } catch (_: Exception) {
                } finally {
                    shells.remove(terminalId)
                    try {
                        session.close()
                    } catch (_: Exception) {
                    }
                    notifyListeners("terminalClosed", JSObject().put("terminalId", terminalId))
                }
            }

            call.resolve(JSObject().put("terminalId", terminalId))
        } catch (error: Exception) {
            call.reject(error.message ?: "open terminal failed", error)
        }
    }

    private fun quoteForShell(value: String): String =
        "'" + value.replace("'", "'\"'\"'") + "'"

    @PluginMethod
    fun writeTerminal(call: PluginCall) {
        val terminalId = call.getString("terminalId") ?: return call.reject("terminalId is required")
        val dataBase64 = call.getString("dataBase64") ?: return call.reject("dataBase64 is required")
        val shell = shells[terminalId] ?: return call.reject("unknown terminal")
        try {
            shell.output.write(Base64.decode(dataBase64, Base64.NO_WRAP))
            shell.output.flush()
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message ?: "write failed", error)
        }
    }

    @PluginMethod
    fun resizeTerminal(call: PluginCall) {
        val terminalId = call.getString("terminalId") ?: return call.reject("terminalId is required")
        val cols = call.getInt("cols") ?: 80
        val rows = call.getInt("rows") ?: 24
        val shell = shells[terminalId] ?: return call.resolve()
        try {
            shell.shell.changeWindowDimensions(cols, rows, 0, 0)
        } catch (_: Exception) {
        }
        call.resolve()
    }

    @PluginMethod
    fun closeTerminal(call: PluginCall) {
        val terminalId = call.getString("terminalId") ?: return call.reject("terminalId is required")
        shells.remove(terminalId)?.let {
            try {
                it.shell.close()
                it.session.close()
            } catch (_: Exception) {
            }
            notifyListeners("terminalClosed", JSObject().put("terminalId", terminalId))
        }
        call.resolve()
    }

    override fun handleOnDestroy() {
        disconnectInternal()
        super.handleOnDestroy()
    }
}
