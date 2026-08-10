package com.cozypad.app

import android.content.Context
import android.util.Base64
import com.getcapacitor.JSObject
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.common.IOUtils
import net.schmizz.sshj.xfer.InMemorySourceFile
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

data class AgentHostConfig(
    val profileId: String,
    val name: String,
    val host: String,
    val port: Int,
    val username: String,
    val fingerprint: String,
)

/**
 * One bidirectional SSH exec channel to the Node Agent host.
 *
 * Android owns only transport. Session state, ACP children, tmux, approvals
 * and persistence stay on the SSH target in remote-agent-host.cjs.
 */
class SshAgentBridge(
    private val context: Context,
    private val emit: (String, JSObject) -> Unit,
) {
    private class Running(
        val session: Session,
        val command: Session.Command,
        val input: OutputStream,
    )

    @Volatile private var running: Running? = null

    fun start(ssh: SSHClient, config: AgentHostConfig) {
        stop()
        val home = execText(ssh, "printf '%s' \"\$HOME\"").trim()
        require(home.startsWith("/") && home != "/") {
            "Remote host did not provide a safe user home directory"
        }
        val directory = home.trimEnd('/') + "/.cozypad"
        val remotePath = "$directory/remote-agent-host.cjs"
        execText(ssh, "mkdir -p -- ${shellQuote(directory)}")
        uploadRunner(ssh, remotePath)

        val encodedConfig = Base64.encodeToString(
            JSONObject()
                .put("profileId", config.profileId)
                .put("name", config.name)
                .put("host", config.host)
                .put("port", config.port)
                .put("username", config.username)
                .put("fingerprint", config.fingerprint)
                .toString()
                .toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP,
        )
        val invocation = buildInvocation(home, remotePath, encodedConfig)
        val session = ssh.startSession()
        val command = session.exec(invocation)
        val active = Running(session, command, command.outputStream)
        running = active

        val ready = CountDownLatch(1)
        var startupError: String? = null
        thread(name = "cozypad-agent-host") {
            try {
                command.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                    for (line in lines) {
                        if (line.isBlank()) continue
                        val type = try {
                            JSONObject(line).optString("type")
                        } catch (_: Exception) {
                            ""
                        }
                        if (type == "ready") {
                            ready.countDown()
                        } else {
                            emit("agentMessage", JSObject().put("line", line))
                        }
                    }
                }
            } catch (error: Exception) {
                startupError = error.message ?: "Agent host stream failed"
            } finally {
                if (running === active) running = null
                val stderr = try {
                    IOUtils.readFully(command.errorStream).toString("UTF-8").trim()
                } catch (_: Exception) {
                    ""
                }
                val detail = stderr.ifBlank {
                    startupError ?: "Remote Agent bridge closed"
                }
                ready.countDown()
                emit("agentClosed", JSObject().put("error", detail))
                try {
                    session.close()
                } catch (_: Exception) {
                }
            }
        }

        if (!ready.await(20, TimeUnit.SECONDS) || running !== active) {
            stop()
            throw IllegalStateException(
                startupError ?: "Remote Agent host did not answer its handshake",
            )
        }
    }

    @Synchronized
    fun send(line: String) {
        val active = running ?: throw IllegalStateException("Agent bridge is not connected")
        active.input.write(line.toByteArray(Charsets.UTF_8))
        active.input.write('\n'.code)
        active.input.flush()
    }

    @Synchronized
    fun stop() {
        val active = running ?: return
        running = null
        try {
            active.input.close()
        } catch (_: Exception) {
        }
        try {
            active.command.close()
        } catch (_: Exception) {
        }
        try {
            active.session.close()
        } catch (_: Exception) {
        }
    }

    private fun uploadRunner(ssh: SSHClient, remotePath: String) {
        val bytes = context.assets
            .open("cozypad/remote-agent-host.cjs")
            .use { it.readBytes() }
        val source = object : InMemorySourceFile() {
            override fun getName(): String = "remote-agent-host.cjs"
            override fun getLength(): Long = bytes.size.toLong()
            override fun getInputStream(): InputStream = ByteArrayInputStream(bytes)
        }
        ssh.newSFTPClient().use { sftp ->
            sftp.put(source, remotePath)
        }
    }

    private fun execText(ssh: SSHClient, commandText: String): String {
        ssh.startSession().use { session ->
            val command = session.exec(commandText)
            val output = IOUtils.readFully(command.inputStream).toString("UTF-8")
            command.join(15, TimeUnit.SECONDS)
            val code = command.exitStatus ?: 0
            if (code != 0) {
                val stderr = IOUtils.readFully(command.errorStream).toString("UTF-8").trim()
                throw IllegalStateException(stderr.ifBlank { "Remote command exited with $code" })
            }
            return output
        }
    }

    private fun buildInvocation(
        home: String,
        remotePath: String,
        encodedConfig: String,
    ): String = """
cozypad_login_shell="${'$'}{SHELL:-}"
if [ -z "${'$'}cozypad_login_shell" ] && command -v getent >/dev/null 2>&1; then
  cozypad_login_shell="${'$'}(getent passwd "${'$'}(id -u)" | cut -d: -f7)"
fi
if [ -z "${'$'}cozypad_login_shell" ]; then cozypad_login_shell=/bin/sh; fi
cozypad_login_env="${'$'}("${'$'}cozypad_login_shell" -l -i -c env 2>/dev/null || true)"
cozypad_login_path="${'$'}(printf '%s\n' "${'$'}cozypad_login_env" | sed -n 's/^PATH=//p' | tail -n 1)"
if [ -z "${'$'}cozypad_login_path" ]; then cozypad_login_path="${'$'}PATH"; fi
PATH="${'$'}cozypad_login_path"
export PATH
cozypad_node="${'$'}(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"
if [ -z "${'$'}cozypad_node" ]; then echo "Node.js is required on the remote host" >&2; exit 127; fi
exec env HOME=${shellQuote(home)} PATH="${'$'}cozypad_login_path" "${'$'}cozypad_node" ${shellQuote(remotePath)} ${shellQuote(encodedConfig)}
""".trimIndent()

    private fun shellQuote(value: String): String =
        "'" + value.replace("'", "'\"'\"'") + "'"
}
