package com.cozypad.app

import android.util.Base64
import net.schmizz.sshj.common.Buffer
import java.security.MessageDigest
import java.security.PublicKey

internal enum class HostKeyFingerprintMatch {
    CURRENT,
    LEGACY_ANDROID,
    NONE,
}

internal object SshHostKeyFingerprint {
    /**
     * OpenSSH-compatible SHA256 fingerprint over the SSH wire-format public
     * key blob, e.g. SHA256:AbCd... (without Base64 padding).
     */
    fun sha256(key: PublicKey): String {
        val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
        val digest = MessageDigest.getInstance("SHA-256").digest(blob)
        return "SHA256:" + Base64.encodeToString(
            digest,
            Base64.NO_WRAP or Base64.NO_PADDING,
        )
    }

    fun match(known: String?, key: PublicKey): HostKeyFingerprintMatch {
        if (known.isNullOrBlank()) return HostKeyFingerprintMatch.NONE
        val current = sha256(key)
        if (normalize(known) == normalize(current)) return HostKeyFingerprintMatch.CURRENT

        // Versions before the native trust store hashed X.509 SubjectPublicKeyInfo.
        // Accept it only for a silent, one-time migration to the standard SSH hash.
        val legacy = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(key.encoded),
            Base64.NO_WRAP,
        )
        return if (known == legacy) {
            HostKeyFingerprintMatch.LEGACY_ANDROID
        } else {
            HostKeyFingerprintMatch.NONE
        }
    }

    private fun normalize(value: String): String =
        value.removePrefix("SHA256:").trimEnd('=')
}
