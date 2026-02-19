#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# uninstall-ai.sh — Remove the AI agent stack only
#
# Removes:  Docker containers, images, volumes, networks (openclaw-*)
#           Bridge plugin from WordPress (if local)
#           .env and install.log
#
# Keeps:    WordPress, Nginx, PHP, MariaDB, WP-CLI, Docker itself
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ok()   { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
die()  { echo -e "${RED}✗ ERROR:${RESET} $*" >&2; exit 1; }

task() {
    local label="$1"; shift
    "$@" > /dev/null 2>&1 &
    local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${BLUE}%s${RESET}  %-60s" "${frames:$(( i++ % ${#frames} )):1}" "$label"
        sleep 0.1
    done
    if wait "$pid"; then
        printf "\r  ${GREEN}✓${RESET}  %-60s\n" "$label"
    else
        printf "\r  ${YELLOW}⚠${RESET}  %-60s (non-fatal)\n" "$label"
    fi
}

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo
echo -e "${BOLD}${YELLOW}"
cat << 'EOF'
  ╔══════════════════════════════════════════════════════╗
  ║           Uninstall AI Agent Stack Only               ║
  ║   WordPress, Nginx, PHP, MariaDB will NOT be touched  ║
  ╚══════════════════════════════════════════════════════╝
EOF
echo -e "${RESET}"

[[ $EUID -ne 0 ]] && die "Please run as root: sudo bash uninstall-ai.sh"

echo "  This will permanently remove:"
echo "    • All openclaw Docker containers"
echo "    • All openclaw Docker images"
echo "    • Docker volumes (squid-logs, agent-tmp)"
echo "    • Docker networks (agent-internal, proxy-external)"
echo "    • The OpenClaw bridge plugin from WordPress"
echo "    • .env and install.log"
echo
echo "  This will NOT touch:"
echo "    • WordPress files or database"
echo "    • Nginx, PHP, MariaDB"
echo "    • Docker itself"
echo "    • WP-CLI"
echo

read -rp "  Are you sure? Type YES to confirm: " confirm
[[ "$confirm" == "YES" ]] || { echo "Aborted."; exit 0; }
echo

# ── Read WP_PATH from .env (if it exists) ─────────────────────────────────────
WP_PATH=""
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    WP_PATH=$(grep "^WP_PATH=" "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
fi

# ── Stop and remove Docker stack ──────────────────────────────────────────────
cd "$SCRIPT_DIR"

if command -v docker &>/dev/null && [[ -f docker-compose.yml ]]; then
    task "Stopping containers" \
        docker compose stop

    task "Removing containers, images, volumes, and networks" \
        docker compose down --rmi all --volumes --remove-orphans

    # Remove any lingering named volumes not caught by compose
    for vol in squid-logs agent-tmp; do
        docker volume rm "${vol}" > /dev/null 2>&1 && \
            ok "Removed volume: $vol" || true
        # Also try with project-prefixed name
        docker volume rm "wp-tg-agent_${vol}" > /dev/null 2>&1 || true
        docker volume rm "wp-tg-agent2_${vol}" > /dev/null 2>&1 || true
    done
else
    warn "Docker not found or no docker-compose.yml — skipping container removal."
fi

# ── Remove bridge plugin ───────────────────────────────────────────────────────
PLUGIN_DIR=""
if [[ -n "$WP_PATH" ]] && [[ -d "$WP_PATH/wp-content/plugins/openclaw-wp-bridge" ]]; then
    PLUGIN_DIR="$WP_PATH/wp-content/plugins/openclaw-wp-bridge"
elif [[ -d "/var/www/html/wp-content/plugins/openclaw-wp-bridge" ]]; then
    PLUGIN_DIR="/var/www/html/wp-content/plugins/openclaw-wp-bridge"
fi

if [[ -n "$PLUGIN_DIR" ]]; then
    WP_INSTALL_PATH=$(dirname "$(dirname "$PLUGIN_DIR")")
    if command -v wp &>/dev/null; then
        task "Deactivating bridge plugin" \
            wp plugin deactivate openclaw-wp-bridge \
                --path="$WP_INSTALL_PATH" --allow-root || true
    fi
    task "Removing bridge plugin files" \
        rm -rf "$PLUGIN_DIR"
else
    ok "Bridge plugin not found — skipping."
fi

# ── Remove project config files ───────────────────────────────────────────────
[[ -f "$SCRIPT_DIR/.env"        ]] && task "Removing .env"        rm -f "$SCRIPT_DIR/.env"
[[ -f "$SCRIPT_DIR/install.log" ]] && task "Removing install.log" rm -f "$SCRIPT_DIR/install.log"

# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "${GREEN}${BOLD}  AI agent stack removed.${RESET}"
echo
echo "  To reinstall:  sudo bash install.sh"
echo "  Docker, WordPress, Nginx, PHP, and MariaDB are still intact."
echo
