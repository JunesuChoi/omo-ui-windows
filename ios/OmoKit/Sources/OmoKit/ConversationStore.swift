import Foundation

public struct ConversationItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var type: String
    public var text: String
    public var status: String
    public init(id: String, type: String, text: String, status: String = "completed") {
        self.id = id; self.type = type; self.text = text; self.status = status
    }
    public init?(_ json: JSONValue) {
        guard let id = json["id"].string, let type = json["type"].string else { return nil }
        self.id = id; self.type = type; status = json["status"].string ?? "completed"
        switch type {
        case "userMessage": text = json["content"].array.filter { $0["type"].string == "text" }.compactMap { $0["text"].string }.joined(separator: "\n")
        case "agentMessage", "plan": text = json["text"].string ?? ""
        case "reasoning": text = json["summary"].array.compactMap(\.string).joined(separator: "\n")
        case "commandExecution": text = json["command"].string ?? type
        case "fileChange": text = json["changes"].array.compactMap { $0["path"].string }.joined(separator: "\n")
        case "dynamicToolCall", "mcpToolCall": text = json["tool"].string ?? type
        case "webSearch": text = json["query"].string ?? type
        default: text = type
        }
    }
}

public struct ConversationTurn: Identifiable, Equatable, Sendable {
    public var id: String
    public var status: String
    public var items: [ConversationItem]
    public init(id: String, status: String = "inProgress", items: [ConversationItem] = []) { self.id = id; self.status = status; self.items = items }
    public init?(_ json: JSONValue) {
        guard let id = json["id"].string, let status = json["status"].string else { return nil }
        self.init(id: id, status: status, items: json["items"].array.compactMap(ConversationItem.init))
    }
}

public struct ConversationThread: Identifiable, Equatable, Sendable {
    public var id: String
    public var cwd: String
    public var name: String?
    public var preview: String
    public var updatedAt: Double
    public var status: String
    public var activeFlags: [String]
    public var path: String?
    public var turns: [ConversationTurn]
    public var pendingMessages: [ConversationItem] = []
    public var title: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? (preview.isEmpty ? cwd : preview) }
    public var activeTurnID: String? { turns.last(where: { $0.status == "inProgress" })?.id }
    public var needsMacAttention: Bool { status == "active" && (activeFlags.contains("waitingOnApproval") || activeFlags.contains("waitingOnUserInput")) }
    public init?(_ json: JSONValue) {
        guard let id = json["id"].string, let cwd = json["cwd"].string,
              let preview = json["preview"].string, let updated = json["updatedAt"].number,
              let status = json["status"]["type"].string else { return nil }
        self.id = id; self.cwd = cwd; self.preview = preview; updatedAt = updated
        self.status = status; name = json["name"].string; path = json["path"].string
        activeFlags = json["status"]["activeFlags"].array.compactMap(\.string)
        turns = json["turns"].array.compactMap(ConversationTurn.init)
    }
}

public struct WorkspaceGroup: Identifiable {
    public var id: String { cwd }
    public let cwd: String
    public let threads: [ConversationThread]
}

public struct TurnRequest: Equatable {
    public let method: String
    public let params: JSONValue
}

public struct ConversationStore: Sendable {
    public private(set) var threads: [String: ConversationThread] = [:]
    private var seenUserItems: [String: Set<String>] = [:]
    public init() {}
    public var recentWorkspaces: [String] {
        var seen = Set<String>()
        return threads.values.sorted { $0.updatedAt > $1.updatedAt }.compactMap { seen.insert($0.cwd).inserted ? $0.cwd : nil }
    }
    public func groups(search: String = "") -> [WorkspaceGroup] {
        let filtered = threads.values.filter { search.isEmpty || "\($0.title) \($0.cwd)".localizedCaseInsensitiveContains(search) }
        return Dictionary(grouping: filtered, by: \.cwd).map { WorkspaceGroup(cwd: $0.key, threads: $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
            .sorted { ($0.threads.first?.updatedAt ?? 0) > ($1.threads.first?.updatedAt ?? 0) }
    }
    public mutating func mergeList(_ result: JSONValue) {
        for value in result["data"].array {
            guard var thread = ConversationThread(value) else { continue }
            if let old = threads[thread.id] { thread.turns = old.turns; thread.pendingMessages = old.pendingMessages }
            threads[thread.id] = thread
            if thread.status != "active" { settle(thread.id) }
        }
    }
    public mutating func load(_ value: JSONValue) {
        guard var thread = ConversationThread(value) else { return }
        thread.pendingMessages = threads[thread.id]?.pendingMessages ?? []
        // A resume response may omit turns. Do not erase history in that case.
        if case .null = value["turns"] { thread.turns = threads[thread.id]?.turns ?? [] }
        threads[thread.id] = thread
        for item in thread.turns.flatMap(\.items) { reconcileEcho(thread.id, item) }
        if thread.status != "active" { settle(thread.id) }
    }
    public func request(threadID: String, text: String) -> TurnRequest {
        var params: [String: JSONValue] = ["threadId": .string(threadID), "input": .array([.object(["type": .string("text"), "text": .string(text), "text_elements": .array([])])])]
        if let turn = threads[threadID]?.activeTurnID {
            params["expectedTurnId"] = .string(turn)
            return TurnRequest(method: "turn/steer", params: .object(params))
        }
        return TurnRequest(method: "turn/start", params: .object(params))
    }
    @discardableResult public mutating func echo(threadID: String, text: String) -> String {
        let id = "pending-" + UUID().uuidString
        threads[threadID]?.pendingMessages.append(.init(id: id, type: "userMessage", text: text, status: "pending"))
        return id
    }
    public mutating func removeEcho(threadID: String, id: String) { threads[threadID]?.pendingMessages.removeAll { $0.id == id } }
    public mutating func disconnect() {
        for id in Array(threads.keys) { settle(id); threads[id]?.status = "notLoaded"; threads[id]?.activeFlags = [] }
    }
    public mutating func interrupt(threadID: String) {
        guard var thread = threads[threadID], let index = thread.turns.lastIndex(where: { $0.status == "inProgress" }) else { return }
        thread.turns[index].status = "interrupted"
        for item in thread.turns[index].items.indices where thread.turns[index].items[item].status == "inProgress" {
            thread.turns[index].items[item].status = "completed"
        }
        threads[threadID] = thread
    }
    private mutating func settle(_ id: String) {
        guard var thread = threads[id] else { return }
        for index in thread.turns.indices {
            if thread.turns[index].status == "inProgress" { thread.turns[index].status = "completed" }
            for item in thread.turns[index].items.indices where thread.turns[index].items[item].status == "inProgress" {
                thread.turns[index].items[item].status = "completed"
            }
        }
        threads[id] = thread
    }
    private mutating func reconcileEcho(_ threadID: String, _ item: ConversationItem) {
        guard item.type == "userMessage", seenUserItems[threadID, default: []].insert(item.id).inserted else { return }
        if let index = threads[threadID]?.pendingMessages.firstIndex(where: { $0.text == item.text }) {
            threads[threadID]?.pendingMessages.remove(at: index)
        }
    }
    public mutating func apply(method: String, params p: JSONValue) {
        if method == "thread/started" { load(p["thread"]); return }
        guard let id = p["threadId"].string, var thread = threads[id] else { return }
        if method == "thread/status/changed", let status = p["status"]["type"].string {
            thread.status = status; thread.activeFlags = p["status"]["activeFlags"].array.compactMap(\.string)
            threads[id] = thread
            if status != "active" { settle(id) }
            return
        }
        if method == "thread/name/updated" { thread.name = p["threadName"].string; threads[id] = thread; return }
        if method == "turn/started" || method == "turn/completed" {
            guard var turn = ConversationTurn(p["turn"]) else { return }
            if let index = thread.turns.firstIndex(where: { $0.id == turn.id }) {
                // Completion can carry a summary with no items; retain streamed content.
                if turn.items.isEmpty { turn.items = thread.turns[index].items }
                thread.turns[index] = turn
            } else { thread.turns.append(turn) }
            thread.status = method == "turn/started" ? "active" : "idle"
            threads[id] = thread
            for item in turn.items { reconcileEcho(id, item) }
            if method == "turn/completed" { settle(id) }
            return
        }
        guard ["item/started", "item/completed", "item/agentMessage/delta"].contains(method), let turnID = p["turnId"].string else { return }
        if !thread.turns.contains(where: { $0.id == turnID }) { thread.turns.append(.init(id: turnID)) }
        let index = thread.turns.firstIndex { $0.id == turnID }!
        if method == "item/agentMessage/delta" {
            guard let itemID = p["itemId"].string, let delta = p["delta"].string else { return }
            if let itemIndex = thread.turns[index].items.firstIndex(where: { $0.id == itemID }) {
                thread.turns[index].items[itemIndex].text += delta
            } else { thread.turns[index].items.append(.init(id: itemID, type: "agentMessage", text: delta, status: "inProgress")) }
        } else {
            guard var item = ConversationItem(p["item"]) else { return }
            if method == "item/started" { item.status = "inProgress" }
            else if item.status == "inProgress" { item.status = "completed" }
            if let itemIndex = thread.turns[index].items.firstIndex(where: { $0.id == item.id }) {
                // Item snapshots can lag streamed deltas; retain the longer agent text.
                if item.type == "agentMessage", thread.turns[index].items[itemIndex].text.count > item.text.count {
                    item.text = thread.turns[index].items[itemIndex].text
                }
                thread.turns[index].items[itemIndex] = item
            } else { thread.turns[index].items.append(item) }
            threads[id] = thread
            reconcileEcho(id, item)
            return
        }
        threads[id] = thread
    }
}
