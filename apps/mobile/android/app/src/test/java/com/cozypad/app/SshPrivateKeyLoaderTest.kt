package com.cozypad.app

import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.security.KeyPairGenerator
import java.util.Base64

class SshPrivateKeyLoaderTest {
    @Test
    fun parsesAnInMemoryPkcs8PrivateKey() {
        val generated = KeyPairGenerator.getInstance("RSA").apply {
            initialize(2048)
        }.generateKeyPair()
        val encoded = Base64.getMimeEncoder(64, "\n".toByteArray())
            .encodeToString(generated.private.encoded)
        val privateKey = "-----BEGIN PRIVATE KEY-----\n$encoded\n-----END PRIVATE KEY-----\n"

        val provider = SshPrivateKeyLoader.load(
            SSHClient(DefaultConfig()),
            privateKey,
            null,
        )

        assertEquals("RSA", provider.private.algorithm)
        assertArrayEquals(generated.private.encoded, provider.private.encoded)
    }
}
