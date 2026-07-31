package com.cozypad.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SshCredentialVaultTest {
    private class MemoryPersistence : SshCredentialPersistence {
        val values = mutableMapOf<String, SshCredential>()

        override fun get(profileId: String): SshCredential? = values[profileId]

        override fun put(profileId: String, credential: SshCredential) {
            values[profileId] = credential
        }

        override fun remove(profileId: String) {
            values.remove(profileId)
        }
    }

    private val target = SshTarget("server.example", 22, "cozy")

    @Test
    fun persistedCredentialNeverNeedsToLeaveTheNativeVault() {
        val persistence = MemoryPersistence()
        val vault = SshCredentialVault(persistence)
        val credential = SshCredential.PrivateKey(target, "private-key", "passphrase")

        assertTrue(vault.configure("profile-1", target, "privateKey", true, credential))
        assertSame(credential, vault.get("profile-1", target, "privateKey"))
        assertSame(credential, persistence.values["profile-1"])
        assertTrue(vault.status("profile-1", target, "privateKey").persisted)
    }

    @Test
    fun rejectsCredentialReuseForAnotherHostOrUsername() {
        val persistence = MemoryPersistence()
        val vault = SshCredentialVault(persistence)
        val credential = SshCredential.Password(target, "password")
        vault.configure("profile-1", target, "password", true, credential)

        assertNull(
            vault.get(
                "profile-1",
                target.copy(host = "attacker.example"),
                "password",
            ),
        )
        assertNull(
            vault.get(
                "profile-1",
                target.copy(username = "other-user"),
                "password",
            ),
        )
    }

    @Test
    fun transientCredentialSupportsReconnectWithoutDiskPersistence() {
        val persistence = MemoryPersistence()
        val vault = SshCredentialVault(persistence)
        val credential = SshCredential.Password(target, "password")

        assertTrue(vault.configure("profile-1", target, "password", false, credential))
        assertFalse(persistence.values.containsKey("profile-1"))
        assertSame(credential, vault.get("profile-1", target, "password"))
        assertSame(credential, vault.get("profile-1", target, "password"))
        assertFalse(vault.status("profile-1", target, "password").persisted)

        assertTrue(vault.configure("profile-1", target, "password", false, null))
        assertFalse(persistence.values.containsKey("profile-1"))
        assertSame(credential, vault.get("profile-1", target, "password"))
    }

    @Test
    fun changingTargetWithoutReenteringSecretFailsClosed() {
        val persistence = MemoryPersistence()
        val vault = SshCredentialVault(persistence)
        vault.configure(
            "profile-1",
            target,
            "password",
            true,
            SshCredential.Password(target, "password"),
        )

        assertFalse(
            vault.configure(
                "profile-1",
                target.copy(host = "new.example"),
                "password",
                true,
                null,
            ),
        )
        assertFalse(persistence.values.containsKey("profile-1"))
    }
}
