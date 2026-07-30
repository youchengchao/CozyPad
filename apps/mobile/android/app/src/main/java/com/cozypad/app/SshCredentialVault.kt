package com.cozypad.app

import java.util.concurrent.ConcurrentHashMap

internal data class SshTarget(
    val host: String,
    val port: Int,
    val username: String,
)

internal sealed interface SshCredential {
    val target: SshTarget
    val authMethod: String

    data class Password(
        override val target: SshTarget,
        val password: String,
    ) : SshCredential {
        override val authMethod = "password"
    }

    data class PrivateKey(
        override val target: SshTarget,
        val privateKey: String,
        val passphrase: String?,
    ) : SshCredential {
        override val authMethod = "privateKey"
    }
}

internal interface SshCredentialPersistence {
    fun get(profileId: String): SshCredential?
    fun put(profileId: String, credential: SshCredential)
    fun remove(profileId: String)
}

internal data class SshCredentialStatus(
    val hasCredential: Boolean,
    val persisted: Boolean,
)

/**
 * Keeps SSH secrets outside the WebView. Persisted credentials are encrypted by
 * [AndroidSshCredentialPersistence]; non-persisted credentials live only for
 * the current native process so reconnect remains seamless.
 *
 * Credentials are bound to host, port, username, and authentication method.
 * A compromised renderer therefore cannot redirect a saved password to a
 * different SSH server merely by changing profile metadata.
 */
internal class SshCredentialVault(
    private val persistence: SshCredentialPersistence,
) {
    private val transient = ConcurrentHashMap<String, SshCredential>()

    @Synchronized
    fun configure(
        profileId: String,
        target: SshTarget,
        authMethod: String,
        remember: Boolean,
        supplied: SshCredential?,
    ): Boolean {
        requireValid(profileId, target, authMethod)
        if (supplied != null) {
            require(supplied.target == target && supplied.authMethod == authMethod) {
                "credential does not match its SSH profile"
            }
            if (remember) {
                persistence.put(profileId, supplied)
                transient.remove(profileId)
            } else {
                persistence.remove(profileId)
                transient[profileId] = supplied
            }
            return true
        }

        val transientCredential = transient[profileId]
        if (transientCredential != null) {
            if (
                transientCredential.target != target ||
                transientCredential.authMethod != authMethod
            ) {
                remove(profileId)
                return false
            }
            if (remember) {
                persistence.put(profileId, transientCredential)
                transient.remove(profileId)
            }
            return true
        }

        val persistedCredential = persistence.get(profileId)
        if (
            persistedCredential == null ||
            persistedCredential.target != target ||
            persistedCredential.authMethod != authMethod
        ) {
            remove(profileId)
            return false
        }

        if (!remember) {
            remove(profileId)
            return false
        }
        return true
    }

    @Synchronized
    fun get(
        profileId: String,
        target: SshTarget,
        authMethod: String,
    ): SshCredential? {
        requireValid(profileId, target, authMethod)
        val credential = transient[profileId] ?: persistence.get(profileId) ?: return null
        return credential.takeIf {
            it.target == target && it.authMethod == authMethod
        }
    }

    @Synchronized
    fun status(
        profileId: String,
        target: SshTarget,
        authMethod: String,
    ): SshCredentialStatus {
        requireValid(profileId, target, authMethod)
        transient[profileId]?.let {
            if (it.target == target && it.authMethod == authMethod) {
                return SshCredentialStatus(hasCredential = true, persisted = false)
            }
        }
        persistence.get(profileId)?.let {
            if (it.target == target && it.authMethod == authMethod) {
                return SshCredentialStatus(hasCredential = true, persisted = true)
            }
        }
        return SshCredentialStatus(hasCredential = false, persisted = false)
    }

    @Synchronized
    fun remove(profileId: String) {
        transient.remove(profileId)
        persistence.remove(profileId)
    }

    private fun requireValid(profileId: String, target: SshTarget, authMethod: String) {
        require(profileId.isNotBlank() && profileId.length <= 256) { "invalid profileId" }
        require(target.host.isNotBlank() && target.host.length <= 255) { "invalid SSH host" }
        require(target.port in 1..65535) { "invalid SSH port" }
        require(target.username.isNotBlank() && target.username.length <= 256) {
            "invalid SSH username"
        }
        require(authMethod == "password" || authMethod == "privateKey") {
            "unsupported authMethod: $authMethod"
        }
    }
}
