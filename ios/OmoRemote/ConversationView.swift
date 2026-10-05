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
