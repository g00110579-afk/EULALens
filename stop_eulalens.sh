#!/usr/bin/env bash
set -u

PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$PROJECT/.runtime"

echo "========================================"
echo " Stopping EULALens"
echo "========================================"

stop_service() {
    local name="$1"
    local pidfile="$RUNTIME/${name}.pid"

    if [[ ! -f "$pidfile" ]]; then
        echo "[SKIP] $name: no PID file"
        return
    fi

    local pid
    pid="$(cat "$pidfile")"

    if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) && kill -0 -- "-$pid" 2>/dev/null; then
        echo "[STOP] $name (process group $pid)"

        # Services are started with setsid, so the recorded PID is also
        # the process-group ID. Negative PID targets the complete group.
        kill -TERM -- "-$pid" 2>/dev/null || true

        for _ in {1..20}; do
            if ! kill -0 -- "-$pid" 2>/dev/null; then
                break
            fi
            sleep 0.5
        done

        if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) && kill -0 -- "-$pid" 2>/dev/null; then
            echo "[WARN] $name did not stop normally; forcing process group shutdown"
            kill -KILL -- "-$pid" 2>/dev/null || true
        fi
    else
        echo "[OK] $name already stopped"
    fi

    rm -f "$pidfile"
}

# Stop public tunnels first
stop_service frontend-tunnel
bash "$PROJECT/tools/backend-tunnel.sh" stop || exit 1

# Then stop application services
stop_service frontend
stop_service backend
stop_service ltx
stop_service hidream
stop_service qwen

echo
echo "EULALens launcher-managed services stopped."
