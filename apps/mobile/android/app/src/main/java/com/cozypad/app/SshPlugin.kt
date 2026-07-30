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
import java.security.MessageDigest
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

    private var client: SSHClient? = null
    private val shells = ConcurrentHashMap<String, ShellSession>()
    private val terminalIds = AtomicInteger(0)
    private val pendingHostKeys = ConcurrentHashMap<String, HostKeyDecision>()
    private val hostKeyIds = AtomicInteger(0)
    @Volatile private var backgroundEnabled = false
    @Volatile private var backgroundHost = ""

    private class ShellSession(
        val session: Session,
        val shell: Session.Shell,
        val output: OutputStream,
    )

    private class HostKeyDecision {
        val latch = CountDownLatch(1)
        @Volatile var accepted = false
    }

    // ── 連線 ────────────────────────────────────────────────────────────────

    @PluginMethod
    fun connect(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host is required")
        val port = call.getInt("port") ?: 22
        val username = call.getString("username") ?: return call.reject("username is required")
        val password = call.getString("password")
        val knownFingerprint = call.getString("knownFingerprint")

        thread(name = "cozypad-ssh-connect") {
            try {
                disconnectInternal()
                val config = DefaultConfig()
                config.keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
                val ssh = SSHClient(config)
                ssh.connectTimeout = 15_000
                ssh.timeout = 0
                ssh.addHostKeyVerifier(promptingVerifier(host, port, knownFingerprint))
                ssh.connect(host, port)
                if (password != null) {
                    ssh.authPassword(username, password)
                } else {
                    ssh.authPublickey(username)
                }
                ssh.connection.keepAlive.keepAliveInterval = 10
                client = ssh

                // 網路掉線或對端關閉時也要通知 UI，而不是靜靜地失效。
                thread(name = "cozypad-ssh-watch") {
                    try {
                        while (ssh.isConnected) {
                            Thread.sleep(3_000)
                        }
                    } catch (_: Exception) {
                    } finally {
                        if (client === ssh) {
                            client = null
                            closeAllShells()
                            stopBackgroundService()
                            notifyListeners("connectionState", JSObject().put("state", "disconnected"))
                        }
                    }
                }

                if (backgroundEnabled) {
                    backgroundHost = "$username@$host"
                    SshForegroundService.start(context, backgroundHost)
                }
                notifyListeners("connectionState", JSObject().put("state", "connected"))
                call.resolve()
            } catch (error: Exception) {
                client = null
                notifyListeners(
                    "connectionState",
                    JSObject().put("state", "error").put("error", error.message ?: "connect failed"),
                )
                call.reject(error.message ?: "connect failed", error)
            }
        }
    }

    /**
     * Host key 驗證：指紋與已知值相同才靜默通過，否則交給 UI 決定
     * （首次信任／變更警告），在使用者回應前阻擋這條連線。
     */
    private fun promptingVerifier(host: String, port: Int, known: String?): HostKeyVerifier =
        object : HostKeyVerifier {
            override fun verify(hostname: String, p: Int, key: PublicKey): Boolean {
                val fingerprint = sha256Fingerprint(key)
                if (known != null && known == fingerprint) return true

                val requestId = "hk-${hostKeyIds.incrementAndGet()}"
                val decision = HostKeyDecision()
                pendingHostKeys[requestId] = decision
                notifyListeners(
                    "hostKeyPrompt",
                    JSObject()
                        .put("requestId", requestId)
                        .put("host", host)
                        .put("port", port)
                        .put("keyType", key.algorithm ?: "unknown")
                        .put("fingerprintSha256", fingerprint)
                        .put("status", if (known == null) "new" else "changed")
                        .put("previousFingerprint", known ?: ""),
                )
                val answered = decision.latch.await(3, TimeUnit.MINUTES)
                pendingHostKeys.remove(requestId)
                return answered && decision.accepted
            }

            override fun findExistingAlgorithms(hostname: String, p: Int): List<String> = emptyList()
        }

    private fun sha256Fingerprint(key: PublicKey): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.encoded)
        return Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    @PluginMethod
    fun respondHostKey(call: PluginCall) {
        val requestId = call.getString("requestId") ?: return call.reject("requestId is required")
        val accept = call.getBoolean("accept") ?: false
        pendingHostKeys[requestId]?.let {
            it.accepted = accept
            it.latch.countDown()
        }
        call.resolve()
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        stopBackgroundService()
        disconnectInternal()
        notifyListeners("connectionState", JSObject().put("state", "disconnected"))
        call.resolve()
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
        call.resolve(JSObject().put("connected", client?.isConnected == true))
    }

    private fun stopBackgroundService() {
        try {
            SshForegroundService.stop(context)
        } catch (_: Exception) {
        }
    }

    private fun disconnectInternal() {
        closeAllShells()
        try {
            client?.disconnect()
        } catch (_: Exception) {
        }
        client = null
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
        val ssh = client ?: return call.reject("not connected")

        try {
            val session = ssh.startSession()
            session.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap<PTYMode, Int>())
            val shell = session.startShell()
            val terminalId = "mobile-term-${terminalIds.incrementAndGet()}"
            shells[terminalId] = ShellSession(session, shell, shell.outputStream)

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
