import SwiftUI
import OmoKit

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
            ComposerView(threadID: threadID, working: working, draft: $draft, submitting: $submitting)
        }
        .navigationTitle(thread?.title ?? "OmO")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.ready) { if model.ready { await model.open(threadID) } }
    }
}
