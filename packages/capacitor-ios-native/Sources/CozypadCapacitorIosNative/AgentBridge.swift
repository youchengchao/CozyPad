import Citadel
import Foundation
import NIOCore

struct AgentHostConfiguration: Sendable {
    let profileId: String
    let name: String
    let host: String
    let port: Int
    let username: String
    let fingerprint: String
}

final class AgentBridge: @unchecked Sendable {
    private let client: SSHClient
    private let emitMessage: @Sendable (String) -> Void
    private let emitClosed: @Sendable (String) -> Void
    private let lock = NSLock()
    private var writer: TTYStdinWriter?
    private var task: Task<Void, Never>?
    private var ready: CheckedContinuation<Void, Error>?
    private var becameReady = false
    private var stopping = false

    init(
        client: SSHClient,
        emitMessage: @escaping @Sendable (String) -> Void,
        emitClosed: @escaping @Sendable (String) -> Void
    ) {
        self.client = client
        self.emitMessage = emitMessage
        self.emitClosed = emitClosed
    }

    func start(configuration: AgentHostConfiguration) async throws {
        let home = try await executeText("printf '%s' \"$HOME\"").trimmingCharacters(in: .whitespacesAndNewlines)
        guard home.hasPrefix("/"), home != "/" else {
            throw AgentBridgeError.unsafeHome
        }
        let directory = home.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let absoluteDirectory = "/\(directory)/.cozypad"
        let remotePath = "\(absoluteDirectory)/remote-agent-host.cjs"
        _ = try await executeText("mkdir -p -- \(shellQuote(absoluteDirectory))")
        try await uploadRunner(remotePath: remotePath)

        let json: [String: Any] = [
            "profileId": configuration.profileId,
            "name": configuration.name,
            "host": configuration.host,
            "port": configuration.port,
            "username": configuration.username,
            "fingerprint": configuration.fingerprint
        ]
        let encoded = try JSONSerialization.data(withJSONObject: json).base64EncodedString()
        let invocation = buildInvocation(home: home, remotePath: remotePath, encodedConfiguration: encoded)

        task = Task { [weak self] in
            guard let self else { return }
            var stdout = Data()
            var stderr = ""
            do {
                try await client.withExec(invocation) { inbound, outbound in
                    self.lock.withLock { self.writer = outbound }
                    for try await item in inbound {
                        switch item {
                        case .stdout(let buffer):
                            stdout.append(contentsOf: buffer.readableBytesView)
                            self.consumeLines(&stdout)
                        case .stderr(let buffer):
                            stderr += String(decoding: buffer.readableBytesView, as: UTF8.self)
                        }
                    }
                }
                self.failReady(AgentBridgeError.notConnected)
                self.close(error: stderr.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch {
                let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                self.failReady(error)
                self.close(error: detail.isEmpty ? error.localizedDescription : detail)
            }
        }

        try await withCheckedThrowingContinuation { continuation in
            let resumeImmediately = lock.withLock { () -> Bool in
                if becameReady { return true }
                ready = continuation
                return false
            }
            if resumeImmediately { continuation.resume() }
            DispatchQueue.global().asyncAfter(deadline: .now() + 20) { [weak self] in
                self?.timeoutReady()
            }
        }
    }

    func send(_ line: String) async throws {
        guard let writer = lock.withLock({ self.writer }), becameReady else {
            throw AgentBridgeError.notConnected
        }
        try await writer.write(ByteBuffer(string: line + "\n"))
    }

    func stop() {
        let state = lock.withLock { () -> (TTYStdinWriter?, Task<Void, Never>?) in
            stopping = true
            let state = (writer, task)
            writer = nil
            task = nil
            return state
        }
        if let writer = state.0 {
            Task { try? await writer.write(ByteBuffer(bytes: [UInt8(4)])) }
        }
        state.1?.cancel()
        failReady(AgentBridgeError.notConnected)
    }

    private func consumeLines(_ data: inout Data) {
        while let newline = data.firstIndex(of: 0x0a) {
            let lineData = data[..<newline]
            data.removeSubrange(...newline)
            let line = String(decoding: lineData, as: UTF8.self)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            guard !line.isEmpty else { continue }
            if let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
               object["type"] as? String == "ready" {
                markReady()
            } else {
                emitMessage(line)
            }
        }
    }

    private func markReady() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            becameReady = true
            let continuation = ready
            ready = nil
            return continuation
        }
        continuation?.resume()
    }

    private func timeoutReady() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            guard !becameReady else { return nil }
            let continuation = ready
            ready = nil
            return continuation
        }
        guard let continuation else { return }
        continuation.resume(throwing: AgentBridgeError.handshakeTimeout)
        task?.cancel()
    }

    private func failReady(_ error: Error) {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            let continuation = ready
            ready = nil
            return continuation
        }
        continuation?.resume(throwing: error)
    }

    private func close(error: String) {
        let shouldEmit = lock.withLock { () -> Bool in
            writer = nil
            return !stopping
        }
        if shouldEmit {
            emitClosed(error.isEmpty ? "Remote Agent bridge closed" : error)
        }
    }

    private func executeText(_ command: String) async throws -> String {
        let buffer = try await client.executeCommand(command, mergeStreams: true)
        return String(decoding: buffer.readableBytesView, as: UTF8.self)
    }

    private func uploadRunner(remotePath: String) async throws {
        guard let url = Bundle.module.url(forResource: "remote-agent-host", withExtension: "cjs") else {
            throw AgentBridgeError.missingRunner
        }
        let data = try Data(contentsOf: url)
        let sftp = try await client.openSFTP()
        defer { Task { try? await sftp.close() } }
        try await sftp.withFile(filePath: remotePath, flags: [.write, .create, .truncate]) { file in
            try await file.write(ByteBuffer(bytes: data))
        }
    }

    private func buildInvocation(home: String, remotePath: String, encodedConfiguration: String) -> String {
        """
        cozypad_login_shell="${SHELL:-}"
        if [ -z "$cozypad_login_shell" ] && command -v getent >/dev/null 2>&1; then
          cozypad_login_shell="$(getent passwd "$(id -u)" | cut -d: -f7)"
        fi
        if [ -z "$cozypad_login_shell" ]; then cozypad_login_shell=/bin/sh; fi
        cozypad_login_env="$("$cozypad_login_shell" -l -i -c env 2>/dev/null || true)"
        cozypad_login_path="$(printf '%s\n' "$cozypad_login_env" | sed -n 's/^PATH=//p' | tail -n 1)"
        if [ -z "$cozypad_login_path" ]; then cozypad_login_path="$PATH"; fi
        PATH="$cozypad_login_path"
        export PATH
        cozypad_node="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"
        if [ -z "$cozypad_node" ]; then echo "Node.js is required on the remote host" >&2; exit 127; fi
        exec env HOME=\(shellQuote(home)) PATH="$cozypad_login_path" "$cozypad_node" \(shellQuote(remotePath)) \(shellQuote(encodedConfiguration))
        """
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}

enum AgentBridgeError: Error, LocalizedError {
    case unsafeHome
    case missingRunner
    case handshakeTimeout
    case notConnected

    var errorDescription: String? {
        switch self {
        case .unsafeHome: return "Remote host did not provide a safe user home directory"
        case .missingRunner: return "The bundled remote Agent host is missing"
        case .handshakeTimeout: return "Remote Agent host did not answer its handshake"
        case .notConnected: return "Agent bridge is not connected"
        }
    }
}
