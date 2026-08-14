import Foundation

struct SshTarget: Codable, Equatable, Sendable {
    let host: String
    let port: Int
    let username: String
}

struct SshCredential: Codable, Equatable, Sendable {
    let target: SshTarget
    let authMethod: String
    let password: String?
    let privateKey: String?
    let passphrase: String?
}

struct SshCredentialStatus {
    let hasCredential: Bool
    let persisted: Bool
}

final class SshCredentialVault: @unchecked Sendable {
    private let keychain: KeychainStore
    private let lock = NSLock()
    private var transient: [String: SshCredential] = [:]

    init(keychain: KeychainStore) {
        self.keychain = keychain
    }

    func configure(
        profileId: String,
        target: SshTarget,
        authMethod: String,
        remember: Bool,
        supplied: SshCredential?
    ) throws -> SshCredentialStatus {
        try validate(profileId: profileId, target: target, authMethod: authMethod)
        return try lock.withLock {
            if let supplied {
                guard supplied.target == target, supplied.authMethod == authMethod else {
                    throw VaultError.invalidCredential
                }
                if remember {
                    try persist(supplied, profileId: profileId)
                    transient.removeValue(forKey: profileId)
                } else {
                    try keychain.remove(storageKey(profileId))
                    transient[profileId] = supplied
                }
                return SshCredentialStatus(hasCredential: true, persisted: remember)
            }

            if let existing = transient[profileId] {
                guard existing.target == target, existing.authMethod == authMethod else {
                    try removeLocked(profileId)
                    return SshCredentialStatus(hasCredential: false, persisted: false)
                }
                if remember {
                    try persist(existing, profileId: profileId)
                    transient.removeValue(forKey: profileId)
                    return SshCredentialStatus(hasCredential: true, persisted: true)
                }
                return SshCredentialStatus(hasCredential: true, persisted: false)
            }

            guard let existing = try persisted(profileId) else {
                return SshCredentialStatus(hasCredential: false, persisted: false)
            }
            guard existing.target == target, existing.authMethod == authMethod, remember else {
                try removeLocked(profileId)
                return SshCredentialStatus(hasCredential: false, persisted: false)
            }
            return SshCredentialStatus(hasCredential: true, persisted: true)
        }
    }

    func credential(profileId: String, target: SshTarget, authMethod: String) throws -> SshCredential? {
        try validate(profileId: profileId, target: target, authMethod: authMethod)
        return try lock.withLock {
            let value = transient[profileId] ?? (try persisted(profileId))
            guard value?.target == target, value?.authMethod == authMethod else { return nil }
            return value
        }
    }

    func status(profileId: String, target: SshTarget, authMethod: String) throws -> SshCredentialStatus {
        try validate(profileId: profileId, target: target, authMethod: authMethod)
        return try lock.withLock {
            if let value = transient[profileId], value.target == target, value.authMethod == authMethod {
                return SshCredentialStatus(hasCredential: true, persisted: false)
            }
            if let value = try persisted(profileId), value.target == target, value.authMethod == authMethod {
                return SshCredentialStatus(hasCredential: true, persisted: true)
            }
            return SshCredentialStatus(hasCredential: false, persisted: false)
        }
    }

    func remove(_ profileId: String) throws {
        try lock.withLock { try removeLocked(profileId) }
    }

    private func validate(profileId: String, target: SshTarget, authMethod: String) throws {
        guard !profileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              profileId.count <= 256 else { throw VaultError.invalidProfile }
        guard !target.host.isEmpty, target.host.count <= 255,
              (1...65_535).contains(target.port),
              !target.username.isEmpty, target.username.count <= 256 else {
            throw VaultError.invalidTarget
        }
        guard authMethod == "password" || authMethod == "privateKey" else {
            throw VaultError.unsupportedAuthentication
        }
    }

    private func persisted(_ profileId: String) throws -> SshCredential? {
        guard let data = try keychain.data(for: storageKey(profileId)) else { return nil }
        do {
            return try JSONDecoder().decode(SshCredential.self, from: data)
        } catch {
            try keychain.remove(storageKey(profileId))
            return nil
        }
    }

    private func persist(_ credential: SshCredential, profileId: String) throws {
        try keychain.set(JSONEncoder().encode(credential), for: storageKey(profileId))
    }

    private func removeLocked(_ profileId: String) throws {
        transient.removeValue(forKey: profileId)
        try keychain.remove(storageKey(profileId))
    }

    private func storageKey(_ profileId: String) -> String { "ssh-credential:\(profileId)" }
}

enum VaultError: Error, LocalizedError {
    case invalidProfile
    case invalidTarget
    case invalidCredential
    case unsupportedAuthentication

    var errorDescription: String? {
        switch self {
        case .invalidProfile: return "invalid profileId"
        case .invalidTarget: return "invalid SSH target"
        case .invalidCredential: return "credential does not match its SSH profile"
        case .unsupportedAuthentication: return "unsupported authentication method"
        }
    }
}
