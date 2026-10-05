# OmO for iPhone

A SwiftUI iOS 17 companion for controlling the Mac's omo over a USB cable. Bundle ID: `com.sigridjineth.omoui.ios`. English and Korean, system light/dark appearance, violet accent.

## Architecture

- `OmoKit` is a dependency-free Swift package (iOS 17 / macOS 13). `FrameCodec` incrementally decodes 4-byte big-endian length-prefixed UTF-8 JSON, rejecting frames over 8 MiB. `BridgeMessage` and `JSONValue` model the bridge contract, ignoring unknown frame types. `RPCClient` allocates IDs and owns continuations, cancellation, request deadlines, and disconnect cleanup. Its `BridgeTransport` is injectable.
- `ConversationStore` reduces Codex app-server threads, turns, item lifecycles and streamed agent deltas; it groups threads by workspace, summarizes tools, reconciles pending user echoes, and settles working turns on **any non-active thread status**. It chooses `turn/steer` with `expectedTurnId` while running, otherwise `turn/start`. Input is text only with `text_elements: []`.
- `OmoRemote` owns the iOS-only SwiftUI views and Network.framework listener. The listener binds device IPv4 and IPv6 **loopback** on TCP 47101, replacing the previous Mac connection on reconnect. It pings every 10 seconds, answers pings, and disconnects after 30 seconds without received bytes. Pending calls are rejected when a connection is replaced or lost. The connection lifecycle follows app foreground/background; keep the phone app foregrounded while controlling omo.
- The app lists every `thread/list` page, resumes and reads sessions, starts sessions from recent workspace cwds, renders markdown-like text and tool summaries, and provides send/steer/Stop. Active flags for approvals/questions show that the Mac needs attention: bridge version 1 does not forward approval requests, so answer them on the Mac.

The binding wire contract is [docs/iphone-bridge.md](../docs/iphone-bridge.md). Neither omo nor its credentials run on the phone.

## Portable verification

```sh
cd ios/OmoKit
swift build
swift test
```

`swift build` works with Command Line Tools alone. This Mac's CLT 5.9.2 installation lacks XCTest: `swift test` exits 1 with `error: XCTest not available` before compiling or running the 25 XCTest cases. Select a full Xcode developer directory (or use a Swift toolchain with XCTest on Linux) to run them. The core has no iOS dependencies; no simulator is needed for its tests. iOS compilation remains unverified until Xcode is available.

The actual Network.framework listener can also be exercised locally using CLT, without launching any app. From `ios/`, after building OmoKit:

```sh
swiftc -parse-as-library -I OmoKit/.build/arm64-apple-macosx/debug \
  OmoRemote/USBListener.swift Validation/ListenerSmoke.swift \
  OmoKit/.build/arm64-apple-macosx/debug/OmoKit.build/*.o \
  -o OmoKit/.build/listener-smoke
OmoKit/.build/listener-smoke
```

This smoke check passes IPv4/IPv6 loopback ping/pong and connection replacement on this Apple silicon Mac. It is not a replacement for XCTest or the real iPhone cable test. It temporarily reserves localhost port 47101.

## Build and install (full Xcode required)

The generated `OmoRemote.xcodeproj` is checked in and opens directly in Xcode. `project.yml` is the source of truth; regenerate after editing it:

```sh
cd ios
brew install xcodegen # if not already installed
xcodegen generate
```

Select the full Xcode developer directory after mounting/installing Xcode (adjust the path), and obtain the **team ID** from the Apple Developer account or Xcode Signing & Capabilities. The identity `Apple Development: hophfg@yahoo.co.kr (4VNMYZH5RB)` does not establish the team ID; `DEVELOPMENT_TEAM` is intentionally empty. Do not use the identity suffix as a guessed team ID.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project OmoRemote.xcodeproj -scheme OmoRemote \
  -destination 'generic/platform=iOS' -configuration Debug \
  -derivedDataPath DerivedData -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" build
xcrun devicectl list devices
xcrun devicectl device install app --device "$DEVICE_ID" \
  DerivedData/Build/Products/Debug-iphoneos/OmoRemote.app
```

Enable Developer Mode on the iPhone, trust/pair the Mac, select an appropriate development provisioning profile, and launch OmO on the phone. Simulator builds can validate SwiftUI but cannot exercise usbmux. iOS compilation, signing, installation, and the real cable flow require Xcode and a device and were not verified in the CLT-only environment. There is no background execution entitlement; iOS can suspend the app when backgrounded or locked.

## Cable connection

Connect the unlocked iPhone with a cable and open OmO UI on the Mac. The Mac watches `/var/run/usbmuxd` for **USB** attachments, connects to phone port 47101, sends `hello` with its name/omo state, and forwards the allowed app-server RPCs and notifications. The phone is the listener, not a network client; there is no Wi-Fi discovery, Bluetooth, local-network permission, or direct internet connection from this app. Disconnecting the cable returns to the waiting screen. Reopening the app allows the Mac's bridge retry to reconnect. For session approvals or questions, use the Mac.
