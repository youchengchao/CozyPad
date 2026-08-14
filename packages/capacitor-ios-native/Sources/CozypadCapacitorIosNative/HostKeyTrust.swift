import Crypto
import Foundation
import NIOCore
import NIOSSH

final class HostKeyTrustDelegate: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    struct Prompt {
        let requestId: String
        let host: String
        let port: Int
        let fingerprint: String
        let promise: EventLoopPromise<Void>
    }

    private let host: String
    private let port: Int
    private let keychain: KeychainStore
    private let emit: @Sendable ([String: Any]) -> Void
    private let lock = NSLock()
    private var pending: [String: Prompt] = [:]

    init(host: String, port: Int, keychain: KeychainStore, emit: @escaping @Sendable ([String: Any]) -> Void) {
        self.host = host
        self.port = port
        self.keychain = keychain
        self.emit = emit
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let openSSH = String(openSSHPublicKey: hostKey)
        let fingerprint = Self.fingerprint(openSSH)
        let known = try? keychain.string(for: storageKey)
        if known == fingerprint {
            validationCompletePromise.succeed(())
            return
        }

        let requestId = "hk-\(UUID().uuidString)"
        let prompt = Prompt(
            requestId: requestId,
            host: host,
            port: port,
            fingerprint: fingerprint,
            promise: validationCompletePromise
        )
        lock.withLock { pending[requestId] = prompt }
        emit([
            "requestId": requestId,
            "host": host,
            "port": port,
            "keyType": openSSH.split(separator: " ").first.map(String.init) ?? "unknown",
            "fingerprintSha256": fingerprint,
            "status": known == nil ? "new" : "changed",
            "previousFingerprint": known ?? ""
        ])

        validationCompletePromise.futureResult.eventLoop.scheduleTask(in: .seconds(180)) { [weak self] in
            self?.rejectIfPending(requestId)
        }
    }

    func respond(requestId: String, accept: Bool) throws {
        guard let prompt = lock.withLock({ pending.removeValue(forKey: requestId) }) else { return }
        if accept {
            do {
                try keychain.set(prompt.fingerprint, for: storageKey)
                prompt.promise.succeed(())
            } catch {
                prompt.promise.fail(error)
                throw error
            }
        } else {
            prompt.promise.fail(HostKeyRejected())
        }
    }

    func cancelAll() {
        let prompts = lock.withLock {
            let values = Array(pending.values)
            pending.removeAll()
            return values
        }
        prompts.forEach { $0.promise.fail(HostKeyRejected()) }
    }

    private func rejectIfPending(_ requestId: String) {
        guard let prompt = lock.withLock({ pending.removeValue(forKey: requestId) }) else { return }
        prompt.promise.fail(HostKeyRejected())
    }

    private var storageKey: String { "known-host:\(host):\(port)" }

    static func fingerprint(_ openSSH: String) -> String {
        let component = openSSH.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        let blob = Data(base64Encoded: component) ?? Data(openSSH.utf8)
        let digest = SHA256.hash(data: blob)
        return "SHA256:" + Data(digest).base64EncodedString().trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}

struct HostKeyRejected: Error, LocalizedError {
    var errorDescription: String? { "SSH host key was not trusted" }
}
