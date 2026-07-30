package com.cozypad.app

import net.schmizz.sshj.DefaultConfig

/**
 * Security-first SSH algorithm policy. Legacy SHA-1, DSA, CBC, 3DES, RC4, and
 * MD5 algorithms are deliberately excluded instead of silently negotiated.
 */
internal object SshSecurityPolicy {
    internal val allowedKeyExchanges = setOf(
        "curve25519-sha256",
        "curve25519-sha256@libssh.org",
        "diffie-hellman-group-exchange-sha256",
        "ecdh-sha2-nistp256",
        "ecdh-sha2-nistp384",
        "ecdh-sha2-nistp521",
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group15-sha512",
        "diffie-hellman-group16-sha512",
        "diffie-hellman-group17-sha512",
        "diffie-hellman-group18-sha512",
        "ext-info-c",
    )

    internal val allowedCiphers = setOf(
        "chacha20-poly1305@openssh.com",
        "aes128-gcm@openssh.com",
        "aes256-gcm@openssh.com",
        "aes128-ctr",
        "aes192-ctr",
        "aes256-ctr",
    )

    internal val allowedMacs = setOf(
        "hmac-sha2-256-etm@openssh.com",
        "hmac-sha2-512-etm@openssh.com",
        "hmac-sha2-256",
        "hmac-sha2-512",
    )

    internal val allowedHostKeyAlgorithms = setOf(
        "ssh-ed25519-cert-v01@openssh.com",
        "ssh-ed25519",
        "ecdsa-sha2-nistp256-cert-v01@openssh.com",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384-cert-v01@openssh.com",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521-cert-v01@openssh.com",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512-cert-v01@openssh.com",
        "rsa-sha2-512",
        "rsa-sha2-256-cert-v01@openssh.com",
        "rsa-sha2-256",
    )

    fun configure(config: DefaultConfig) {
        config.keyExchangeFactories =
            config.keyExchangeFactories.filter { it.name in allowedKeyExchanges }
        config.cipherFactories =
            config.cipherFactories.filter { it.name in allowedCiphers }
        config.macFactories =
            config.macFactories.filter { it.name in allowedMacs }
        config.keyAlgorithms =
            config.keyAlgorithms.filter { it.name in allowedHostKeyAlgorithms }

        check(config.keyExchangeFactories.isNotEmpty()) { "no secure SSH key exchange available" }
        check(config.cipherFactories.isNotEmpty()) { "no secure SSH cipher available" }
        check(config.macFactories.isNotEmpty()) { "no secure SSH MAC available" }
        check(config.keyAlgorithms.isNotEmpty()) { "no secure SSH host key algorithm available" }
    }
}
