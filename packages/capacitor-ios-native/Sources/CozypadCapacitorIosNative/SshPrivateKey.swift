import Citadel
import Crypto
import Foundation
import NIOCore
import NIOSSH
import Security

enum PrivateKeyLoader {
    static func authentication(username: String, privateKey: String, passphrase: String?) throws -> SSHAuthenticationMethod {
        if privateKey.contains("BEGIN OPENSSH PRIVATE KEY") {
            let decryptionKey = passphrase?.data(using: .utf8)
            switch try SSHKeyDetection.detectPrivateKeyType(from: privateKey) {
            case .ed25519:
                let key = try Curve25519.Signing.PrivateKey(
                    sshEd25519: privateKey,
                    decryptionKey: decryptionKey
                )
                return .ed25519(username: username, privateKey: key)
            case .rsa:
                let key = try Insecure.RSA.PrivateKey(
                    sshRsa: privateKey,
                    decryptionKey: decryptionKey
                )
                return .rsa(username: username, privateKey: key)
            default:
                throw PrivateKeyError.unsupportedFormat
            }
        }

        guard passphrase?.isEmpty != false else {
            throw PrivateKeyError.encryptedPEMUnsupported
        }
        let key = try SecurityRSAPrivateKey(pem: privateKey)
        return .custom(SecurityRSAAuthenticationDelegate(username: username, key: key))
    }
}

enum PrivateKeyError: Error, LocalizedError {
    case invalidPEM
    case unsupportedFormat
    case encryptedPEMUnsupported
    case security(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidPEM: return "The SSH private key is invalid"
        case .unsupportedFormat: return "The SSH private-key type is not supported"
        case .encryptedPEMUnsupported:
            return "Encrypted PKCS PEM keys are not supported; use an encrypted OpenSSH key"
        case .security(let status):
            return SecCopyErrorMessageString(status, nil) as String? ?? "Security framework error \(status)"
        }
    }
}

private final class SecurityRSAAuthenticationDelegate: NIOSSHClientUserAuthenticationDelegate {
    private let username: String
    private let key: SecurityRSAPrivateKey
    private var offered = false

    init(username: String, key: SecurityRSAPrivateKey) {
        self.username = username
        self.key = key
    }

    func nextAuthenticationType(
        availableMethods: NIOSSHAvailableUserAuthenticationMethods,
        nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
    ) {
        guard !offered, availableMethods.contains(.publicKey) else {
            nextChallengePromise.succeed(nil)
            return
        }
        offered = true
        let offer = NIOSSHUserAuthenticationOffer.Offer.privateKey(
            .init(privateKey: NIOSSHPrivateKey(custom: key))
        )
        nextChallengePromise.succeed(
            NIOSSHUserAuthenticationOffer(username: username, serviceName: "", offer: offer)
        )
    }
}

private final class SecurityRSAPrivateKey: NIOSSHPrivateKeyProtocol {
    static let keyPrefix = "ssh-rsa"

    let privateKey: SecKey
    let rsaPublicKey: SecurityRSAPublicKey
    var publicKey: NIOSSHPublicKeyProtocol { rsaPublicKey }

    init(pem: String) throws {
        let document = try PEMDocument(pem)
        let pkcs1: Data
        switch document.label {
        case "RSA PRIVATE KEY":
            pkcs1 = document.der
        case "PRIVATE KEY":
            pkcs1 = try ASN1.pkcs8PrivateKey(document.der)
        default:
            throw PrivateKeyError.unsupportedFormat
        }

        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(pkcs1 as CFData, attributes as CFDictionary, &error) else {
            if let error { throw error.takeRetainedValue() }
            throw PrivateKeyError.invalidPEM
        }
        guard let publicKey = SecKeyCopyPublicKey(key),
              let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            if let error { throw error.takeRetainedValue() }
            throw PrivateKeyError.invalidPEM
        }
        let components = try ASN1.rsaPublicComponents(data)
        self.privateKey = key
        self.rsaPublicKey = SecurityRSAPublicKey(modulus: components.modulus, exponent: components.exponent)
    }

    func signature<D: DataProtocol>(for data: D) throws -> NIOSSHSignatureProtocol {
        var error: Unmanaged<CFError>?
        let message = Data(data)
        guard let signature = SecKeyCreateSignature(
            privateKey,
            .rsaSignatureMessagePKCS1v15SHA1,
            message as CFData,
            &error
        ) as Data? else {
            if let error { throw error.takeRetainedValue() }
            throw PrivateKeyError.invalidPEM
        }
        return SecurityRSASignature(rawRepresentation: signature)
    }
}

private struct SecurityRSAPublicKey: NIOSSHPublicKeyProtocol {
    static let publicKeyPrefix = "ssh-rsa"
    let modulus: Data
    let exponent: Data

    var rawRepresentation: Data {
        var buffer = ByteBuffer()
        write(to: &buffer)
        return Data(buffer.readableBytesView)
    }

    func isValidSignature<D: DataProtocol>(_ signature: NIOSSHSignatureProtocol, for data: D) -> Bool {
        false
    }

    @discardableResult
    func write(to buffer: inout ByteBuffer) -> Int {
        writeMPInt(exponent, to: &buffer) + writeMPInt(modulus, to: &buffer)
    }

    static func read(from buffer: inout ByteBuffer) throws -> SecurityRSAPublicKey {
        guard let exponent = readSSHData(from: &buffer), let modulus = readSSHData(from: &buffer) else {
            throw PrivateKeyError.invalidPEM
        }
        return SecurityRSAPublicKey(modulus: modulus, exponent: exponent)
    }
}

private struct SecurityRSASignature: NIOSSHSignatureProtocol {
    static let signaturePrefix = "ssh-rsa"
    let rawRepresentation: Data

    @discardableResult
    func write(to buffer: inout ByteBuffer) -> Int {
        buffer.writeInteger(UInt32(rawRepresentation.count)) + buffer.writeBytes(rawRepresentation)
    }

    static func read(from buffer: inout ByteBuffer) throws -> SecurityRSASignature {
        guard let data = readSSHData(from: &buffer) else { throw PrivateKeyError.invalidPEM }
        return SecurityRSASignature(rawRepresentation: data)
    }
}

private struct PEMDocument {
    let label: String
    let der: Data

    init(_ pem: String) throws {
        let normalized = pem.replacingOccurrences(of: "\r", with: "")
        guard let firstLine = normalized.split(separator: "\n").first,
              firstLine.hasPrefix("-----BEGIN "), firstLine.hasSuffix("-----") else {
            throw PrivateKeyError.invalidPEM
        }
        let label = firstLine.dropFirst("-----BEGIN ".count).dropLast(5)
        let end = "-----END \(label)-----"
        let body = normalized.split(separator: "\n")
            .dropFirst()
            .prefix { $0 != Substring(end) }
            .filter { !$0.contains(":") }
            .joined()
        guard !body.isEmpty, let der = Data(base64Encoded: body) else {
            throw PrivateKeyError.invalidPEM
        }
        self.label = String(label)
        self.der = der
    }
}

private enum ASN1 {
    static func pkcs8PrivateKey(_ data: Data) throws -> Data {
        var reader = Reader(data)
        var sequence = try reader.readConstructed(tag: 0x30)
        _ = try sequence.readValue(tag: 0x02)
        _ = try sequence.readConstructed(tag: 0x30)
        return try sequence.readValue(tag: 0x04)
    }

    static func rsaPublicComponents(_ data: Data) throws -> (modulus: Data, exponent: Data) {
        var reader = Reader(data)
        var sequence = try reader.readConstructed(tag: 0x30)
        return (trimInteger(try sequence.readValue(tag: 0x02)), trimInteger(try sequence.readValue(tag: 0x02)))
    }

    private static func trimInteger(_ data: Data) -> Data {
        var bytes = Array(data)
        while bytes.count > 1 && bytes.first == 0 { bytes.removeFirst() }
        return Data(bytes)
    }

    private struct Reader {
        let data: Data
        var offset = 0

        init(_ data: Data) { self.data = data }

        mutating func readConstructed(tag: UInt8) throws -> Reader {
            Reader(try readValue(tag: tag))
        }

        mutating func readValue(tag: UInt8) throws -> Data {
            guard offset < data.count, data[offset] == tag else { throw PrivateKeyError.invalidPEM }
            offset += 1
            let length = try readLength()
            guard length >= 0, offset + length <= data.count else { throw PrivateKeyError.invalidPEM }
            defer { offset += length }
            return data.subdata(in: offset..<(offset + length))
        }

        mutating func readLength() throws -> Int {
            guard offset < data.count else { throw PrivateKeyError.invalidPEM }
            let first = Int(data[offset])
            offset += 1
            if first & 0x80 == 0 { return first }
            let count = first & 0x7f
            guard count > 0, count <= 4, offset + count <= data.count else {
                throw PrivateKeyError.invalidPEM
            }
            var result = 0
            for _ in 0..<count {
                result = (result << 8) | Int(data[offset])
                offset += 1
            }
            return result
        }
    }
}

private func writeMPInt(_ data: Data, to buffer: inout ByteBuffer) -> Int {
    var bytes = Array(data.drop(while: { $0 == 0 }))
    if bytes.first.map({ $0 & 0x80 != 0 }) == true { bytes.insert(0, at: 0) }
    return buffer.writeInteger(UInt32(bytes.count)) + buffer.writeBytes(bytes)
}

private func readSSHData(from buffer: inout ByteBuffer) -> Data? {
    guard let length = buffer.readInteger(as: UInt32.self),
          let bytes = buffer.readBytes(length: Int(length)) else { return nil }
    return Data(bytes)
}
