#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# uninstall-all.sh — Remove everything installed by install.sh
#
# Removes (with confirmation for each phase):
#   Phase 1:  Docker agent stack (containers, images, volumes, networks)
#   Phase 2:  WordPress, Nginx, PHP, MariaDB  (only if installed by us)
#   Phase 3:  WP-CLI
#   Phase 4:  Docker itself
#
# Does NOT undo SSH hardening (PasswordAuthentication no) — reversing this
# automatically could lock you out of the server if you have no SSH key.
# To re-enable password auth manually:
#   sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config
#   systemctl reload sshd
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

confirm() {
    # confirm <prompt>  — returns 0 for yes, 1 for no
    local prompt="$1"
    local answer
    read -rp "  ${prompt} [y/N]: " answer
    [[ "${answer,,}" == "y" ]]
}

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Please run as root: sudo bash uninstall-all.sh"

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo
echo -e "${BOLD}${RED}"
cat << 'EOF'
  ╔══════════════════════════════════════════════════════╗
  ║              Full Uninstall — Remove Everything       ║
  ║           This action cannot be undone easily.        ║
  ╚══════════════════════════════════════════════════════╝
EOF
echo -e "${RESET}"

echo -e "  ${BOLD}What this script removes (per your confirmation):${RESET}"
echo "    Phase 1:  AI agent stack (containers, images, volumes, networks)"
echo "    Phase 2:  WordPress + database  (only if installed here)"
echo "    Phase 3:  Nginx, PHP 8.3, MariaDB system packages"
echo "    Phase 4:  WP-CLI"
echo "    Phase 5:  Docker (docker-ce + containerd)"
echo
echo -e "  ${YELLOW}NOT removed:${RESET} SSH hardening — reversing it automatically"
echo "  could lock you out of the server. See file header for manual steps."
echo
read -rp "  Type YES to proceed with selective removal: " confirm_start
[[ "$confirm_start" == "YES" ]] || { echo "Aborted."; exit 0; }

# ── Read values from .env ─────────────────────────────────────────────────────
_env() { grep "^${1}=" "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2- || true; }

WP_PATH=""
WP_DB_NAME=""
WP_DB_USER=""

if [[ -f "$SCRIPT_DIR/.env" ]]; then
    WP_PATH=$(_env WP_PATH)
    WP_DB_NAME=$(_env WP_DB_NAME)
    WP_DB_USER=$(_env WP_DB_USER)
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1 — AI agent stack
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}Phase 1: AI agent stack${RESET}"
echo

cd "$SCRIPT_DIR"

if command -v docker &>/dev/null && [[ -f docker-compose.yml ]]; then
    task "Stopping containers" \
        docker compose stop

    task "Removing containers, images, volumes, networks" \
        docker compose down --rmi all --volumes --remove-orphans

    # Named volumes can survive compose down if created outside compose context
    for vol in squid-logs agent-tmp; do
        for prefix in "" "wp-tg-agent_" "wp-tg-agent2_"; do
            docker volume rm "${prefix}${vol}" > /dev/null 2>&1 || true
        done
    done
    ok "Docker stack removed."
else
    warn "Docker not found or no docker-compose.yml — skipping."
fi

# ── Bridge plugin ─────────────────────────────────────────────────────────────
PLUGIN_DIR=""
if [[ -n "$WP_PATH" ]] && [[ -d "$WP_PATH/wp-content/plugins/openclaw-wp-bridge" ]]; then
    PLUGIN_DIR="$WP_PATH/wp-content/plugins/openclaw-wp-bridge"
elif [[ -d "/var/www/html/wp-content/plugins/openclaw-wp-bridge" ]]; then
    PLUGIN_DIR="/var/www/html/wp-content/plugins/openclaw-wp-bridge"
fi

if [[ -n "$PLUGIN_DIR" ]]; then
    WP_ROOT=$(dirname "$(dirname "$PLUGIN_DIR")")
    if command -v wp &>/dev/null; then
        task "Deactivating bridge plugin" \
            wp plugin deactivate openclaw-wp-bridge \
                --path="$WP_ROOT" --allow-root || true
    fi
    task "Removing bridge plugin files" \
        rm -rf "$PLUGIN_DIR"
fi

# ── Project config files ──────────────────────────────────────────────────────
[[ -f "$SCRIPT_DIR/.env"        ]] && { task "Removing .env"        rm -f "$SCRIPT_DIR/.env";        }
[[ -f "$SCRIPT_DIR/install.log" ]] && { task "Removing install.log" rm -f "$SCRIPT_DIR/install.log"; }

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2 — WordPress
# ─────────────────────────────────────────────────────────────────────────────

# Detect if a WordPress install exists locally
DETECTED_WP=""
for try_path in "$WP_PATH" /var/www/html /var/www/wordpress; do
    if [[ -n "$try_path" ]] && [[ -f "${try_path}/wp-config.php" ]]; then
        DETECTED_WP="$try_path"
        break
    fi
done

if [[ -n "$DETECTED_WP" ]]; then
    echo
    echo -e "${BOLD}Phase 2: WordPress${RESET}"
    echo "  Found WordPress at: $DETECTED_WP"
    echo

    if confirm "Remove WordPress files and database at ${DETECTED_WP}?"; then

        # Drop the database if we know the credentials
        if [[ -n "$WP_DB_NAME" ]] && command -v mysql &>/dev/null; then
            _drop_db() {
                mysql -u root << SQLEOF
DROP DATABASE IF EXISTS \`${WP_DB_NAME}\`;
DROP USER IF EXISTS '${WP_DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQLEOF
            }
            task "Dropping database '${WP_DB_NAME}'" _drop_db
        else
            warn "Could not read DB credentials from .env — database NOT dropped."
            warn "Drop it manually: mysql -u root -e \"DROP DATABASE \`your_db\`;\""
        fi

        task "Removing WordPress files at ${DETECTED_WP}" \
            rm -rf "$DETECTED_WP"

        # Remove Nginx vhost
        if [[ -f /etc/nginx/sites-enabled/wordpress ]]; then
            task "Removing Nginx WordPress vhost" \
                bash -c 'rm -f /etc/nginx/sites-enabled/wordpress \
                              /etc/nginx/sites-available/wordpress \
                    && nginx -t \
                    && systemctl reload nginx || true'
        fi

        ok "WordPress removed."

        # ── Phase 3: System packages ──────────────────────────────────────────
        echo
        echo -e "${BOLD}Phase 3: System packages (Nginx, PHP 8.3, MariaDB)${RESET}"
        echo "  These may be used by other services on this server."
        echo

        if confirm "Remove Nginx?"; then
            task "Removing Nginx" \
                bash -c 'systemctl stop nginx 2>/dev/null || true
                         apt-get remove --purge -y -qq nginx nginx-common nginx-core
                         apt-get autoremove -y -qq'
        fi

        if confirm "Remove PHP 8.3?"; then
            task "Removing PHP 8.3" \
                bash -c 'apt-get remove --purge -y -qq \
                             "php8.3*" \
                         && apt-get autoremove -y -qq'
        fi

        if confirm "Remove MariaDB (ALL databases will be deleted)?"; then
            echo -e "  ${RED}${BOLD}WARNING: This deletes ALL MariaDB databases on this server.${RESET}"
            if confirm "  Are you absolutely sure about MariaDB?"; then
                task "Removing MariaDB" \
                    bash -c 'systemctl stop mariadb 2>/dev/null || true
                             apt-get remove --purge -y -qq mariadb-server mariadb-client mariadb-common
                             apt-get autoremove -y -qq
                             rm -rf /var/lib/mysql /etc/mysql'
            fi
        fi
    else
        ok "WordPress skipped."
    fi
else
    ok "No local WordPress installation found — skipping Phase 2 & 3."
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 4 — WP-CLI
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}Phase 4: WP-CLI${RESET}"
echo

if [[ -f /usr/local/bin/wp ]]; then
    if confirm "Remove WP-CLI (/usr/local/bin/wp)?"; then
        task "Removing WP-CLI" rm -f /usr/local/bin/wp
    else
        ok "WP-CLI kept."
    fi
else
    ok "WP-CLI not found — skipping."
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 5 — Docker
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}Phase 5: Docker${RESET}"
echo "  This removes the Docker engine from the system."
echo "  Any other Docker projects on this server will stop working."
echo

if command -v docker &>/dev/null; then
    if confirm "Remove Docker (docker-ce + containerd)?"; then
        task "Stopping Docker service" \
            bash -c 'systemctl stop docker docker.socket containerd 2>/dev/null || true'
        task "Removing Docker packages" \
            bash -c 'apt-get remove --purge -y -qq \
                         docker-ce docker-ce-cli containerd.io \
                         docker-buildx-plugin docker-compose-plugin \
                     && apt-get autoremove -y -qq'
        task "Removing Docker data directories" \
            bash -c 'rm -rf /var/lib/docker /var/lib/containerd \
                            /etc/docker /etc/apt/sources.list.d/docker.list \
                            /etc/apt/keyrings/docker.gpg'
        ok "Docker removed."
    else
        ok "Docker kept."
    fi
else
    ok "Docker not found — skipping."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "${GREEN}${BOLD}  Uninstall complete.${RESET}"
echo
echo -e "  ${YELLOW}SSH hardening was NOT reversed.${RESET}"
echo "  Password authentication is still disabled on this server."
echo "  To re-enable it (only if you know you have a working SSH key):"
echo "    sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config"
echo "    systemctl reload sshd"
echo
