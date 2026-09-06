import AppKit

/**
 The menu bar, built in code because there is no nib.

 It exists for one reason, the same reason the Electron build has one: the app
 ships two views and the in-page UI only offers the switch in one direction.
 The rest is the standard set, which has to be spelled out because defining an
 application menu at all replaces what AppKit would otherwise supply.
 */
enum MainMenu {
    static func install(target: AppDelegate) {
        let bar = NSMenu()

        bar.addItem(appMenu())
        bar.addItem(viewMenu(target: target))
        bar.addItem(windowMenu())

        NSApp.mainMenu = bar
    }

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

    private static func viewMenu(target: AppDelegate) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "View")

        let explorer = menu.addItem(withTitle: "Solar system", action: #selector(AppDelegate.showExplorer(_:)), keyEquivalent: "1")
        explorer.target = target

        let sky = menu.addItem(withTitle: "Sky from the ground", action: #selector(AppDelegate.showSky(_:)), keyEquivalent: "2")
        sky.target = target

        menu.addItem(.separator())

        let reload = menu.addItem(withTitle: "Reload", action: #selector(AppDelegate.reloadScene(_:)), keyEquivalent: "r")
        reload.target = target

        menu.addItem(
            withTitle: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        ).keyEquivalentModifierMask = [.command, .control]

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
}
