package com.cozypad.app

import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 手機端的加密儲存，對應桌面的 Electron safeStorage：
 * 連線設定與密碼經 Android Keystore 加密，密碼永不回傳給 WebView。
 */
@CapacitorPlugin(name = "CozyPadSecureStore")
class SecureStorePlugin : Plugin() {

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "cozypad_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        call.resolve(JSObject().put("value", prefs.getString(key, null)))
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        val value = call.getString("value") ?: return call.reject("value is required")
        prefs.edit().putString(key, value).apply()
        call.resolve()
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        prefs.edit().remove(key).apply()
        call.resolve()
    }
}
