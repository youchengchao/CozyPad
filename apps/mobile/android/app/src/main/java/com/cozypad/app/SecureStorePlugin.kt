package com.cozypad.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Encrypted storage for non-secret WebView state such as profile metadata.
 * SSH credentials and host trust keys are explicitly denied and owned by the
 * native SSH plugin.
 */
@CapacitorPlugin(name = "CozyPadSecureStore")
class SecureStorePlugin : Plugin() {
    private val encryptedStore by lazy { AndroidKeystoreAeadStore(context) }
    private val legacy by lazy { legacySecurePreferences(context) }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        if (isNativeOnlyKey(key)) return call.reject("access denied")
        try {
            val logicalKey = logicalKey(key)
            var value = encryptedStore.get(logicalKey)
            if (value == null) {
                value = legacy.getString(key, null)
                if (value != null) {
                    encryptedStore.put(logicalKey, value)
                }
            }
            call.resolve(JSObject().put("value", value))
        } catch (error: Exception) {
            call.reject(error.message ?: "secure storage unavailable")
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        if (isNativeOnlyKey(key)) return call.reject("access denied")
        val value = call.getString("value") ?: return call.reject("value is required")
        try {
            encryptedStore.put(logicalKey(key), value)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message ?: "secure storage unavailable")
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        if (isNativeOnlyKey(key)) return call.reject("access denied")
        try {
            encryptedStore.remove(logicalKey(key))
            if (key != "profiles") {
                legacy.edit().remove(key).commit()
            }
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message ?: "secure storage unavailable")
        }
    }

    private fun logicalKey(key: String) = "web-state:$key"

    private fun isNativeOnlyKey(key: String): Boolean =
        key == "known_hosts" ||
            key.startsWith("password:") ||
            key.startsWith("private-key:") ||
            key.startsWith("key-passphrase:")
}
