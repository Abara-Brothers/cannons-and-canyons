import UIKit
import Capacitor
import AuthenticationServices

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // CCBridgeViewController, not the stock one: it registers the app's own
        // plugins in capacitorDidLoad(). This line is the REAL wiring — a scene
        // delegate that sets rootViewController supersedes Main.storyboard, so
        // the storyboard's class alone would do nothing (verified the hard way).
        window?.rootViewController = CCBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}


// MARK: - Bridge subclass: registers the app's own plugins (ISSUE-039 sign-in)

/// Capacitor 8 calls the `open` hook `capacitorDidLoad()` from its `final`
/// `loadView()`, before the web view loads. `registerPluginInstance(_:)` is on
/// the public bridge protocol and, unlike `registerPluginType`, is NOT gated by
/// `autoRegisterPlugins`; it stores the instance by `jsName` and injects a
/// document-start user script that defines `window.Capacitor.Plugins.<jsName>`.
/// So JS gets a bridge method with no <script> tag, no eval, no CDN and no new
/// file in the Xcode target -- which is what the app's CSP and its no-bundler
/// rule require. Both native sign-in plugins register here; there must be
/// exactly ONE of these subclasses.
class CCBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(CCWebAuthPlugin())
    }
}

// MARK: - CCWebAuth: an OAuth leg that never leaves the app

/// Presents the provider's page in ASWebAuthenticationSession instead of
/// handing the URL to Safari. The session guarantees that ONLY the calling
/// app's session receives the callback, even if another app registers the
/// same scheme -- which is precisely the hole the domain-bound Universal Link
/// was chosen to close, now closed by the OS instead of by domain ownership.
/// It is also stricter than today's arrangement: an unclaimed Universal Link
/// lands the live implicit-flow token in Safari's address bar, and a
/// session-intercepted scheme callback can never reach an address bar at all.
///
/// Nothing here decides the scheme. JS passes the callback scheme it derived
/// from CC_IOS_CALLBACK, so the pin `scheme === bundle id` lives in one place
/// (config.js, checked by a house rule), not in a Swift literal too.
@objc(CCWebAuthPlugin)
public class CCWebAuthPlugin: CAPPlugin, CAPBridgedPlugin,
    ASWebAuthenticationPresentationContextProviding {
    public let identifier = "CCWebAuthPlugin"
    public let jsName = "CCWebAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]

    // MUST be held strongly. ASWebAuthenticationSession does not retain
    // itself; without this reference it is deallocated on return from start()
    // and the completion handler never fires -- the JS promise hangs forever
    // with no error, which is the worst failure shape a sign-in can have.
    private var session: ASWebAuthenticationSession?
    private var pending: CAPPluginCall?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("bad_url"); return
        }
        guard let scheme = call.getString("scheme"), !scheme.isEmpty else {
            call.reject("bad_scheme"); return
        }
        // A second tap while a sheet is up must not orphan the first promise.
        if pending != nil { call.reject("busy"); return }
        pending = call

        DispatchQueue.main.async {
            // The anchor must be a real window. Returning a bare
            // ASPresentationAnchor() here would make start() fail with an
            // opaque error, so refuse up front with a name the JS can act on.
            guard self.bridge?.viewController?.view.window != nil else {
                self.finish(reject: "no_window"); return
            }
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] cb, err in
                guard let self = self else { return }
                if let cb = cb {
                    self.pending?.resolve(["url": cb.absoluteString])
                    self.finish(reject: nil)
                    return
                }
                let cancelled = (err as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                if cancelled {
                    self.pending?.resolve(["cancelled": true])
                    self.finish(reject: nil)
                } else {
                    self.finish(reject: "failed")
                }
            }
            s.presentationContextProvider = self
            // Owner decision (recorded in the batch plan): keep Safari's cookies
            // shared so Google does not ask for the password on every sign-in.
            // The cost is the system alert naming the auth host once per
            // sign-in. Flip to `true` for a fully private sheet with no alert.
            s.prefersEphemeralWebBrowserSession = false
            self.session = s
            if !s.start() { self.finish(reject: "start_failed") }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func finish(reject: String?) {
        if let r = reject { pending?.reject(r) }
        pending = nil
        session = nil
    }
}
