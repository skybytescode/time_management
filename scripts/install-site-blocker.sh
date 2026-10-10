#!/bin/sh
# One-time setup so the app can block sites without asking for a password.
# Usage: sudo sh scripts/install-site-blocker.sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }
user=${SUDO_USER:?Run this with sudo from your normal user account.}
dir=$(dirname "$0")

install -m 755 -o root -g root "$dir/tm-block-sites" /usr/local/bin/tm-block-sites

rule=$(mktemp)
trap 'rm -f "$rule"' EXIT
echo "$user ALL=(root) NOPASSWD: /usr/local/bin/tm-block-sites" > "$rule"
visudo -cf "$rule" > /dev/null
install -m 440 -o root -g root "$rule" /etc/sudoers.d/time-management

echo "Site blocker installed for $user."
