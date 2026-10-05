import Foundation
import Network
import OmoKit

/// Device loopback only: usbmux connects here, not Wi-Fi or Bluetooth peers.
@MainActor final class USBListener: BridgeTransport {
    var onMessage: ((BridgeMessage) -> Void)?
    var onDisconnect: ((Error?) -> Void)?
    private var listener: NWListener?
    private var connection: NWConnection?
    private var codec = FrameCodec()
    private var heartbeat: Timer?
    private var lastHeard = ProcessInfo.processInfo.systemUptime
    private var lastPing = ProcessInfo.processInfo.systemUptime

    func start() throws {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        // One dual-stack listener, restricted to lo0. Separate IPv4/IPv6
        // listeners conflict because Network.framework reserves a dual-stack port.
        parameters.requiredInterfaceType = .loopback
        let newListener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: 47101)!)
        newListener.newConnectionHandler = { [weak self, weak newListener] connection in
            Task { @MainActor [weak self, weak newListener] in
                guard let self, let newListener, self.listener === newListener else { connection.cancel(); return }
                self.accept(connection)
            }
        }
        newListener.stateUpdateHandler = { [weak self, weak newListener] state in
            if case .failed(let error) = state {
                Task { @MainActor [weak self, weak newListener] in
                    guard let self, let newListener, self.listener === newListener else { return }
                    self.stop(); self.onDisconnect?(error)
                }
            }
        }
        listener = newListener
        newListener.start(queue: .main)
    }
    func stop() {
        let old = listener
        listener = nil
        old?.cancel()
        close(nil)
    }
    private func accept(_ newConnection: NWConnection) {
        // Replacing a Mac stream also rejects its outstanding RPC continuations.
        close(nil)
        connection = newConnection
        codec = FrameCodec()
        lastHeard = ProcessInfo.processInfo.systemUptime
        lastPing = lastHeard
        newConnection.stateUpdateHandler = { [weak self, weak newConnection] state in
            Task { @MainActor [weak self, weak newConnection] in
                guard let self, let newConnection, self.connection === newConnection else { return }
                switch state {
                case .ready:
                    self.receive(newConnection)
                    self.heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                        Task { @MainActor [weak self] in await self?.tick() }
                    }
                case .failed(let error): self.close(error)
                case .cancelled: self.close(nil)
                default: break
                }
            }
        }
        newConnection.start(queue: .main)
    }
    private func receive(_ source: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak source] data, _, complete, error in
            Task { @MainActor [weak self, weak source] in
                guard let self, let source, self.connection === source else { return }
                do {
                    if let data, !data.isEmpty {
                        self.lastHeard = ProcessInfo.processInfo.systemUptime
                        for message in try self.codec.append(data) {
                            guard self.connection === source else { return }
                            if case .ping(let t) = message { try await self.send(.pong(t)) }
                            else { self.onMessage?(message) }
                        }
                    }
                    guard self.connection === source else { return }
                    if let error { self.close(error) }
                    else if complete { self.close(nil) }
                    else { self.receive(source) }
                } catch { if self.connection === source { self.close(error) } }
            }
        }
    }
    func send(_ message: BridgeMessage) async throws {
        guard let target = connection else { throw RPCClient.Failure.disconnected }
        let data = try FrameCodec.encode(message)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            target.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            })
        }
    }
    private func tick() async {
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastHeard >= 30 { close(RPCClient.Failure.timeout); return }
        guard now - lastPing >= 10 else { return }
        lastPing = now
        let source = connection
        do { try await send(.ping(Date().timeIntervalSince1970 * 1000)) }
        catch { if connection === source { close(error) } }
    }
    private func close(_ error: Error?) {
        heartbeat?.invalidate(); heartbeat = nil
        let old = connection
        connection = nil
        old?.cancel()
        codec = FrameCodec()
        if old != nil || error != nil { onDisconnect?(error) }
    }
}
