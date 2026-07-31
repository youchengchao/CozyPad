package com.cozypad.app

import net.schmizz.sshj.DefaultConfig
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SshSecurityPolicyTest {
    @Test
    fun removesLegacyAlgorithmsFromEveryNegotiatedCategory() {
        val config = DefaultConfig()
        SshSecurityPolicy.configure(config)

        val names = buildList {
            addAll(config.keyExchangeFactories.map { it.name })
            addAll(config.cipherFactories.map { it.name })
            addAll(config.macFactories.map { it.name })
            addAll(config.keyAlgorithms.map { it.name })
        }

        assertTrue(names.isNotEmpty())
        assertTrue(config.keyExchangeFactories.all { it.name in SshSecurityPolicy.allowedKeyExchanges })
        assertTrue(config.cipherFactories.all { it.name in SshSecurityPolicy.allowedCiphers })
        assertTrue(config.macFactories.all { it.name in SshSecurityPolicy.allowedMacs })
        assertTrue(
            config.keyAlgorithms.all { it.name in SshSecurityPolicy.allowedHostKeyAlgorithms },
        )
        assertFalse(
            names.any {
                val name = it.lowercase()
                name.contains("sha1") ||
                    name.contains("ssh-rsa") ||
                    name.contains("ssh-dss") ||
                    name.contains("cbc") ||
                    name.contains("3des") ||
                    name.contains("arcfour") ||
                    name.contains("md5")
            },
        )
    }
}
