import AppKit
import WebKit

/**
 Cosminova as a native macOS application.

 The renderer is the same build that runs in a browser and in the Electron
 shell, hosted here in a WKWebView instead of a packaged Chromium. What that
 changes, and it is the reason to have this at all, is what ships: no second
 browser engine inside the app, so the download goes from a couple of hundred
 megabytes to the size of the assets, and the thing builds and signs through
 Xcode like any other Mac app.

 What it costs is the GPU switches Electron could ask for. Chromium takes
 `force_high_performance_gpu` on the command line; WebKit takes no such
 argument, and the nearest equivalent is a bundle key, which is set in
 Info.plist and explained there.
 */
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// The two entry points the web app is built with.
    enum View: String {
        case explorer = "index.html"
        case sky = "sky.html"
    }

    private var window: NSWindow!
    private var webView: WKWebView!
    private var schemeHandler: WebAssetSchemeHandler!

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // .regular rather than .accessory: this owns a window and belongs in
        // the Dock and the app switcher.
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
            presentFatal(
                "The web build is missing from this app bundle.",
                detail: "Resources/web should hold the output of `npm run build`. "
                    + "The Xcode target has a build phase that produces it; if that phase "
                    + "failed, its log will say why."
            )
            return
        }

        schemeHandler = WebAssetSchemeHandler(root: root)
        buildWindow()
        load(.explorer)
        MainMenu.install(target: self)

        NSApp.activate(ignoringOtherApps: true)
    }

    /*
     Closing the window does not quit, which is the Mac convention and what the
     Electron shell already does — it only calls `app.quit()` on window-close
     off darwin. The window is kept rather than rebuilt, so coming back through
     the Dock returns to the scene as it was instead of reloading a hundred and
     sixty megabytes of assets and starting the tour again.
     */
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: - window

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: WebAssetSchemeHandler.scheme)

        // The scene wants the whole canvas from the first frame, and a page
        // that has to wait for a user gesture before it can run its animation
        // loop or its audio would stall on the intro.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

        /*
         Stands in for the Electron preload bridge, which exposes the same two
         facts. Worth saying that nothing in the app currently reads them —
         the bridge is unused on the Electron side too — but leaving the two
         shells at parity costs one script and means whichever page starts
         using it does not have to be told which shell it is in.
         */
        let bridge = WKUserScript(
            source: """
            window.cosminovaDesktop = {
              version: '\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")',
              platform: 'darwin',
              shell: 'macos'
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(bridge)

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The scene fades up from black and a white flash first reads as a
        // fault, so neither the view nor the window is allowed to paint one.
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false

        // Most of the display rather than a fixed default: the scene is a
        // panorama and a small window wastes it, while filling the screen
        // outright hides that this is a window at all.
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: visible.width * 0.86, height: visible.height * 0.86)

        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Cosminova"
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = .black
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("CosminovaMain")
        window.makeKeyAndOrderFront(nil)
    }

    private func load(_ view: View) {
        let url = URL(string: "\(WebAssetSchemeHandler.scheme)://app/\(view.rawValue)")!
        webView.load(URLRequest(url: url))
    }

    // MARK: - menu actions

    @objc func showExplorer(_ sender: Any?) { load(.explorer) }
    @objc func showSky(_ sender: Any?) { load(.sky) }
    @objc func reloadScene(_ sender: Any?) { webView.reload() }

    // MARK: - failure

    private func presentFatal(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = message
        alert.informativeText = detail
        alert.runModal()
        NSApp.terminate(nil)
    }
}

extension AppDelegate: WKNavigationDelegate {
    /**
     A link to a catalogue or a data source belongs in the user's browser, not
     in a window with no address bar and no way back.
     */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("Cosminova: navigation failed — %@", error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        NSLog("Cosminova: could not load the scene — %@", error.localizedDescription)
    }
}

extension AppDelegate: WKUIDelegate {
    /// `target="_blank"` arrives here rather than through the navigation
    /// delegate, and has to be sent outside the same way.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}
