// Reports the active window to the Time Management app over D-Bus, so it can track which
// application is in use. Loaded and unloaded by the app (see activity.rs). KWin scripts are
// sandboxed, so this does nothing but forward window id and title; all storage is in the app.

const SERVICE = "com.skybytescode.timemanagement";
const PATH = "/activity";
const IFACE = "com.skybytescode.timemanagement.Activity";

function send(method, window) {
    if (!window || !window.normalWindow) {
        return;
    }
    callDBus(SERVICE, PATH, IFACE, method, window.resourceClass || "", window.caption || "");
}

workspace.windowActivated.connect(function (window) {
    send("Focus", window);
});

// A window closing while focused ends the current interval even if no other window takes focus.
workspace.windowRemoved.connect(function (window) {
    if (window && workspace.activeWindow === null) {
        callDBus(SERVICE, PATH, IFACE, "Blur");
    }
});

// Report whatever is focused at startup.
send("Focus", workspace.activeWindow);
