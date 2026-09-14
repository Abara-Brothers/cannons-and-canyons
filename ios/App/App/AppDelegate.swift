import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    // ---- APNs registration ---------------------------------------------------
    // Without these two, @capacitor/push-notifications is a dead end on iOS:
    // requestPermissions() raises a REAL system notification prompt, register()
    // then silently fails, and NEITHER the `registration` nor the
    // `registrationError` listener can ever fire -- the player gets a permission
    // dialog followed by nothing at all. The plugin says so itself, rejecting
    // its own calls with "event capacitorDidRegisterForRemoteNotifications not
    // called". A prompt that leads nowhere is both a dead end for the player and
    // an App Review risk, which is why app.js hid the opt-in on iOS.
    //
    // UIKit delivers remote-notification registration to the APP delegate even
    // in a scene-based app, so these belong here and not in SceneDelegate. The
    // Universal Links half needs no code at all: SceneDelegate already forwards
    // `continue userActivity` to SceneDelegateProxy.
    //
    // The plugin hex-encodes this Data into the string that reaches the server
    // and becomes the `endpoint` of an `ios` push_subscriptions row. It is a RAW
    // APNs token, not an FCM one -- see the APNs sender in server.js.
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications,
                                        object: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Posted rather than swallowed: the plugin turns this into a
        // `registrationError` event, and the client shows the player that nudges
        // could not be enabled. Silence here would look identical to success.
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications,
                                        object: error)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
