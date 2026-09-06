import AppKit

/**
 The menu bar, built in code because there is no nib.

 Most of it is a second front end onto the web app's own shortcut registry
 rather than a set of native commands: each item under Interface names an
 action id and fires it through `cosminova.ui.shortcuts.run`, so the menu and
 the key press are one behaviour with two ways in. Adding an action to the
 registry is the only step needed to have it appear here as well.

 The keys are the app's own — F1 to F12, the same ones the help panel lists —
 rather than the ⌘-digit equivalents a Mac menu would normally invent. That is
 deliberate: the app documents F-keys everywhere, and a shell that answered to
 different keys than its own help screen would be its own bug. See
 `FunctionKeys` for what macOS does to those keys before the app sees them.
 */
enum MainMenu {
    /**
     Mirrors the registrations in `src/ui/explorer-ui.js`.

     The labels are copied from the registry rather than rephrased, so the menu
     and the help panel read the same. If the two ever disagree, the registry
     is right and this is stale.
     */
    private static let interfaceActions: [(key: Int, id: String, label: String)] = [
        (1, "open.help", "Help and controls"),
        (2, "open.search", "Search"),
        (3, "open.inspector", "Object information"),
        (4, "open.navigation", "Navigation panel"),
        (5, "toggle.labels", "Object labels"),
        (6, "open.camera", "Camera panel"),
        (7, "open.system", "Planetary system"),
        (8, "open.bookmarks", "Bookmarks"),
        (9, "open.display", "Display panel"),
        (10, "open.settings", "Interface settings"),
        (11, "toggle.immersive", "Immersive mode"),
        (12, "toggle.music", "Music"),
    ]

    static func install(target: AppDelegate) {
        let bar = NSMenu()
        bar.addItem(appMenu())
        bar.addItem(interfaceMenu(target: target))
        bar.addItem(viewMenu(target: target))
        bar.addItem(windowMenu())
        bar.addItem(helpMenu(target: target))
        NSApp.mainMenu = bar
    }

    // MARK: - menus

    private static func appMenu() -> NSMenuItem {
        let name = Bundle.main.infoDictionary?["CFBundleName"] as? String ?? "Cosminova"
        let item = NSMenuItem()
        let menu = NSMenu()

        menu.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        menu.addItem(.separator())

        let hide = menu.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hide.keyEquivalentModifierMask = [.command]

        let hideOthers = menu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]

        menu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        item.submenu = menu
        return item
    }

    private static func interfaceMenu(target: AppDelegate) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Interface")

        for action in interfaceActions {
            let entry = NSMenuItem(
                title: action.label,
                action: #selector(AppDelegate.runShortcut(_:)),
                keyEquivalent: FunctionKeys.equivalent(action.key)
            )
            // Empty rather than inherited: these are bare function keys, and a
            // menu item defaults to requiring command alongside whatever it is
            // given.
            entry.keyEquivalentModifierMask = []
            entry.target = target
            entry.representedObject = action.id
            menu.addItem(entry)
        }

        item.submenu = menu
        return item
    }

    private static func viewMenu(target: AppDelegate) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "View")

        /*
         The two entry points, which are the shell's own business rather than
         the app's: they load a different page, and there is no action in the
         registry for them. They keep ⌘-digit because every function key is
         already spoken for by something the app does, and inventing a
         thirteenth would collide.
         */
        let explorer = menu.addItem(withTitle: "Solar system", action: #selector(AppDelegate.showExplorer(_:)), keyEquivalent: "1")
        explorer.target = target
        let sky = menu.addItem(withTitle: "Sky from the ground", action: #selector(AppDelegate.showSky(_:)), keyEquivalent: "2")
        sky.target = target

        menu.addItem(.separator())

        let reload = menu.addItem(withTitle: "Reload", action: #selector(AppDelegate.reloadScene(_:)), keyEquivalent: "r")
        reload.target = target

        let full = menu.addItem(
            withTitle: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        full.keyEquivalentModifierMask = [.command, .control]

        item.submenu = menu
        return item
    }

    private static func windowMenu() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Window")

        menu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        item.submenu = menu
        NSApp.windowsMenu = menu
        return item
    }

    private static func helpMenu(target: AppDelegate) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Help")

        let help = NSMenuItem(
            title: "Help and controls",
            action: #selector(AppDelegate.runShortcut(_:)),
            keyEquivalent: ""
        )
        help.target = target
        help.representedObject = "open.help"
        menu.addItem(help)

        menu.addItem(.separator())

        // Put where somebody would look for it after pressing F9 and changing
        // the volume instead.
        let keys = menu.addItem(
            withTitle: "If the function keys aren't working…",
            action: #selector(AppDelegate.explainFunctionKeys(_:)),
            keyEquivalent: ""
        )
        keys.target = target

        item.submenu = menu
        NSApp.helpMenu = menu
        return item
    }
}

/**
 What macOS does to F1–F12 before an application ever sees them.

 By default those keys are hardware controls — brightness, Mission Control,
 volume — and the keystroke is consumed by the system, so a WKWebView hosting
 a page that listens for F9 receives nothing and the volume goes up instead.
 An application cannot take them back for itself; the setting is
 `com.apple.keyboard.fnState`, it is global, and the user owns it. Holding fn
 works too, per press.

 So the app does the two things it can: it says so plainly when the setting is
 off, once, and every one of those actions is on a menu item that works by
 mouse whatever the keyboard is doing.
 */
enum FunctionKeys {
    /// The key equivalent string AppKit wants for Fn, where F1 is 0xF704.
    static func equivalent(_ n: Int) -> String {
        guard let scalar = UnicodeScalar(NSF1FunctionKey + n - 1) else { return "" }
        return String(scalar)
    }

    /// True when the F-keys send F1…F12 rather than brightness and volume.
    static var behaveAsFunctionKeys: Bool {
        let global = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)
        return global?["com.apple.keyboard.fnState"] as? Bool ?? false
    }

    private static let suppressionKey = "CosminovaSuppressFunctionKeyNotice"

    static var noticeSuppressed: Bool {
        UserDefaults.standard.bool(forKey: suppressionKey)
    }

    /// The explanation, and a way to act on it. `unprompted` is a user asking
    /// through the Help menu, which should show even if they once ticked the
    /// suppression box.
    static func presentNotice(unprompted: Bool) {
        if !unprompted && (behaveAsFunctionKeys || noticeSuppressed) { return }

        let alert = NSAlert()
        alert.messageText = behaveAsFunctionKeys
            ? "The function keys are set up correctly."
            : "F1 to F12 are doing brightness and volume"
        alert.informativeText = behaveAsFunctionKeys
            ? "F1 to F12 reach Cosminova, so every shortcut in the Interface menu works from the keyboard."
            : """
              Cosminova puts its panels on F1 to F12 — F9 opens Display, where the music can be \
              turned off, and F1 shows the full list. macOS gives those keys to brightness and \
              volume unless you tell it otherwise, and an app cannot take them back for itself.

              Two ways round it: hold fn while pressing them, or turn on "Use F1, F2, etc. keys as \
              standard function keys" in Keyboard settings. Everything is also on the Interface \
              menu, which works regardless.
              """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open Keyboard Settings")
        alert.addButton(withTitle: "Not Now")
        if !unprompted {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "Don't remind me again"
        }

        let response = alert.runModal()
        if alert.suppressionButton?.state == .on {
            UserDefaults.standard.set(true, forKey: suppressionKey)
        }
        if response == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }
}
