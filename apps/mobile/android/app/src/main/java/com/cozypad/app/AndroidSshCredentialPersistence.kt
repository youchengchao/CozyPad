package com.cozypad.app

import android.content.Context
import org.json.JSONObject

internal class AndroidSshCredentialPersistence(
    context: Context,
) : SshCredentialPersistence {
    private val encryptedStore = AndroidKeystoreAeadStore(context)

    override fun get(profileId: String): SshCredential? {
        val raw = encryptedStore.get(logicalKey(profileId)) ?: return null
        return try {
            decode(JSONObject(raw))
        } catch (_: Exception) {
            encryptedStore.remove(logicalKey(profileId))
            null
        }
    }

    override fun put(profileId: String, credential: SshCredential) {
        encryptedStore.put(logicalKey(profileId), encode(credential).toString())
    }

    override fun remove(profileId: String) {
        encryptedStore.remove(logicalKey(profileId))
    }

    private fun encode(credential: SshCredential): JSONObject =
        JSONObject()
            .put("version", 2)
            .put("authMethod", credential.authMethod)
            .put("host", credential.target.host)
            .put("port", credential.target.port)
            .put("username", credential.target.username)
            .apply {
                when (credential) {
                    is SshCredential.Password -> put("password", credential.password)
                    is SshCredential.PrivateKey -> {
                        put("privateKey", credential.privateKey)
                        credential.passphrase?.let { put("passphrase", it) }
                    }
                }
            }

    private fun decode(value: JSONObject): SshCredential {
        require(value.getInt("version") == 2) { "unsupported SSH credential version" }
        val target = SshTarget(
            host = value.getString("host"),
            port = value.getInt("port"),
            username = value.getString("username"),
        )
        return when (value.getString("authMethod")) {
            "password" -> SshCredential.Password(target, value.getString("password"))
            "privateKey" ->
                SshCredential.PrivateKey(
                    target,
                    value.getString("privateKey"),
                    value.optString("passphrase").takeIf { it.isNotEmpty() },
                )
            else -> error("unsupported SSH credential")
        }
    }

    private fun logicalKey(profileId: String) = "ssh-credential:$profileId"
}
