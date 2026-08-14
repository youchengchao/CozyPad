import Capacitor
import Citadel
import Foundation
import NIOCore

@objc(CozyPadSshPlugin)
public final class CozyPadSshPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CozyPadSshPlugin"
    public let jsName = "CozyPadSsh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configureCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openTerminal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeTerminal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resizeTerminal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeTerminal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respondHostKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBackgroundMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBackgroundMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAgentBridge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAgentBridge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "agentRequest", returnType: CAPPluginReturnPromise)
    ]

    private let keychain = KeychainStore()
    private lazy var credentialVault = SshCredentialVault(keychain: keychain)
    private let stateLock = NSLock()
    private var client: SSHClient?
    private var hostKeyTrust: HostKeyTrustDelegate?
    private var terminals: [String: TerminalSession] = [:]
    private var agentBridge: AgentBridge?
    private var connectionGeneration = 0

    @objc func configureCredential(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"),
              let target = readTarget(call) else { return }
        let authMethod = call.getString("authMethod") ?? "password"
        let remember = call.getBool("rememberCredential") ?? true
        let supplied: SshCredential?
        if authMethod == "password", let password = call.getString("password"), !password.isEmpty {
            supplied = SshCredential(
                target: target,
                authMethod: authMethod,
                password: password,
                privateKey: nil,
                passphrase: nil
            )
        } else if authMethod == "privateKey",
                  let privateKey = call.getString("privateKey"),
                  !privateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            supplied = SshCredential(
                target: target,
                authMethod: authMethod,
                password: nil,
                privateKey: privateKey,
                passphrase: call.getString("passphrase").flatMap { $0.isEmpty ? nil : $0 }
            )
        } else {
            supplied = nil
        }

        do {
            let status = try credentialVault.configure(
                profileId: profileId,
                target: target,
                authMethod: authMethod,
                remember: remember,
                supplied: supplied
            )
            call.resolve(statusObject(status))
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func hasCredential(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"),
              let target = readTarget(call) else { return }
        do {
            call.resolve(statusObject(try credentialVault.status(
                profileId: profileId,
                target: target,
                authMethod: call.getString("authMethod") ?? "password"
            )))
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func deleteCredential(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else {
            return call.reject("profileId is required")
        }
        do {
            try credentialVault.remove(profileId)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"),
              let target = readTarget(call) else { return }
        let authMethod = call.getString("authMethod") ?? "password"
        let credential: SshCredential
        do {
            guard let stored = try credentialVault.credential(
                profileId: profileId,
                target: target,
                authMethod: authMethod
            ) else {
                return call.reject(authMethod == "privateKey" ? "SSH private key is required" : "SSH password is required")
            }
            credential = stored
        } catch {
            return call.reject(error.localizedDescription)
        }

        let generation = stateLock.withLock { () -> Int in
            connectionGeneration += 1
            hostKeyTrust?.cancelAll()
            return connectionGeneration
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let authentication: SSHAuthenticationMethod
                if authMethod == "privateKey" {
                    guard let privateKey = credential.privateKey else {
                        throw ConnectionError.missingPrivateKey
                    }
                    authentication = try PrivateKeyLoader.authentication(
                        username: target.username,
                        privateKey: privateKey,
                        passphrase: credential.passphrase
                    )
                } else {
                    guard let password = credential.password else {
                        throw ConnectionError.missingPassword
                    }
                    authentication = .passwordBased(username: target.username, password: password)
                }

                let trust = HostKeyTrustDelegate(
                    host: target.host,
                    port: target.port,
                    keychain: keychain
                ) { [weak self] payload in
                    self?.emit("hostKeyPrompt", payload)
                }
                var settings = SSHClientSettings(
                    host: target.host,
                    port: target.port,
                    authenticationMethod: { authentication },
                    hostKeyValidator: .custom(trust)
                )
                settings.connectTimeout = .seconds(15)
                let connected = try await SSHClient.connect(to: settings)

                let installed = stateLock.withLock { () -> Bool in
                    guard connectionGeneration == generation else { return false }
                    client = connected
                    hostKeyTrust = trust
                    return true
                }
                guard installed else {
                    try? await connected.close()
                    throw ConnectionError.superseded
                }
                connected.onDisconnect { [weak self, weak connected] in
                    guard let self, let connected else { return }
                    self.markDisconnected(connected)
                }
                emit("connectionState", ["state": "connected"])
                call.resolve()
            } catch {
                let isCurrent = stateLock.withLock { connectionGeneration == generation }
                if isCurrent {
                    emit("connectionState", ["state": "error", "error": error.localizedDescription])
                }
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        let state = clearConnection()
        state.terminals.forEach { $0.close() }
        state.agent?.stop()
        state.trust?.cancelAll()
        Task {
            try? await state.client?.close()
            emit("connectionState", ["state": "disconnected"])
            call.resolve()
        }
    }

    @objc func respondHostKey(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            return call.reject("requestId is required")
        }
        do {
            try stateLock.withLock { hostKeyTrust }?.respond(
                requestId: requestId,
                accept: call.getBool("accept") ?? false
            )
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func exec(_ call: CAPPluginCall) {
        guard let command = call.getString("command") else { return call.reject("command is required") }
        guard let ssh = stateLock.withLock({ client }), ssh.isConnected else {
            return call.reject("not connected")
        }
        let timeoutMs = call.getInt("timeoutMs") ?? 15_000
        let streamId = call.getString("streamId")
        Task { [weak self] in
            guard let self else { return }
            do {
                let output = try await withTimeout(milliseconds: timeoutMs) {
                    try await self.execute(ssh, command: command, streamId: streamId)
                }
                call.resolve(["output": output])
            } catch is CommandTimeout {
                call.reject("remote command timed out after \(timeoutMs)ms")
            } catch {
                if !ssh.isConnected { markDisconnected(ssh, error: error.localizedDescription) }
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func openTerminal(_ call: CAPPluginCall) {
        guard let ssh = stateLock.withLock({ client }), ssh.isConnected else {
            return call.reject("not connected")
        }
        guard let cwd = call.getString("cwd"), !cwd.isEmpty else {
            return call.reject("cwd is required")
        }
        let terminalId = "mobile-term-\(UUID().uuidString)"
        let session = TerminalSession(
            id: terminalId,
            client: ssh,
            cwd: cwd,
            cols: call.getInt("cols") ?? 80,
            rows: call.getInt("rows") ?? 24,
            output: { [weak self] data in
                self?.emit("terminalOutput", [
                    "terminalId": terminalId,
                    "dataBase64": data.base64EncodedString()
                ])
            },
            closed: { [weak self] _ in
                self?.removeTerminal(terminalId)
                self?.emit("terminalClosed", ["terminalId": terminalId])
            }
        )
        stateLock.withLock { terminals[terminalId] = session }
        Task {
            do {
                try await session.start()
                call.resolve(["terminalId": terminalId])
            } catch {
                removeTerminal(terminalId)
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func writeTerminal(_ call: CAPPluginCall) {
        guard let terminalId = call.getString("terminalId") else {
            return call.reject("terminalId is required")
        }
        guard let encoded = call.getString("dataBase64"), let data = Data(base64Encoded: encoded) else {
            return call.reject("dataBase64 is invalid")
        }
        guard let session = stateLock.withLock({ terminals[terminalId] }) else {
            return call.reject("unknown terminal")
        }
        Task {
            do {
                try await session.write(data)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func resizeTerminal(_ call: CAPPluginCall) {
        guard let terminalId = call.getString("terminalId") else {
            return call.reject("terminalId is required")
        }
        guard let session = stateLock.withLock({ terminals[terminalId] }) else {
            return call.resolve()
        }
        Task {
            try? await session.resize(cols: call.getInt("cols") ?? 80, rows: call.getInt("rows") ?? 24)
            call.resolve()
        }
    }

    @objc func closeTerminal(_ call: CAPPluginCall) {
        guard let terminalId = call.getString("terminalId") else {
            return call.reject("terminalId is required")
        }
        let session = stateLock.withLock { terminals.removeValue(forKey: terminalId) }
        session?.close()
        call.resolve()
    }

    @objc func startAgentBridge(_ call: CAPPluginCall) {
        guard let ssh = stateLock.withLock({ client }), ssh.isConnected else {
            return call.reject("not connected")
        }
        guard let profileId = call.getString("profileId"),
              let host = call.getString("host"),
              let username = call.getString("username") else {
            return call.reject("profileId, host, and username are required")
        }
        let port = call.getInt("port") ?? 22
        let fingerprint: String
        do {
            guard let stored = try keychain.string(for: "known-host:\(host):\(port)") else {
                return call.reject("trusted host fingerprint is unavailable")
            }
            fingerprint = stored
        } catch {
            return call.reject(error.localizedDescription)
        }
        let agent = AgentBridge(
            client: ssh,
            emitMessage: { [weak self] line in self?.emit("agentMessage", ["line": line]) },
            emitClosed: { [weak self] error in self?.emit("agentClosed", ["error": error]) }
        )
        stateLock.withLock {
            agentBridge?.stop()
            agentBridge = agent
        }
        Task {
            do {
                try await agent.start(configuration: AgentHostConfiguration(
                    profileId: profileId,
                    name: call.getString("name") ?? "Remote host",
                    host: host,
                    port: port,
                    username: username,
                    fingerprint: fingerprint
                ))
                call.resolve()
            } catch {
                stateLock.withLock {
                    if agentBridge === agent { agentBridge = nil }
                }
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func stopAgentBridge(_ call: CAPPluginCall) {
        let agent = stateLock.withLock { () -> AgentBridge? in
            let value = agentBridge
            agentBridge = nil
            return value
        }
        agent?.stop()
        call.resolve()
    }

    @objc func agentRequest(_ call: CAPPluginCall) {
        guard let line = call.getString("line") else { return call.reject("line is required") }
        guard let agent = stateLock.withLock({ agentBridge }) else {
            return call.reject("Agent bridge is not connected")
        }
        Task {
            do {
                try await agent.send(line)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func getBackgroundMode(_ call: CAPPluginCall) {
        call.resolve(["supported": false, "enabled": false])
    }

    @objc func setBackgroundMode(_ call: CAPPluginCall) {
        if call.getBool("enabled") == true {
            call.reject("iOS does not allow an indefinite Android-style foreground SSH service")
        } else {
            call.resolve()
        }
    }

    @objc func isConnected(_ call: CAPPluginCall) {
        call.resolve(["connected": stateLock.withLock { client?.isConnected == true }])
    }

    private func execute(_ ssh: SSHClient, command: String, streamId: String?) async throws -> String {
        var output = Data()
        var pendingLine = Data()
        do {
            let stream = try await ssh.executeCommandStream(command)
            for try await item in stream {
                guard case .stdout(let buffer) = item else { continue }
                let chunk = Data(buffer.readableBytesView)
                output.append(chunk)
                if let streamId {
                    pendingLine.append(chunk)
                    while let newline = pendingLine.firstIndex(of: 0x0a) {
                        let line = String(decoding: pendingLine[..<newline], as: UTF8.self)
                            .trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
                        pendingLine.removeSubrange(...newline)
                        emit("execLine", ["streamId": streamId, "line": line])
                    }
                }
            }
        } catch {
            if output.isEmpty { throw error }
        }
        if let streamId, !pendingLine.isEmpty {
            emit("execLine", ["streamId": streamId, "line": String(decoding: pendingLine, as: UTF8.self)])
        }
        return String(decoding: output, as: UTF8.self)
    }

    private func withTimeout<T>(milliseconds: Int, operation: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(milliseconds, 1)) * 1_000_000)
                throw CommandTimeout()
            }
            guard let result = try await group.next() else { throw CommandTimeout() }
            group.cancelAll()
            return result
        }
    }

    private func readTarget(_ call: CAPPluginCall) -> SshTarget? {
        guard let host = call.getString("host"),
              !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("host is required")
            return nil
        }
        let port = call.getInt("port") ?? 22
        guard (1...65_535).contains(port) else {
            call.reject("port must be between 1 and 65535")
            return nil
        }
        guard let username = call.getString("username"),
              !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("username is required")
            return nil
        }
        return SshTarget(host: host, port: port, username: username)
    }

    private func statusObject(_ status: SshCredentialStatus) -> [String: Any] {
        ["hasCredential": status.hasCredential, "credentialPersisted": status.persisted]
    }

    private func emit(_ event: String, _ payload: [String: Any]) {
        DispatchQueue.main.async { [weak self] in self?.notifyListeners(event, data: payload) }
    }

    private func markDisconnected(_ disconnected: SSHClient, error: String? = nil) {
        let shouldEmit = stateLock.withLock { () -> Bool in
            guard client === disconnected else { return false }
            client = nil
            return true
        }
        guard shouldEmit else { return }
        var payload: [String: Any] = ["state": "disconnected"]
        if let error { payload["error"] = error }
        emit("connectionState", payload)
    }

    private func removeTerminal(_ terminalId: String) {
        _ = stateLock.withLock { terminals.removeValue(forKey: terminalId) }
    }

    private func clearConnection() -> (
        client: SSHClient?,
        trust: HostKeyTrustDelegate?,
        terminals: [TerminalSession],
        agent: AgentBridge?
    ) {
        stateLock.withLock {
            connectionGeneration += 1
            let state = (client, hostKeyTrust, Array(terminals.values), agentBridge)
            client = nil
            hostKeyTrust = nil
            terminals.removeAll()
            agentBridge = nil
            return state
        }
    }
}

private struct CommandTimeout: Error {}

private enum ConnectionError: Error, LocalizedError {
    case missingPassword
    case missingPrivateKey
    case superseded

    var errorDescription: String? {
        switch self {
        case .missingPassword: return "SSH password is required"
        case .missingPrivateKey: return "SSH private key is required"
        case .superseded: return "SSH connection superseded"
        }
    }
}
