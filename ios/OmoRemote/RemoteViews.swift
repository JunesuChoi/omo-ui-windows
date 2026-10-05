import SwiftUI
import OmoKit

@MainActor struct RemoteRootView: View {
    @EnvironmentObject private var model: RemoteModel
    @State private var search = ""
    @State private var path: [String] = []
    @State private var newSession = false
    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.macName == nil {
                    ContentUnavailableView {
                        Label("waiting_for_mac", systemImage: "cable.connector")
                    } description: {
                        Text("cable_instructions")
                    } actions: {
                        Button("retry") { model.stop(); model.start() }
                    }
                } else {
                    List {
                        Section { ConnectionHeader() }
                        ForEach(model.store.groups(search: search)) { group in
                            Section {
                                ForEach(group.threads) { thread in
                                    NavigationLink(value: thread.id) {
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(thread.title).font(.headline).lineLimit(2)
                                            if thread.needsMacAttention {
                                                Label("mac_attention", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                                            } else if thread.activeTurnID != nil {
                                                Label("working", systemImage: "ellipsis").font(.caption).foregroundStyle(.secondary)
                                            }
                                            Text(Date(timeIntervalSince1970: thread.updatedAt), style: .relative)
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            } header: { Text(group.cwd).textCase(nil) }
                        }
                        if model.store.threads.isEmpty {
                            Text(LocalizedStringKey(model.refreshing ? "loading_sessions" : "no_sessions")).foregroundStyle(.secondary)
                        }
                    }
                    .searchable(text: $search, prompt: Text("search_sessions"))
                    .refreshable { await model.refresh() }
                }
            }
            .navigationTitle("OmO")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { newSession = true } label: { Label("new_session", systemImage: "square.and.pencil") }
                        .disabled(!model.ready)
                }
            }
            .navigationDestination(for: String.self) { id in ConversationView(threadID: id) }
            .sheet(isPresented: $newSession) {
                NewSessionSheet { id in newSession = false; path.append(id) }
            }
            .alert("error_title", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
                Button("ok", role: .cancel) { model.errorMessage = nil }
            } message: { Text(model.errorMessage ?? "") }
            .onChange(of: model.macName) { _, name in if name == nil { path = []; newSession = false } }
        }
    }
}

@MainActor private struct ConnectionHeader: View {
    @EnvironmentObject private var model: RemoteModel
    var body: some View {
        HStack {
            Label(model.macName ?? "OmO", systemImage: "desktopcomputer")
            Spacer()
            Text(LocalizedStringKey("state_" + model.bridgeState))
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background((model.ready ? Color.green : Color.orange).opacity(0.15), in: Capsule())
        }
        .accessibilityElement(children: .combine)
    }
}

@MainActor struct ConversationView: View {
    let threadID: String
    @EnvironmentObject private var model: RemoteModel
    @State private var draft = ""
    @State private var submitting = false
    private var thread: ConversationThread? { model.store.threads[threadID] }
    private var working: Bool { thread?.activeTurnID != nil }
    private var items: [ConversationItem] { (thread?.turns.flatMap(\.items) ?? []) + (thread?.pendingMessages ?? []) }
    private var streamKey: String { "\(items.count)-\(items.last?.text.count ?? 0)-\(working)" }
    var body: some View {
        VStack(spacing: 0) {
            ConnectionHeader().padding(.horizontal).padding(.bottom, 8)
            if thread?.needsMacAttention == true {
                Label("mac_attention", systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange).padding(8)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(items) { item in ItemRow(item: item) }
                        if working {
                            HStack { ProgressView(); Text("working").font(.callout).foregroundStyle(.secondary) }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding()
                }
                .onChange(of: streamKey) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            Divider()
            VStack(spacing: 10) {
                TextField("message_placeholder", text: $draft, axis: .vertical)
                    .lineLimit(1...7).padding(10)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .disabled(submitting)
                HStack {
                    if working {
                        Button(role: .destructive) { Task { await model.interrupt(threadID) } } label: {
                            Label("stop", systemImage: "stop.fill")
                        }.disabled(!model.ready)
                    }
                    Spacer()
                    Button {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        submitting = true
                        Task {
                            if await model.send(threadID: threadID, text: text) { draft = "" }
                            submitting = false
                        }
                    } label: {
                        if submitting { ProgressView() }
                        else { Label(LocalizedStringKey(working ? "steer" : "send"), systemImage: "arrow.up") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.ready || submitting || model.busyThreads.contains(threadID) || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding()
        }
        .navigationTitle(thread?.title ?? "OmO")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.ready) { if model.ready { await model.open(threadID) } }
    }
}

@MainActor private struct ItemRow: View {
    let item: ConversationItem
    private var isText: Bool { ["agentMessage", "userMessage", "plan", "reasoning"].contains(item.type) }
    private var markdown: AttributedString {
        (try? AttributedString(markdown: item.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(item.text)
    }
    var body: some View {
        if isText {
            VStack(alignment: .leading, spacing: 5) {
                Text(LocalizedStringKey("item_" + item.type)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if item.type == "userMessage" { Text(item.text).textSelection(.enabled) }
                else { Text(markdown).textSelection(.enabled) }
                if item.status == "pending" { Text("sending").font(.caption).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(item.type == "userMessage" ? 12 : 0)
            .background(item.type == "userMessage" ? Color.accentColor.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 12))
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "wrench.and.screwdriver").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(LocalizedStringKey("item_" + item.type)).font(.caption.weight(.semibold))
                    Text(item.text).font(.system(.caption, design: .monospaced)).lineLimit(5).textSelection(.enabled)
                }
                Spacer(minLength: 0)
                if item.status == "inProgress" { ProgressView().controlSize(.small) }
                else { Image(systemName: item.status == "failed" ? "exclamationmark.circle" : "checkmark.circle").foregroundStyle(.secondary) }
            }
            .padding(12).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

@MainActor private struct NewSessionSheet: View {
    let onCreated: (String) -> Void
    @EnvironmentObject private var model: RemoteModel
    @Environment(\.dismiss) private var dismiss
    @State private var selected = ""
    @State private var creating = false
    var body: some View {
        NavigationStack {
            Form {
                Section("workspace") {
                    ForEach(model.store.recentWorkspaces, id: \.self) { cwd in
                        Button { selected = cwd } label: {
                            HStack { Text(cwd).foregroundStyle(.primary); Spacer(); if selected == cwd { Image(systemName: "checkmark") } }
                        }
                    }
                    if model.store.recentWorkspaces.isEmpty { Text("no_workspaces").foregroundStyle(.secondary) }
                }
                Section {
                    Button {
                        creating = true
                        Task {
                            if let id = await model.create(cwd: selected) { onCreated(id) }
                            creating = false
                        }
                    } label: { if creating { ProgressView() } else { Text("create_session") } }
                    .disabled(selected.isEmpty || creating || !model.ready)
                }
            }
            .navigationTitle("new_session")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("cancel") { dismiss() }.disabled(creating) } }
            .onAppear { selected = model.store.recentWorkspaces.first ?? "" }
        }
    }
}
