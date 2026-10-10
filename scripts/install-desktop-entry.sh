#!/bin/sh
# Installs the release build for the current user with an app-menu entry and, on KDE Plasma,
# a pinned taskbar launcher. Build first: npx tauri build --no-bundle
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
app_id=com.skybytescode.timemanagement
bin="$HOME/.local/bin/time_management"

install -Dm755 "$root/src-tauri/target/release/time_management" "$bin"
icon="$HOME/.local/share/icons/$app_id.png"

install -Dm644 "$root/src-tauri/icons/128x128.png" "$icon"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/$app_id.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Time Management
Comment=Focused work sessions with a countdown and site blocking
Exec=$bin
Icon=$icon
Terminal=false
Categories=Utility;
StartupWMClass=time_management
EOF
if command -v kbuildsycoca6 > /dev/null; then kbuildsycoca6 > /dev/null 2>&1 || true; fi

# Pin to the Plasma taskbar; an unset launcher list means Plasma's defaults, so keep those.
if command -v qdbus6 > /dev/null && qdbus6 org.kde.plasmashell > /dev/null 2>&1; then
  qdbus6 org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell.evaluateScript "
    const launcher = 'applications:$app_id.desktop';
    const defaults = ['applications:systemsettings.desktop', 'applications:org.kde.discover.desktop',
                      'preferred://filemanager', 'preferred://browser'];
    for (const panel of panels()) for (const w of panel.widgets()) {
      if (w.type !== 'org.kde.plasma.icontasks' && w.type !== 'org.kde.plasma.taskmanager') continue;
      w.currentConfigGroup = ['General'];
      let launchers = w.readConfig('launchers', []);
      if (launchers.length === 0) launchers = defaults;
      if (launchers.indexOf(launcher) < 0) w.writeConfig('launchers', launchers.concat([launcher]));
    }" > /dev/null 2>&1
fi

echo "Installed Time Management to $bin"
