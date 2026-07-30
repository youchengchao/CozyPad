package com.cozypad.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small versioned envelope-encryption store backed directly by Android
 * Keystore. Values are AES-256-GCM authenticated and bound to their logical
 * key with AAD, preventing ciphertext swapping between profiles.
 */
internal class AndroidKeystoreAeadStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun get(logicalKey: String): String? {
        val storageKey = storageKey(logicalKey)
        val encoded = prefs.getString(storageKey, null) ?: return null
        return try {
            decrypt(logicalKey, Base64.decode(encoded, Base64.NO_WRAP))
        } catch (_: Exception) {
            // Restored/corrupt ciphertext or an invalidated Keystore key must
            // fail closed. Never return unauthenticated data to the SSH layer.
            prefs.edit().remove(storageKey).commit()
            null
        }
    }

    @Synchronized
    fun put(logicalKey: String, value: String) {
        val encoded = Base64.encodeToString(encrypt(logicalKey, value), Base64.NO_WRAP)
        check(prefs.edit().putString(storageKey(logicalKey), encoded).commit()) {
            "unable to persist encrypted SSH data"
        }
    }

    @Synchronized
    fun remove(logicalKey: String) {
        check(prefs.edit().remove(storageKey(logicalKey)).commit()) {
            "unable to remove encrypted SSH data"
        }
    }

    private fun encrypt(logicalKey: String, value: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(aad(logicalKey))
        val plaintext = value.toByteArray(StandardCharsets.UTF_8)
        return try {
            val ciphertext = cipher.doFinal(plaintext)
            ByteBuffer.allocate(2 + cipher.iv.size + ciphertext.size)
                .put(FORMAT_VERSION)
                .put(cipher.iv.size.toByte())
                .put(cipher.iv)
                .put(ciphertext)
                .array()
        } finally {
            plaintext.fill(0)
        }
    }

    private fun decrypt(logicalKey: String, envelope: ByteArray): String {
        require(envelope.size > 2) { "invalid encrypted SSH data" }
        val buffer = ByteBuffer.wrap(envelope)
        require(buffer.get() == FORMAT_VERSION) { "unsupported encrypted SSH data" }
        val ivLength = buffer.get().toInt() and 0xff
        require(ivLength in 12..16 && buffer.remaining() > ivLength) {
            "invalid encrypted SSH data"
        }
        val iv = ByteArray(ivLength)
        buffer.get(iv)
        val ciphertext = ByteArray(buffer.remaining())
        buffer.get(ciphertext)

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad(logicalKey))
        val plaintext = cipher.doFinal(ciphertext)
        return try {
            String(plaintext, StandardCharsets.UTF_8)
        } finally {
            plaintext.fill(0)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun aad(logicalKey: String): ByteArray =
        "$AAD_PREFIX$logicalKey".toByteArray(StandardCharsets.UTF_8)

    private fun storageKey(logicalKey: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(logicalKey.toByteArray(StandardCharsets.UTF_8))
        return Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private companion object {
        const val PREFERENCES_NAME = "cozypad_native_security_v2"
        const val KEY_ALIAS = "cozypad_native_security_aes_v2"
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val AAD_PREFIX = "cozypad:v2:"
        const val FORMAT_VERSION: Byte = 2
    }
}
