package com.cozypad.app

import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.Provider
import java.security.Security
import javax.crypto.KeyAgreement

class SshCryptoProviderTest {
    @Test
    fun replacesLegacyBcProviderWithBundledX25519Provider() {
        val original = Security.getProvider(BouncyCastleProvider.PROVIDER_NAME)
        val originalPosition = Security.getProviders().indexOf(original) + 1

        @Suppress("DEPRECATION")
        val legacy = object : Provider(
            BouncyCastleProvider.PROVIDER_NAME,
            1.0,
            "Legacy Android BC without X25519",
        ) {}

        try {
            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
            assertTrue(Security.addProvider(legacy) > 0)

            SshCryptoProvider.ensureInstalled()

            val installed = Security.getProvider(BouncyCastleProvider.PROVIDER_NAME)
            assertTrue(installed is BouncyCastleProvider)
            assertNotNull(installed.getService("KeyAgreement", "X25519"))
            assertEquals(
                BouncyCastleProvider.PROVIDER_NAME,
                KeyAgreement.getInstance(
                    "X25519",
                    BouncyCastleProvider.PROVIDER_NAME,
                ).provider.name,
            )
        } finally {
            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
            if (original != null) {
                Security.insertProviderAt(original, originalPosition.coerceAtLeast(1))
            }
        }
    }
}
