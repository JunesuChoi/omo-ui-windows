import Foundation

@MainActor public protocol BridgeTransport: AnyObject {
    var onMessage: ((BridgeMessage) -> Void)? { get set }
    var onDisconnect: ((Error?) -> Void)? { get set }
    func send(_ message: BridgeMessage) async throws
    func start() throws
    func stop()
}

@MainActor public final class RPCClient {
    public enum Failure: Error, LocalizedError {
        case disconnected, timeout, cancelled
        public var errorDescription: String? {
            switch self {
            case .disconnected: return "The USB bridge disconnected."
            case .timeout: return "The Mac did not answer in time."
            case .cancelled: return "The request was cancelled."
            }
        }
    }
    private struct Pending {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeout: Task<Void, Never>
    }
    private let transport: BridgeTransport
    private var nextID = 1
    private var pending: [Int: Pending] = [:]
    public var onEvent: ((BridgeMessage) -> Void)?
    public var onDisconnect: ((Error?) -> Void)?
    public var pendingCount: Int { pending.count }

    public init(transport: BridgeTransport) {
        self.transport = transport
        transport.onMessage = { [weak self] in self?.receive($0) }
        transport.onDisconnect = { [weak self] error in
            self?.disconnect()
            self?.onDisconnect?(error)
        }
    }
    public func call(_ method: String, params: JSONValue = .object([:]), timeoutNanoseconds: UInt64 = 30_000_000_000) async throws -> JSONValue {
        let id = nextID
        nextID += 1
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                enqueue(id: id, method: method, params: params, timeoutNanoseconds: timeoutNanoseconds, continuation: continuation)
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.finish(id, .failure(Failure.cancelled)) } })
    }
    private func enqueue(id: Int, method: String, params: JSONValue, timeoutNanoseconds: UInt64, continuation: CheckedContinuation<JSONValue, Error>) {
        let timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: timeoutNanoseconds) }
            catch { return }
            self?.finish(id, .failure(Failure.timeout))
        }
        pending[id] = Pending(continuation: continuation, timeout: timeout)
        Task { [weak self] in
            guard let self, self.pending[id] != nil else { return }
            do { try await self.transport.send(.rpc(id: id, method: method, params: params)) }
            catch { self.finish(id, .failure(error)) }
        }
    }
    public func disconnect() {
        for id in Array(pending.keys) { finish(id, .failure(Failure.disconnected)) }
    }
    private func finish(_ id: Int, _ result: Result<JSONValue, Error>) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timeout.cancel()
        entry.continuation.resume(with: result)
    }
    private func receive(_ message: BridgeMessage) {
        switch message {
        case let .rpcResult(id, result): finish(id, .success(result))
        case let .rpcError(id, error): finish(id, .failure(error))
        case .unknown: break
        default: onEvent?(message)
        }
    }
}
