package com.cozypad.app

import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SshConnectionPolicyTest {
    @Test
    fun configuresKeepAliveBeforeConnectionStarts() {
        val config = DefaultConfig()
        config.keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
        val ssh = SSHClient(config)

        SshConnectionPolicy.configureBeforeConnect(ssh)

        val keepAlive = ssh.connection.keepAlive
        assertEquals(
            SshConnectionPolicy.KEEP_ALIVE_INTERVAL_SECONDS,
            keepAlive.keepAliveInterval,
        )
        assertTrue(keepAlive is KeepAliveRunner)
        assertEquals(
            SshConnectionPolicy.KEEP_ALIVE_MAX_MISSES,
            (keepAlive as KeepAliveRunner).maxAliveCount,
        )
    }
}
