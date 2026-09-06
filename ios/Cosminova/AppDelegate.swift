import UIKit
import WebKit

/**
 Cosminova as a native iOS and iPadOS application.

 The same shell as the Mac app: one WKWebView, the same bundled Vite build,
 served over the same custom scheme for the same reason — see
 `WebAssetSchemeHandler`, which is shared between the two platforms unchanged.

 What is different is the web build and the device. `npm run build:ios` emits a
 separate bundle with the phone and tablet asset set, a fraction of the
 desktop's 176 MB, and the renderer sizes its shader loop bounds, texture
 ceilings and particle buffers from the device class this shell injects below.

 There is no menu bar to port. The Mac shell needed one because macOS takes
 F1–F12 before an application ever sees them, so every panel had to be reachable
 by mouse as well; iPadOS hands those keys straight to the web view and the app's
 own registry answers them. What is left for the shell are the two or three keys
 no page can claim, which the view controller declares.
 */
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    private var schemeHandler: WebAssetSchemeHandler!
    private var scene: SceneViewController!

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        self.window = window

        guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
            presentFatal(
                "The web build is missing from this app bundle.",
                detail: "A `web` directory in the bundle should hold the output of `npm run build:ios`. "
                    + "The Xcode target has a build phase that produces it; if that phase "
                    + "failed, its log will say why."
            )
            return true
        }

        schemeHandler = WebAssetSchemeHandler(root: root)
        scene = SceneViewController(webView: buildWebView())
        window.rootViewController = scene
        window.makeKeyAndVisible()
        scene.load(.explorer)

        return true
    }

    // MARK: - web view

    private func buildWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: WebAssetSchemeHandler.scheme)

        // The scene wants the whole canvas from the first frame, and a page that
        // has to wait for a user gesture before it can run its animation loop or
        // its audio would stall on the intro. Inline for the same reason: handed
        // to the system player, media would take the screen away from the scene.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsInlineMediaPlayback = true
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

        /*
         The device signal, and the authoritative one: `src/engine/platform.js`
         prefers it over anything it could infer. Its fallback cannot tell an
         iPad from a Mac, because iPadOS has claimed to be a Macintosh in its
         user agent for years, and the difference decides texture ceilings a
         phone cannot exceed without having its content process terminated.

         `.atDocumentStart` is load-bearing rather than tidy. A shader's loop
         bound is compiled into the program and a buffer's size is fixed when it
         is allocated, so the profile has to be settled before the first line of
         page script runs; arriving a moment later would be arriving too late.
         */
        let deviceClass = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        let bridge = WKUserScript(
            source: """
            window.cosminovaShell = {
              shell: 'ios',
              platform: 'ios',
              deviceClass: '\(deviceClass)',
              version: '\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")'
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(bridge)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        // `developerExtrasEnabled` alone was enough before 16.4; from 16.4 a web
        // view also has to opt in by name or Safari will not list it. Both are
        // set so the inspector works across the whole supported range.
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        // The scene fades up from black and a white flash first reads as a
        // fault, so nothing in the stack is allowed to paint one.
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black

        /*
         A canvas, not a document. Every default here belongs to a web view that
         is showing a page taller than the screen, and on this one they all steal
         input the renderer wanted: a drag across the sky becomes a scroll, a
         two-finger gesture becomes a page zoom, and a flick at the edge becomes
         a rubber-band the camera sees as a stutter.
         */
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsBackForwardNavigationGestures = false

        /*
         `.never` because the page already knows about the notch. The UI is
         positioned with `env(safe-area-inset-*)` in CSS, which is the only way
         it can keep its controls clear of the hardware while the sky itself
         still fills the display. Letting UIKit inset the viewport as well would
         apply the same margin twice and letterbox the scene.
         */
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        return webView
    }

    // MARK: - failure

    /**
     The bundle is missing its renderer, which nothing at runtime can fix.

     The Mac shell terminates after showing this. iOS has no supported way for an
     app to close itself — `exit` is indistinguishable from a crash to the person
     holding the phone, and to the review process — so this stops instead: the
     alert has no way out, and there is nothing but black behind it.
     */
    private func presentFatal(_ message: String, detail: String) {
        let placeholder = UIViewController()
        placeholder.view.backgroundColor = .black
        window?.rootViewController = placeholder
        window?.makeKeyAndVisible()

        let alert = UIAlertController(title: message, message: detail, preferredStyle: .alert)
        placeholder.present(alert, animated: false)
    }
}

extension AppDelegate: WKNavigationDelegate {
    /**
     A link to a catalogue, a data source or the support site belongs in the
     user's browser, not in a web view with no address bar and no way back.
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
            UIApplication.shared.open(url)
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
            UIApplication.shared.open(url)
        }
        return nil
    }
}

/**
 The one screen, which is the web view and nothing else.

 The web view is the controller's view rather than a subview of it: that way it
 is the size of the window with no constraints to write and no safe area applied
 to it, which is what the page expects — it reads the insets itself and lays out
 around them.
 */
final class SceneViewController: UIViewController {
    /// The two entry points the web app is built with.
    enum Entry: String {
        case explorer = "index.html"
        case sky = "sky.html"
    }

    private let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
    }

    /// There is no storyboard, so this is never reached.
    required init?(coder: NSCoder) {
        fatalError("SceneViewController is created in code.")
    }

    override func loadView() {
        view = webView
    }

    // The Info.plist keys keep the status bar off during launch; these keep it
    // and the home indicator out of a scene that is meant to be all sky.
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    func load(_ entry: Entry) {
        let url = URL(string: "\(WebAssetSchemeHandler.scheme)://app/\(entry.rawValue)")!
        webView.load(URLRequest(url: url))
    }

    /*
     For an iPad with a hardware keyboard, and deliberately only three keys.

     Everything else the app binds — F1 to F12 and the letter keys — reaches the
     web view directly here and is answered by `cosminova.ui.shortcuts`, so a
     native mirror of the Mac menu would give each action two owners that could
     drift apart. These three are not in that registry and cannot be: from the
     page's side, switching entry point and reloading are a navigation, which is
     the shell's business. ⌘1 and ⌘2 keep the equivalents the Mac menu uses.
     */
    override var keyCommands: [UIKeyCommand]? {
        [
            UIKeyCommand(
                title: "Solar system",
                action: #selector(showExplorer),
                input: "1",
                modifierFlags: .command
            ),
            UIKeyCommand(
                title: "Sky from the ground",
                action: #selector(showSky),
                input: "2",
                modifierFlags: .command
            ),
            UIKeyCommand(
                title: "Reload",
                action: #selector(reloadScene),
                input: "r",
                modifierFlags: .command
            ),
        ]
    }

    @objc private func showExplorer() { load(.explorer) }
    @objc private func showSky() { load(.sky) }
    @objc private func reloadScene() { webView.reload() }
}
