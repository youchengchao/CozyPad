package com.cozypad.app

import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Provider
import java.security.Security
import javax.crypto.KeyAgreement

/**
 * Replaces Android's legacy provider named "BC" only when it cannot supply
 * X25519. SSHJ selects Bouncy Castle by provider name, so merely bundling a
 * recent bcprov JAR is insufficient while Android's older provider owns it.
 */
internal object SshCryptoProvider {
    private const val PROVIDER_NAME = BouncyCastleProvider.PROVIDER_NAME

    @Synchronized
    fun ensureInstalled() {
        if (supportsX25519(Security.getProvider(PROVIDER_NAME))) return

        Security.removeProvider(PROVIDER_NAME)
        val position = Security.addProvider(BouncyCastleProvider())
        check(position > 0) { "Unable to register bundled Bouncy Castle provider" }

        val installed = Security.getProvider(PROVIDER_NAME)
        check(supportsX25519(installed)) {
            "Bundled Bouncy Castle provider does not support X25519"
        }

        // Exercise the same provider-name lookup used by SSHJ.
        KeyAgreement.getInstance("X25519", PROVIDER_NAME)
    }

    private fun supportsX25519(provider: Provider?): Boolean =
        provider?.getService("KeyAgreement", "X25519") != null
}
