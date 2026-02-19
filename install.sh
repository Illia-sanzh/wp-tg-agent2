#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WordPress Telegram Agent — Installer
# Tested on: Ubuntu 24.04 (VPS)
# Usage: bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours & helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/install.log"

say()   { echo -e "${CYAN}${BOLD}▶${RESET} $*"; }
ok()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
die()   { echo -e "${RED}✗ ERROR:${RESET} $*" >&2; exit 1; }
log()   { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE"; }

# Progress bar: progress <current> <total> <label>
progress() {
    local cur=$1 total=$2 label=$3
    local pct=$(( cur * 100 / total ))
    local filled=$(( pct / 4 ))
    local empty=$(( 25 - filled ))
    local bar="${GREEN}$(printf '█%.0s' $(seq 1 $filled))${RESET}$(printf '░%.0s' $(seq 1 $empty))"
    printf "\r  [%b] %3d%%  %-40s" "$bar" "$pct" "$label"
}

# Spinner while a background job runs
spin() {
    local pid=$1 label=$2
    local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        i=$(( (i+1) % ${#spin} ))
        printf "\r  ${BLUE}%s${RESET}  %s..." "${spin:$i:1}" "$label"
        sleep 0.1
    done
    wait "$pid" && printf "\r  ${GREEN}✓${RESET}  %-50s\n" "$label" \
                || { printf "\r  ${RED}✗${RESET}  %-50s\n" "$label"; return 1; }
}

step_run() {
    local label=$1; shift
    local cmd="$*"
    log "STEP: $label — $cmd"
    "$@" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    spin "$pid" "$label"
}

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo
echo -e "${BOLD}${BLUE}"
cat << 'EOF'
  ╔══════════════════════════════════════════════════════╗
  ║          WordPress Telegram Agent Installer           ║
  ║    Text your site commands. Claude does the work.    ║
  ╚══════════════════════════════════════════════════════╝
EOF
echo -e "${RESET}"
echo "  Log file: $LOG_FILE"
echo

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    die "Please run as root: sudo bash install.sh"
fi

# ── OS check ─────────────────────────────────────────────────────────────────
if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
    warn "This script is designed for Ubuntu. Proceeding anyway..."
fi

: > "$LOG_FILE"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Ask for configuration
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Step 1 of 6: Configuration${RESET}"
echo "  Answer the questions below. Press Enter to accept defaults."
echo

# AI Provider
echo -e "  ${BOLD}AI Provider${RESET}"
echo "    1) Anthropic Claude (recommended, best results)"
echo "    2) OpenAI ChatGPT"
echo "    3) DeepSeek (cheap, good for code)"
echo "    4) Google Gemini"
echo "    5) Multiple providers (you can add more later)"
echo
read -rp "  Choose provider [1-5, default=1]: " provider_choice
provider_choice="${provider_choice:-1}"

ANTHROPIC_API_KEY="" OPENAI_API_KEY="" DEEPSEEK_API_KEY="" GEMINI_API_KEY=""
DEFAULT_MODEL="claude-sonnet-4-6"
FALLBACK_MODEL="deepseek-chat"

collect_key() {
    local name=$1 var=$2 model=$3
    read -rsp "  Enter your $name API key: " key; echo
    [[ -z "$key" ]] && die "$name API key cannot be empty."
    eval "$var='$key'"
    DEFAULT_MODEL="$model"
}

case "$provider_choice" in
    1) collect_key "Anthropic" ANTHROPIC_API_KEY "claude-sonnet-4-6"
       FALLBACK_MODEL="claude-sonnet-4-6" ;;
    2) collect_key "OpenAI" OPENAI_API_KEY "gpt-4o"
       FALLBACK_MODEL="gpt-4o" ;;
    3) collect_key "DeepSeek" DEEPSEEK_API_KEY "deepseek-chat"
       FALLBACK_MODEL="deepseek-chat" ;;
    4) collect_key "Gemini" GEMINI_API_KEY "gemini-2.0-flash"
       FALLBACK_MODEL="gemini-2.0-flash" ;;
    5) echo "  Enter the keys you have (leave blank to skip):"
       read -rsp "  Anthropic API key: " ANTHROPIC_API_KEY; echo
       read -rsp "  OpenAI API key: "    OPENAI_API_KEY; echo
       read -rsp "  DeepSeek API key: "  DEEPSEEK_API_KEY; echo
       read -rsp "  Gemini API key: "    GEMINI_API_KEY; echo
       # Pick default model from first non-empty key
       if [[ -n "$ANTHROPIC_API_KEY" ]]; then DEFAULT_MODEL="claude-sonnet-4-6"
       elif [[ -n "$OPENAI_API_KEY" ]];   then DEFAULT_MODEL="gpt-4o"
       elif [[ -n "$DEEPSEEK_API_KEY" ]]; then DEFAULT_MODEL="deepseek-chat"
       elif [[ -n "$GEMINI_API_KEY" ]];   then DEFAULT_MODEL="gemini-2.0-flash"
       else die "No API key entered."; fi ;;
    *) die "Invalid choice." ;;
esac

echo
read -rp "  Monthly AI spend limit in USD [default=20]: \$" MONTHLY_BUDGET
MONTHLY_BUDGET="${MONTHLY_BUDGET:-20}"

# Telegram
echo
echo -e "  ${BOLD}Telegram Bot${RESET}"
read -rp "  Bot token (from @BotFather): " TELEGRAM_BOT_TOKEN
[[ -z "$TELEGRAM_BOT_TOKEN" ]] && die "Bot token is required."

read -rp "  Your Telegram user ID (from @userinfobot): " TELEGRAM_ADMIN_USER_ID
[[ -z "$TELEGRAM_ADMIN_USER_ID" ]] && die "User ID is required."

# WordPress
echo
echo -e "  ${BOLD}WordPress Site${RESET}"
read -rp "  WordPress URL (e.g. https://mysite.com): " WP_URL
[[ -z "$WP_URL" ]] && die "WordPress URL is required."
WP_URL="${WP_URL%/}"  # strip trailing slash

read -rp "  WordPress admin username [default=admin]: " WP_ADMIN_USER
WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"

echo "  Admin password or Application Password (for REST API):"
echo "  (Tip: create Application Password at WP Admin → Users → Your Profile)"
read -rsp "  Password: " WP_ADMIN_PASSWORD; echo

read -rp "  Application Password (leave blank if using admin password): " WP_APP_PASSWORD

echo
read -rp "  Is WordPress installed on THIS server? [Y/n]: " wp_local
wp_local="${wp_local:-Y}"

WP_PATH=""
if [[ "$wp_local" =~ ^[Yy]$ ]]; then
    read -rp "  WordPress path on this server [default=/var/www/html]: " WP_PATH
    WP_PATH="${WP_PATH:-/var/www/html}"
    [[ ! -d "$WP_PATH" ]] && warn "Directory $WP_PATH does not exist yet. Make sure it exists before starting."
fi

# Generate secrets
LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
BRIDGE_SECRET="$(openssl rand -hex 32)"

echo
ok "Configuration collected."
echo

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — System packages
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Step 2 of 6: System packages${RESET}"
echo

TOTAL_PKG=4; CUR=0

progress $((++CUR)) $TOTAL_PKG "Updating package lists"; echo
apt-get update -qq >> "$LOG_FILE" 2>&1 || warn "apt update had warnings (check $LOG_FILE)"

progress $((++CUR)) $TOTAL_PKG "Installing curl, git, openssl"; echo
apt-get install -y -qq curl git openssl ca-certificates gnupg lsb-release >> "$LOG_FILE" 2>&1

progress $((++CUR)) $TOTAL_PKG "Installing Docker"; echo
if ! command -v docker &>/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg >> "$LOG_FILE" 2>&1
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq >> "$LOG_FILE" 2>&1
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        >> "$LOG_FILE" 2>&1
    systemctl enable --now docker >> "$LOG_FILE" 2>&1
    ok "Docker installed."
else
    ok "Docker already installed: $(docker --version | head -1)"
fi

progress $((++CUR)) $TOTAL_PKG "Installing UFW + hardening SSH"; echo
apt-get install -y -qq ufw >> "$LOG_FILE" 2>&1

# ── UFW rules ──
# The PDF uses "DENY ALL IN". We match that plus block direct internet from
# the container subnet. Docker's proxy-external network gives only Squid
# internet access, but UFW adds a host-level belt-and-suspenders layer.
ufw --force reset          >> "$LOG_FILE" 2>&1
ufw default deny incoming  >> "$LOG_FILE" 2>&1
ufw default deny outgoing  >> "$LOG_FILE" 2>&1   # Block direct outbound from containers

# Host needs: SSH + DNS + NTP (for the host OS itself)
ufw allow out 22/tcp       >> "$LOG_FILE" 2>&1   # SSH out (for git clone, etc.)
ufw allow out 53           >> "$LOG_FILE" 2>&1   # DNS
ufw allow out 123/udp      >> "$LOG_FILE" 2>&1   # NTP
ufw allow out 80/tcp       >> "$LOG_FILE" 2>&1   # HTTP (apt, Docker Hub)
ufw allow out 443/tcp      >> "$LOG_FILE" 2>&1   # HTTPS (apt, Docker Hub, Docker registry)

# Inbound: SSH from any, and HTTP/HTTPS if WordPress runs on this server
ufw allow in ssh           >> "$LOG_FILE" 2>&1
[[ -n "$WP_PATH" ]] && ufw allow in 80/tcp  >> "$LOG_FILE" 2>&1
[[ -n "$WP_PATH" ]] && ufw allow in 443/tcp >> "$LOG_FILE" 2>&1

# Allow container-to-container traffic (Docker bridge networks)
ufw allow in on docker0    >> "$LOG_FILE" 2>&1  || true
ufw allow out on docker0   >> "$LOG_FILE" 2>&1  || true

ufw --force enable         >> "$LOG_FILE" 2>&1
ok "Firewall configured (deny-all-in, deny-direct-outbound)."

# ── SSH hardening (matches PDF: key-only access) ──
SSHD="/etc/ssh/sshd_config"
if [[ -f "$SSHD" ]]; then
    # Disable password authentication (key only)
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/'  "$SSHD" >> "$LOG_FILE" 2>&1
    sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$SSHD" >> "$LOG_FILE" 2>&1
    sed -i 's/^#*UsePAM.*/UsePAM no/' "$SSHD" >> "$LOG_FILE" 2>&1
    # Make sure pubkey auth is on
    grep -q "^PubkeyAuthentication" "$SSHD" \
        || echo "PubkeyAuthentication yes" >> "$SSHD"
    systemctl reload sshd >> "$LOG_FILE" 2>&1 || true
    ok "SSH hardened: password login disabled (key-only)."
    warn "Ensure you have a working SSH key BEFORE closing this session."
else
    warn "Could not find $SSHD — SSH hardening skipped."
fi
echo

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Write configuration files
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Step 3 of 6: Writing configuration${RESET}"
echo

cd "$SCRIPT_DIR"

# Write .env
progress 1 3 "Writing .env"; echo
cat > .env << EOF
# Generated by install.sh on $(date)
# DO NOT COMMIT THIS FILE

ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
OPENAI_API_KEY=${OPENAI_API_KEY}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
GEMINI_API_KEY=${GEMINI_API_KEY}

DEFAULT_MODEL=${DEFAULT_MODEL}
FALLBACK_MODEL=${FALLBACK_MODEL}
MONTHLY_BUDGET_USD=${MONTHLY_BUDGET}

LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}

TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_ADMIN_USER_ID=${TELEGRAM_ADMIN_USER_ID}

WP_URL=${WP_URL}
WP_ADMIN_USER=${WP_ADMIN_USER}
WP_ADMIN_PASSWORD=${WP_ADMIN_PASSWORD}
WP_APP_PASSWORD=${WP_APP_PASSWORD}
WP_PATH=${WP_PATH}
BRIDGE_SECRET=${BRIDGE_SECRET}
EOF
chmod 600 .env
ok ".env written (permissions 600)."

# Ensure .gitignore includes .env
progress 2 3 "Updating .gitignore"; echo
if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
    echo ".env" >> .gitignore
fi
if ! grep -q "install.log" .gitignore 2>/dev/null; then
    echo "install.log" >> .gitignore
fi

# Create required directories
progress 3 3 "Creating directories"; echo
mkdir -p squid litellm agent telegram-bot openclaw-config wordpress-bridge-plugin
echo

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Build and pull Docker images
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Step 4 of 6: Building Docker images${RESET}"
echo "  This may take 3–8 minutes on first run. Please wait."
echo

cd "$SCRIPT_DIR"

TOTAL_IMG=3; CUR=0

progress $((++CUR)) $TOTAL_IMG "Pulling LiteLLM image"; echo
docker pull ghcr.io/berriai/litellm:main-stable >> "$LOG_FILE" 2>&1 \
    || warn "Failed to pull LiteLLM (check $LOG_FILE). Will try with compose."

progress $((++CUR)) $TOTAL_IMG "Pulling Squid image"; echo
docker pull ubuntu/squid:5.7-22.04_beta >> "$LOG_FILE" 2>&1 \
    || warn "Failed to pull Squid. Will try with compose."

progress $((++CUR)) $TOTAL_IMG "Building agent + bot images"; echo
docker compose build --no-cache >> "$LOG_FILE" 2>&1 \
    || die "Docker build failed. Check $LOG_FILE for details."
echo

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Start containers
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Step 5 of 6: Starting services${RESET}"
echo

cd "$SCRIPT_DIR"

say "Starting all containers..."
docker compose up -d >> "$LOG_FILE" 2>&1 \
    || die "docker compose up failed. Check $LOG_FILE"

echo "  Waiting for containers to become healthy..."
echo

SERVICES=("openclaw-squid" "openclaw-litellm" "openclaw-agent" "openclaw-bot")
TOTAL_SVC=${#SERVICES[@]}
MAX_WAIT=120
INTERVAL=5

all_healthy=false
for attempt in $(seq 1 $((MAX_WAIT / INTERVAL))); do
    healthy_count=0
    for svc in "${SERVICES[@]}"; do
        state=$(docker inspect --format='{{.State.Health.Status}}' "$svc" 2>/dev/null || echo "none")
        running=$(docker inspect --format='{{.State.Running}}' "$svc" 2>/dev/null || echo "false")
        if [[ "$state" == "healthy" ]] || [[ "$state" == "none" && "$running" == "true" ]]; then
            (( healthy_count++ ))
        fi
    done
    progress "$healthy_count" "$TOTAL_SVC" "Healthy containers"
    if [[ "$healthy_count" -eq "$TOTAL_SVC" ]]; then
        all_healthy=true
        echo
        break
    fi
    sleep "$INTERVAL"
done

if [[ "$all_healthy" != "true" ]]; then
    echo
    warn "Some containers may not be healthy yet. Check with: docker compose ps"
    warn "Full logs: docker compose logs"
fi

echo

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — WordPress bridge plugin
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Step 6 of 6: WordPress bridge plugin${RESET}"
echo

PLUGIN_FILE="$SCRIPT_DIR/wordpress-bridge-plugin/openclaw-wp-bridge.php"

if [[ -f "$PLUGIN_FILE" ]]; then
    if [[ -n "$WP_PATH" && -d "$WP_PATH/wp-content/plugins" ]]; then
        progress 1 2 "Copying bridge plugin to WordPress"; echo
        DEST="$WP_PATH/wp-content/plugins/openclaw-wp-bridge"
        mkdir -p "$DEST"
        cp "$PLUGIN_FILE" "$DEST/"
        # Set ownership to match WordPress files
        WP_OWNER=$(stat -c '%U' "$WP_PATH/wp-config.php" 2>/dev/null || echo "www-data")
        chown -R "$WP_OWNER:$WP_OWNER" "$DEST" 2>/dev/null || true
        ok "Bridge plugin copied to $DEST"

        progress 2 2 "Activating bridge plugin via WP-CLI"; echo
        if command -v wp &>/dev/null; then
            wp plugin activate openclaw-wp-bridge --path="$WP_PATH" --allow-root >> "$LOG_FILE" 2>&1 \
                && ok "Bridge plugin activated." \
                || warn "Could not auto-activate. Activate manually in WP Admin → Plugins."
        else
            warn "WP-CLI not on host. Activate 'OpenClaw Bridge' manually in WP Admin → Plugins."
        fi
    else
        warn "WordPress path not set or plugins dir not found."
        echo "  Manually install the plugin from: $PLUGIN_FILE"
        echo "  Then add to your .env: BRIDGE_SECRET=${BRIDGE_SECRET}"
    fi
else
    warn "Bridge plugin file not found at $PLUGIN_FILE"
fi

echo

# ─────────────────────────────────────────────────────────────────────────────
# Done!
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${GREEN}${BOLD}"
cat << 'EOF'
  ╔═══════════════════════════════════════╗
  ║          Installation Complete!        ║
  ╚═══════════════════════════════════════╝
EOF
echo -e "${RESET}"

echo -e "  ${BOLD}What to do next:${RESET}"
echo
echo "  1. Open Telegram and message your bot."
echo "  2. Send: /start"
echo "  3. Try: \"Show me all installed plugins\""
echo "  4. Try: \"Create a draft blog post about getting started with WordPress\""
echo
echo -e "  ${BOLD}Useful commands:${RESET}"
echo "    docker compose ps          — container status"
echo "    docker compose logs -f     — live logs"
echo "    docker compose restart     — restart all"
echo "    docker compose down        — stop all"
echo
echo -e "  ${BOLD}Bridge plugin secret (for manual config):${RESET}"
echo "    BRIDGE_SECRET=${BRIDGE_SECRET}"
echo
echo -e "  ${BOLD}Monthly budget:${RESET} \$${MONTHLY_BUDGET} (AI API costs)"
echo
if [[ -n "$WP_APP_PASSWORD" ]] || [[ -n "$WP_ADMIN_PASSWORD" ]]; then
    echo -e "  ${YELLOW}Tip:${RESET} Create a WordPress Application Password for better security:"
    echo "    WP Admin → Users → Your Profile → Application Passwords"
fi
echo
echo "  Full install log: $LOG_FILE"
echo
