import UIKit
import Capacitor
import AuthenticationServices
import CryptoKit
import Security

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
        bridge?.registerPluginInstance(AppleSignInPlugin())
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

// MARK: - AppleSignIn: the system Sign in with Apple sheet

/// ASAuthorizationController instead of any web flow: no browser, Face ID
/// confirms, and Apple returns a signed identity token whose audience is this
/// bundle id. JS posts that token to Supabase's id_token grant. The NONCE is
/// the replay guard: a fresh random value per request, its SHA-256 handed to
/// Apple (it is embedded in the token), the RAW value handed to JS for GoTrue
/// to hash and compare. Nothing here decides what the token becomes -- a fresh
/// account or a link to the guest's -- that is JS, with the guest's bearer.
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]

    // Held strongly for the same reason CCWebAuth holds its session: the
    // system does not retain the controller, and a released one never calls
    // its delegate -- the promise would hang with no error.
    private var controller: ASAuthorizationController?
    private var pending: CAPPluginCall?
    private var rawNonce: String?

    @objc func start(_ call: CAPPluginCall) {
        if pending != nil { call.reject("busy"); return }
        pending = call
        DispatchQueue.main.async {
            guard self.bridge?.viewController?.view.window != nil else {
                self.finish(reject: "no_window"); return
            }
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                self.finish(reject: "no_entropy"); return
            }
            let raw = bytes.map { String(format: "%02x", $0) }.joined()
            self.rawNonce = raw
            let hashed = SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()

            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email]
            request.nonce = hashed
            let c = ASAuthorizationController(authorizationRequests: [request])
            c.delegate = self
            c.presentationContextProvider = self
            self.controller = c
            c.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = cred.identityToken,
              let token = String(data: data, encoding: .utf8),
              let raw = rawNonce else {
            finish(reject: "no_token"); return
        }
        var out: [String: Any] = ["idToken": token, "nonce": raw]
        // Email only, by design (docs/LEGAL_POSITION.md section 3: collect the
        // least a sign-in needs; a name is never used anywhere). It may be a
        // private relay address, which is as valid as any other, and it is
        // optional: signing in needs the token, nothing else.
        if let e = cred.email { out["email"] = e }
        pending?.resolve(out)
        finish(reject: nil)
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        if (error as? ASAuthorizationError)?.code == .canceled {
            pending?.resolve(["cancelled": true])
            finish(reject: nil)
        } else {
            finish(reject: "failed")
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func finish(reject: String?) {
        if let r = reject { pending?.reject(r) }
        pending = nil
        controller = nil
        rawNonce = nil
    }
}
