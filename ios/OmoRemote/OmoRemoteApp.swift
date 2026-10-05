import SwiftUI

@main @MainActor struct OmoRemoteApp: App {
    @StateObject private var model = RemoteModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RemoteRootView()
                .environmentObject(model)
                .tint(Color(red: 139 / 255, green: 92 / 255, blue: 246 / 255))
                .task { model.start() }
                .onChange(of: scenePhase) { _, phase in
                    // iOS suspends socket work in the background; reconnect on foreground.
                    if phase == .active { model.start() }
                    else if phase == .background { model.stop() }
                }
        }
    }
}
