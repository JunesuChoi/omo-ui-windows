import SwiftUI
import OmoKit

@MainActor struct ComposerView: View {
    let threadID: String
    let working: Bool
    @Binding var draft: String
    @Binding var submitting: Bool
    @EnvironmentObject private var model: RemoteModel
    var body: some View {
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
}
