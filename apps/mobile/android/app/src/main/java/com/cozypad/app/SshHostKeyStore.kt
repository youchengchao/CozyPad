package com.cozypad.app

import android.content.Context
import org.json.JSONObject

/**
 * Native-only host trust store. The WebView can approve a prompt but cannot
 * read, overwrite, or pre-seed trusted fingerprints.
 */
internal class SshHostKeyStore(context: Context) {
    private val encryptedStore = AndroidKeystoreAeadStore(context)
    private val legacy by lazy { legacySecurePreferences(context) }

    @Synchronized
    fun migrateLegacy() {
        val raw = legacy.getString(LEGACY_KNOWN_HOSTS_KEY, null) ?: return
        val hosts = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }

        try {
            for (entry in hosts.keys()) {
                val separator = entry.lastIndexOf(':')
                if (separator <= 0) continue
                val host = entry.substring(0, separator)
                val port = entry.substring(separator + 1).toIntOrNull() ?: continue
                val fingerprint = hosts.optString(entry)
                if (host.isNotBlank() && port in 1..65535 && fingerprint.isNotBlank()) {
                    val logicalKey = logicalKey(host, port)
                    if (encryptedStore.get(logicalKey) == null) {
                        encryptedStore.put(logicalKey, fingerprint)
                    }
                }
            }
            legacy.edit().remove(LEGACY_KNOWN_HOSTS_KEY).commit()
        } catch (_: Exception) {
            // Leave the legacy trust map intact so migration can retry.
        }
    }

    @Synchronized
    fun get(host: String, port: Int): String? =
        encryptedStore.get(logicalKey(host, port))

    @Synchronized
    fun put(host: String, port: Int, fingerprint: String) {
        encryptedStore.put(logicalKey(host, port), fingerprint)
    }

    private fun logicalKey(host: String, port: Int) = "ssh-host-key:${host.length}:$host:$port"

    private companion object {
        const val LEGACY_KNOWN_HOSTS_KEY = "known_hosts"
    }
}
