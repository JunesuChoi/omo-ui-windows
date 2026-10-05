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
