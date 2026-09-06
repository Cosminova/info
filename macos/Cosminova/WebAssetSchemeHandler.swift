import Foundation
import UniformTypeIdentifiers
import WebKit

/**
 Serves the built web app to the WKWebView out of the application bundle.

 The obvious thing would be `loadFileURL(_:allowingReadAccessTo:)` and no
 handler at all, and it does not work here. WebKit gives a `file://` page an
 opaque origin, and an opaque origin fails the CORS check that module scripts
 are subject to, so every `import` in the build is refused before it is
 fetched. Vite emits nothing but modules. A custom scheme gets a real origin
 and the imports resolve, which is the whole reason this type exists.

 It is a read-only view of one directory inside the bundle. Nothing outside
 `Resources/web` is reachable, and the path check below is what guarantees it.
 */
final class WebAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    /// Matches the scheme registered on the configuration in AppDelegate.
    static let scheme = "cosminova"

    /// Where the build script stages `dist` inside the bundle.
    private let root: URL

    /// Cancelled tasks must not be replied to, and WebKit cancels often —
    /// every navigation away from a page abandons whatever it had in flight.
    private var live = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(root: URL) {
        self.root = root.standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); live.insert(id); lock.unlock()

        guard let url = task.request.url, let file = resolve(url) else {
            finish(task, id, with: NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL))
            return
        }

        // Read off the main thread. Some of these are tens of megabytes of
        // texture, and blocking the main thread on them stalls the very frame
        // loop the data is for.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let data = try Data(contentsOf: file, options: .mappedIfSafe)
                let response = HTTPURLResponse(
                    url: url,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Type": Self.mimeType(for: file),
                        "Content-Length": String(data.count),
                        // Same-origin by construction, but the engine fetches
                        // catalogues with XHR and WebKit still wants this.
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-cache",
                    ]
                )!
                self.deliver(task, id, response: response, data: data)
            } catch {
                self.finish(task, id, with: error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); live.remove(id); lock.unlock()
    }

    // MARK: - paths

    /**
     Maps a request URL onto a file, or refuses.

     `standardized` is doing real work in here: it resolves the `..` segments
     before the prefix is compared, so a request for `../../../etc/passwd`
     cannot walk out of the served directory by spelling its way out.
     */
    private func resolve(_ url: URL) -> URL? {
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        let candidate = root.appendingPathComponent(path).standardizedFileURL
        guard candidate.path.hasPrefix(root.path) else { return nil }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else {
            return nil
        }
        if isDirectory.boolValue {
            let index = candidate.appendingPathComponent("index.html")
            return FileManager.default.fileExists(atPath: index.path) ? index : nil
        }
        return candidate
    }

    /**
     Content types, from the system's table where it has one.

     The explicit cases are the ones the system gets wrong or does not know,
     and each matters: a module served as anything but a JavaScript type is
     rejected outright by the loader, and the binary formats the terrain
     streams would otherwise arrive as `text/plain` and be mangled.
     */
    private static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "ktx2": return "image/ktx2"
        case "bin", "dat": return "application/octet-stream"
        default:
            if let type = UTType(filenameExtension: file.pathExtension),
               let mime = type.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }

    // MARK: - replying

    private func deliver(_ task: WKURLSchemeTask, _ id: ObjectIdentifier, response: URLResponse, data: Data) {
        DispatchQueue.main.async {
            self.lock.lock()
            let stillWanted = self.live.remove(id) != nil
            self.lock.unlock()
            guard stillWanted else { return }
            // Replying to a stopped task raises an Objective-C exception that
            // Swift cannot catch, so the check above is not optional.
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        }
    }

    private func finish(_ task: WKURLSchemeTask, _ id: ObjectIdentifier, with error: Error) {
        DispatchQueue.main.async {
            self.lock.lock()
            let stillWanted = self.live.remove(id) != nil
            self.lock.unlock()
            guard stillWanted else { return }
            task.didFailWithError(error)
        }
    }
}
