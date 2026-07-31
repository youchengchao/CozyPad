package com.cozypad.app

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.password.PasswordUtils

internal object SshPrivateKeyLoader {
    fun load(
        ssh: SSHClient,
        privateKey: String,
        passphrase: String?,
    ): KeyProvider {
        val passwordFinder = passphrase
            ?.takeIf { it.isNotEmpty() }
            ?.toCharArray()
            ?.let(PasswordUtils::createOneOff)
        return ssh.loadKeys(privateKey, null, passwordFinder)
    }
}
