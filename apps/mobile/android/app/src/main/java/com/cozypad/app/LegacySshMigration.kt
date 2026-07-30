package com.cozypad.app

import android.content.Context
import org.json.JSONArray

internal class LegacySshMigration(
    context: Context,
    private val persistence: SshCredentialPersistence,
) {
    private val legacy by lazy { legacySecurePreferences(context) }

    /**
     * Runs during native plugin startup, before the WebView app can request any
     * stored value. Each successful migration removes the old JS-addressable
     * secret immediately.
     */
    @Synchronized
    fun migrateAll() {
        val rawProfiles = legacy.getString(PROFILES_KEY, null) ?: return
        val profiles = try {
            JSONArray(rawProfiles)
        } catch (_: Exception) {
            return
        }

        for (index in 0 until profiles.length()) {
            val profile = profiles.optJSONObject(index) ?: continue
            val profileId = profile.optString("id")
            val host = profile.optString("host")
            val port = profile.optInt("port", 22)
            val username = profile.optString("username")
            val authMethod = profile.optString("authMethod", "password")
            if (
                profileId.isBlank() ||
                host.isBlank() ||
                port !in 1..65535 ||
                username.isBlank()
            ) {
                continue
            }

            val passwordKey = passwordKey(profileId)
            val privateKeyKey = privateKeyKey(profileId)
            val passphraseKey = passphraseKey(profileId)
            val target = SshTarget(host, port, username)
            val migrated = when (authMethod) {
                "password" ->
                    legacy.getString(passwordKey, null)?.let {
                        SshCredential.Password(target, it)
                    }
                "privateKey" ->
                    legacy.getString(privateKeyKey, null)?.takeIf { it.isNotBlank() }?.let {
                        SshCredential.PrivateKey(
                            target,
                            it,
                            legacy.getString(passphraseKey, null),
                        )
                    }
                else -> null
            }

            try {
                if (persistence.get(profileId) == null && migrated != null) {
                    persistence.put(profileId, migrated)
                }
                if (persistence.get(profileId) != null) {
                    legacy.edit()
                        .remove(passwordKey)
                        .remove(privateKeyKey)
                        .remove(passphraseKey)
                        .commit()
                }
            } catch (_: Exception) {
                // Keep the legacy ciphertext for a later retry if migration
                // cannot be completed; never replace it with plaintext.
            }
        }
    }

    private fun passwordKey(profileId: String) = "password:$profileId"
    private fun privateKeyKey(profileId: String) = "private-key:$profileId"
    private fun passphraseKey(profileId: String) = "key-passphrase:$profileId"

    private companion object {
        const val PROFILES_KEY = "profiles"
    }
}
