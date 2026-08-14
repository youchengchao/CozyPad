import Citadel
import Foundation
import NIOCore
import NIOSSH

final class TerminalSession: @unchecked Sendable {
    let id: String

    private let client: SSHClient
    private let cwd: String
    private let cols: Int
    private let rows: Int
    private let output: @Sendable (Data) -> Void
    private let closed: @Sendable (Error?) -> Void
    private let lock = NSLock()
    private var writer: TTYStdinWriter?
    private var task: Task<Void, Never>?
    private var ready: CheckedContinuation<Void, Error>?
    private var initializationStarted = false
    private var didClose = false

    init(
        id: String,
        client: SSHClient,
        cwd: String,
        cols: Int,
        rows: Int,
        output: @escaping @Sendable (Data) -> Void,
        closed: @escaping @Sendable (Error?) -> Void
    ) {
        self.id = id
        self.client = client
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.output = output
        self.closed = closed
    }

    func start() async throws {
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let request = SSHChannelRequestEvent.PseudoTerminalRequest(
                    wantReply: true,
                    term: "xterm-256color",
                    terminalCharacterWidth: cols,
                    terminalRowHeight: rows,
                    terminalPixelWidth: 0,
                    terminalPixelHeight: 0,
                    terminalModes: SSHTerminalModes()
                )
                try await client.withPTY(request) { inbound, outbound in
                    self.setWriter(outbound)
                    for try await item in inbound {
                        switch item {
                        case .stdout(let buffer), .stderr(let buffer):
                            self.output(Data(buffer.readableBytesView))
                        }
                    }
                }
                self.failReady(TerminalError.closedBeforeReady)
                self.finish(nil)
            } catch {
                self.failReady(error)
                self.finish(error)
            }
        }

        try await withCheckedThrowingContinuation { continuation in
            let writerToInitialize = lock.withLock { () -> TTYStdinWriter? in
                if didClose {
                    continuation.resume(throwing: TerminalError.closedBeforeReady)
                    return nil
                }
                ready = continuation
                guard let writer, !initializationStarted else { return nil }
                initializationStarted = true
                return writer
            }
            if let writerToInitialize { initialize(writerToInitialize) }
        }
    }

    func write(_ data: Data) async throws {
        guard let writer = lock.withLock({ self.writer }) else {
            throw TerminalError.notReady
        }
        try await writer.write(ByteBuffer(bytes: data))
    }

    func resize(cols: Int, rows: Int) async throws {
        guard let writer = lock.withLock({ self.writer }) else { return }
        try await writer.changeSize(cols: cols, rows: rows, pixelWidth: 0, pixelHeight: 0)
    }

    func close() {
        let state = lock.withLock { () -> (TTYStdinWriter?, Task<Void, Never>?) in
            (writer, task)
        }
        if let writer = state.0 {
            Task { try? await writer.write(ByteBuffer(bytes: [UInt8(4)])) }
        }
        state.1?.cancel()
        failReady(TerminalError.closedBeforeReady)
        finish(nil)
    }

    private func setWriter(_ writer: TTYStdinWriter) {
        let shouldInitialize = lock.withLock { () -> Bool in
            self.writer = writer
            guard ready != nil, !initializationStarted else { return false }
            initializationStarted = true
            return true
        }
        if shouldInitialize { initialize(writer) }
    }

    private func initialize(_ writer: TTYStdinWriter) {
        Task {
            do {
                let command: String
                if cwd == "~" {
                    command = "cd -- \"$HOME\" || exit 1"
                } else if cwd.hasPrefix("~/") {
                    let remainder = String(cwd.dropFirst(2))
                    let quoted = "'" + remainder.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
                    command = "cd -- \"$HOME\"/\(quoted) || exit 1"
                } else {
                    let quoted = "'" + cwd.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
                    command = "cd -- \(quoted) || exit 1"
                }
                try await writer.write(ByteBuffer(bytes: "\(command)\n".utf8))
                resolveReady()
            } catch {
                failReady(error)
                task?.cancel()
                finish(error)
            }
        }
    }

    private func resolveReady() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            let continuation = ready
            ready = nil
            return continuation
        }
        continuation?.resume()
    }

    private func failReady(_ error: Error) {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            let continuation = ready
            ready = nil
            return continuation
        }
        continuation?.resume(throwing: error)
    }

    private func finish(_ error: Error?) {
        let shouldEmit = lock.withLock { () -> Bool in
            guard !didClose else { return false }
            didClose = true
            writer = nil
            return true
        }
        if shouldEmit { closed(error) }
    }
}

enum TerminalError: Error, LocalizedError {
    case notReady
    case closedBeforeReady

    var errorDescription: String? {
        switch self {
        case .notReady: return "terminal is not ready"
        case .closedBeforeReady: return "terminal closed before it was ready"
        }
    }
}
