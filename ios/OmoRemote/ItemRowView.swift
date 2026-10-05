import SwiftUI
import OmoKit

@MainActor struct ItemRow: View {
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
