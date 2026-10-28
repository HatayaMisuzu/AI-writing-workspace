#!/usr/bin/env bash
# 仅供 CI/本地测试：在隔离 HOME 中准备一个已解锁的 gnome-keyring（真实 Secret Service），
# 再运行 e2e。需在 `xvfb-run -a dbus-run-session --` 下调用。不改变应用的安全存储行为。
set -euo pipefail
export HOME="$(mktemp -d)"
keyrings="$HOME/.local/share/keyrings"
mkdir -p "$keyrings"
printf '[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' > "$keyrings/login.keyring"
printf 'login' > "$keyrings/default"
gnome-keyring-daemon --start --daemonize --components=secrets >/dev/null
exec npm run test:e2e
