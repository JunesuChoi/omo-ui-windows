import SwiftUI
import OmoKit

@MainActor struct ConnectionHeader: View {
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
