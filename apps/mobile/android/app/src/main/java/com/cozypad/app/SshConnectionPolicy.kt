package com.cozypad.app

import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.SSHClient

/**
 * SSHJ only starts its keepalive thread during connect, so this policy must be
 * applied before SSHClient.connect(). Socket.isConnected alone is not a
 * liveness check; transport.isRunning becomes false when SSHJ detects failure.
 */
internal object SshConnectionPolicy {
    const val KEEP_ALIVE_INTERVAL_SECONDS = 5
    const val KEEP_ALIVE_MAX_MISSES = 2
    const val WATCH_INTERVAL_MS = 1_000L

    fun configureBeforeConnect(ssh: SSHClient) {
        val keepAlive = ssh.connection.keepAlive
        keepAlive.keepAliveInterval = KEEP_ALIVE_INTERVAL_SECONDS
        if (keepAlive is KeepAliveRunner) {
            keepAlive.maxAliveCount = KEEP_ALIVE_MAX_MISSES
        }
    }

    fun isAlive(ssh: SSHClient?): Boolean =
        try {
            ssh != null &&
                ssh.isConnected &&
                ssh.transport.isRunning &&
                ssh.transport.isAuthenticated
        } catch (_: Exception) {
            false
        }
}
