#!/usr/bin/env bash
# Start or stop only the named tunnel for the local EULALens API.
set -euo pipefail
umask 077

case ${1:-} in start|stop) action=$1 ;; *) echo "Usage: $0 start|stop" >&2; exit 2 ;; esac

project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
root=${EULALENS_ROOT:-$(dirname "$project")}
binary="$root/scripts_dev/qwen-3.5-9b/bin/cloudflared"
token="$HOME/.cloudflared/eulalens-backend.token"
runtime="$project/.runtime"
pidfile="$runtime/backend-tunnel.pid"
unit=eulalens-backend-tunnel.service

mkdir -p "$runtime/logs"
exec 9>"$runtime/backend-tunnel.lock"
flock -x 9

# Old launchers and hosts without a user service manager track a standalone PID.
# A recycled PID must never suppress startup or cause an unrelated process to stop.
standalone_pid() {
    local pid i
    local -a args
    [[ -f "$pidfile" ]] && read -r pid <"$pidfile" || return 1
    [[ "$pid" =~ ^[1-9][0-9]+$ && "$pid" != 1 && -r "/proc/$pid/cmdline" ]] || return 1
    mapfile -d '' -t args <"/proc/$pid/cmdline" || return 1
    [[ ${args[0]:-} == "$binary" ]] || return 1
    for ((i=1; i<${#args[@]}; i++)); do
        if [[ ${args[i]} == --token-file && ${args[i+1]:-} == "$token" ]]; then
            printf '%s\n' "$pid"
            return 0
        fi
    done
    return 1
}

stop_standalone() {
    local pid
    if pid=$(standalone_pid); then
        kill -TERM "$pid" || [[ ! -d "/proc/$pid" ]] || return 1
    fi
    rm -f -- "$pidfile"
}

unit_state=$(systemctl --user show "$unit" -p LoadState --value 2>/dev/null) || unit_state=''
if [[ $action == stop ]]; then
    if [[ $unit_state == loaded ]]; then
        systemctl --user stop "$unit"
    fi
    stop_standalone
    exit 0
fi

[[ -x "$binary" ]] || { echo "Missing executable: $binary" >&2; exit 1; }
[[ -s "$token" ]] || { echo "Missing tunnel token file: $token" >&2; exit 1; }

if [[ -n $unit_state ]] && command -v systemd-run >/dev/null; then
    if [[ $unit_state == loaded ]]; then
        systemctl --user start "$unit"
    else
        systemd-run --user --unit="$unit" --description='EULALens public API tunnel' \
            --collect --service-type=exec --property=Restart=always --property=RestartSec=5s \
            --property=UMask=0077 "$binary" tunnel --protocol http2 run --token-file "$token"
    fi
    stop_standalone
    echo "[OK] Tunnel managed by $unit"
elif standalone_pid >/dev/null; then
    echo "[OK] Standalone tunnel already running"
else
    # A standalone connector has no supervisor to relaunch it after a self-update.
    nohup setsid "$binary" tunnel --no-autoupdate --protocol http2 run --token-file "$token" \
        9>&- </dev/null >>"$runtime/logs/backend-tunnel.log" 2>&1 &
    echo "$!" >"$pidfile"
    echo "[START] Standalone tunnel (manual updates)"
fi
