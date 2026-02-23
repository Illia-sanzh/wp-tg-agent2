#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WordPress Telegram Agent — Installer
# Tested on: Ubuntu 24.04 (VPS)
# Usage:     sudo bash install.sh
#
# What this script does:
#   1. Asks a few simple questions (API key, Telegram tokens, domain)
#   2. Auto-detects if WordPress is already installed
#   3. Installs the full LEMP stack + WordPress if needed
#   4. Deploys the AI agent stack (Docker containers)
#   5. Prints a summary with all credentials at the end
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/install.log"

# ── Output helpers ────────────────────────────────────────────────────────────
say()  { echo -e "${CYAN}${BOLD}▶${RESET} $*"; }
ok()   { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
die()  { echo -e "${RED}✗ ERROR:${RESET} $*" >&2; exit 1; }
log()  { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE"; }

# _pkg <name>  — true if the package is already installed (dpkg knows about it)
_pkg() { dpkg -s "$1" &>/dev/null 2>&1; }

# _stop_apt_services  — kill Ubuntu's background update daemons so they
# release the dpkg lock immediately. On a fresh VPS unattended-upgrades
# runs apt-get upgrade right after first boot and holds the lock for minutes.
# Stopping it is safe — the user is about to do their own installs anyway.
_stop_apt_services() {
    systemctl stop unattended-upgrades apt-daily.service apt-daily-upgrade.service \
        2>/dev/null || true
    systemctl kill --kill-who=all apt-daily.service apt-daily-upgrade.service \
        2>/dev/null || true
}

# _apt  — wrapper for apt-get that:
#   • adds DEBIAN_FRONTEND=noninteractive (no interactive prompts)
#   • uses DPkg::Lock::Timeout=60 so apt itself waits up to 60 s for the lock
#     instead of failing immediately (replaces the old _wait_apt fuser loop)
_apt() { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 "$@"; }

# ── task <label> <cmd> [args...] ──────────────────────────────────────────────
# Runs cmd in the background. Shows a spinner on ONE line (overwriting it each
# frame). When the command finishes, replaces the spinner line with ✓ or ✗.
# Nothing stacks — completed tasks show as a clean "✓  label" line.
task() {
    local label="$1"; shift
    log "TASK: $label — $*"
    "$@" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${BLUE}%s${RESET}  %-60s" "${frames:$(( i++ % ${#frames} )):1}" "$label"
        sleep 0.1
    done
    if wait "$pid"; then
        printf "\r  ${GREEN}✓${RESET}  %-60s\n" "$label"
    else
        printf "\r  ${RED}✗${RESET}  %-60s\n" "$label"
        return 1
    fi
}

# ── Step header ───────────────────────────────────────────────────────────────
CURRENT_STEP=0
TOTAL_STEPS=7   # adjusted after Step 1 once we know if WP needs installing

nextstep() {
    CURRENT_STEP=$(( CURRENT_STEP + 1 ))
    echo
    echo -e "${BOLD}Step ${CURRENT_STEP} of ${TOTAL_STEPS}: $1${RESET}"
    echo
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

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Please run as root: sudo bash install.sh"
grep -qi "ubuntu" /etc/os-release 2>/dev/null \
    || warn "This script is designed for Ubuntu. Proceeding anyway..."

: > "$LOG_FILE"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Configuration (interactive, no spinners needed)
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Configuration"
echo "  Answer the questions below. Press Enter to accept defaults."
echo

# ── AI Provider ───────────────────────────────────────────────────────────────
echo -e "  ${BOLD}AI Provider${RESET}"
echo "    1) Anthropic Claude (recommended, best results)"
echo "    2) OpenAI ChatGPT"
echo "    3) DeepSeek (cheap, good for code)"
echo "    4) Google Gemini"
echo "    5) Multiple providers"
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
       read -rsp "  OpenAI API key: "    OPENAI_API_KEY;    echo
       read -rsp "  DeepSeek API key: "  DEEPSEEK_API_KEY;  echo
       read -rsp "  Gemini API key: "    GEMINI_API_KEY;    echo
       if   [[ -n "$ANTHROPIC_API_KEY" ]]; then DEFAULT_MODEL="claude-sonnet-4-6"
       elif [[ -n "$OPENAI_API_KEY" ]];   then DEFAULT_MODEL="gpt-4o"
       elif [[ -n "$DEEPSEEK_API_KEY" ]]; then DEFAULT_MODEL="deepseek-chat"
       elif [[ -n "$GEMINI_API_KEY" ]];   then DEFAULT_MODEL="gemini-2.0-flash"
       else die "No API key entered."; fi ;;
    *) die "Invalid choice." ;;
esac

# ── OpenRouter (optional) ─────────────────────────────────────────────────────
echo
echo -e "  ${BOLD}OpenRouter${RESET}  ${CYAN}(optional)${RESET}"
echo "  One key gives you access to ALL LLMs — Llama, Mistral, Gemma, DeepSeek-R1, and more."
echo "  Get a free key at: https://openrouter.ai/keys   Leave blank to skip."
echo
OPENROUTER_API_KEY=""
read -rsp "  OpenRouter API key: " OPENROUTER_API_KEY; echo
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    ok "OpenRouter enabled — use any model with /model openrouter/<slug> in Telegram."
else
    ok "Skipping OpenRouter (add OPENROUTER_API_KEY to .env later to enable)."
fi

# ── Voice recognition ─────────────────────────────────────────────────────────
echo
echo -e "  ${BOLD}Voice Recognition${RESET}  ${CYAN}(Whisper)${RESET}"
echo "  Lets users send voice notes to the bot — transcribed automatically."
echo "  Requires an OpenAI API key."
echo
WHISPER_ENABLED=false
if [[ -n "$OPENAI_API_KEY" ]]; then
    read -rp "  Enable voice recognition? [Y/n]: " _voice; _voice="${_voice:-Y}"
    [[ "$_voice" =~ ^[Yy]$ ]] && WHISPER_ENABLED=true && ok "Voice recognition enabled."
else
    warn "You don't have an OpenAI key set. Voice recognition won't work without one."
    read -rsp "  Enter OpenAI API key now to enable voice recognition (blank to skip): " _voicekey; echo
    if [[ -n "$_voicekey" ]]; then
        OPENAI_API_KEY="$_voicekey"
        WHISPER_ENABLED=true
        ok "OpenAI key set — voice recognition enabled."
    else
        ok "Skipping voice recognition (add OPENAI_API_KEY to .env later to enable it)."
    fi
fi

# ── Smart model routing ───────────────────────────────────────────────────────
echo
echo -e "  ${BOLD}Smart Model Routing${RESET}  ${CYAN}(optional)${RESET}"
echo "  Automatically picks the cheapest model that handles each task:"
echo "    ⚡ Fast    — simple lookups  (\"show all plugins\", \"what's the site title?\")"
echo "    ◆ Standard — typical tasks   (create posts, install plugins, WooCommerce)"
echo "    🧠 Smart   — complex work    (debug, audit, multi-step analysis)"
echo
AUTO_ROUTING="false"
FAST_MODEL=""
SMART_MODEL=""
read -rp "  Enable smart model routing? [y/N]: " _routing; _routing="${_routing:-N}"
if [[ "$_routing" =~ ^[Yy]$ ]]; then
    AUTO_ROUTING="true"
    # Pick sensible defaults based on the selected provider
    case "$DEFAULT_MODEL" in
        claude-*)  _def_fast="claude-haiku-4-5"  ; _def_smart="claude-opus-4-6"   ;;
        gpt-*)     _def_fast="gpt-4o-mini"        ; _def_smart="gpt-4o"            ;;
        deepseek*) _def_fast="deepseek-chat"      ; _def_smart="deepseek-reasoner" ;;
        gemini*)   _def_fast="gemini-2.0-flash"   ; _def_smart="gemini-2.0-flash"  ;;
        *)         _def_fast="claude-haiku-4-5"   ; _def_smart="claude-opus-4-6"   ;;
    esac
    echo
    echo "  Recommended defaults for your provider:"
    echo "    Fast:     $_def_fast"
    echo "    Standard: $DEFAULT_MODEL  (already set above)"
    echo "    Smart:    $_def_smart"
    echo
    read -rp "  Fast model   [default=$_def_fast]:  " _fast_in
    read -rp "  Smart model  [default=$_def_smart]: " _smart_in
    FAST_MODEL="${_fast_in:-$_def_fast}"
    SMART_MODEL="${_smart_in:-$_def_smart}"
    ok "Smart routing on: ⚡ $FAST_MODEL | ◆ $DEFAULT_MODEL | 🧠 $SMART_MODEL"
else
    ok "Smart routing off — all requests use: $DEFAULT_MODEL"
fi

echo
read -rp "  Monthly AI spend limit in USD [default=20]: \$" MONTHLY_BUDGET
MONTHLY_BUDGET="${MONTHLY_BUDGET:-20}"

# ── Telegram ──────────────────────────────────────────────────────────────────
echo
echo -e "  ${BOLD}Telegram Bot${RESET}"
read -rp "  Bot token (from @BotFather): " TELEGRAM_BOT_TOKEN
[[ -z "$TELEGRAM_BOT_TOKEN" ]] && die "Bot token is required."
read -rp "  Your Telegram user ID (from @userinfobot): " TELEGRAM_ADMIN_USER_ID
[[ -z "$TELEGRAM_ADMIN_USER_ID" ]] && die "User ID is required."

# ── WordPress ─────────────────────────────────────────────────────────────────
echo
echo -e "  ${BOLD}WordPress${RESET}"
echo

WP_INSTALL=false   # true  → we install WordPress from scratch
WP_REMOTE=false    # true  → WordPress lives on a different server
WP_PATH=""
WP_URL=""
WP_DOMAIN=""
WP_ADMIN_USER="admin"
WP_ADMIN_PASSWORD=""
WP_APP_PASSWORD=""
WP_TITLE="My WordPress Site"
WP_ADMIN_EMAIL=""
WP_DB_NAME=""
WP_DB_USER=""
WP_DB_PASS=""

# Scan common paths for an existing WordPress install
FOUND_WP_PATH=""
for try_path in /var/www/html /var/www/wordpress /srv/www/html /opt/wordpress; do
    if [[ -f "${try_path}/wp-config.php" ]]; then
        FOUND_WP_PATH="$try_path"
        break
    fi
done

if [[ -n "$FOUND_WP_PATH" ]]; then
    # ── Path A: WordPress already on this server ──────────────────────────────
    ok "WordPress detected at ${FOUND_WP_PATH}"

    DETECTED_URL=""
    DETECTED_URL=$(grep -oP "define\s*\(\s*'(WP_HOME|WP_SITEURL)'\s*,\s*'\K[^']+" \
        "${FOUND_WP_PATH}/wp-config.php" 2>/dev/null | head -1 || true)

    read -rp "  Use this installation? [Y/n]: " use_existing
    use_existing="${use_existing:-Y}"

    if [[ "$use_existing" =~ ^[Yy]$ ]]; then
        WP_PATH="$FOUND_WP_PATH"

        if [[ -n "$DETECTED_URL" ]]; then
            echo "  Detected URL: $DETECTED_URL"
            read -rp "  Is this correct? [Y/n]: " url_ok
            [[ "${url_ok:-Y}" =~ ^[Yy]$ ]] && WP_URL="$DETECTED_URL" || {
                read -rp "  WordPress URL: " WP_URL; WP_URL="${WP_URL%/}"; }
        else
            read -rp "  WordPress URL (e.g. https://mysite.com): " WP_URL
            WP_URL="${WP_URL%/}"
        fi

        read -rp "  Admin username [default=admin]: " WP_ADMIN_USER
        WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"
        read -rsp "  Admin password: " WP_ADMIN_PASSWORD; echo
        [[ -z "$WP_ADMIN_PASSWORD" ]] && die "Admin password is required."
    else
        FOUND_WP_PATH=""
    fi
fi

if [[ -z "$FOUND_WP_PATH" ]]; then
    echo "  No existing WordPress installation detected on this server."
    echo
    echo "    1) Install WordPress on this server  (recommended for a fresh VPS)"
    echo "    2) Connect to WordPress on a different server  (remote site)"
    echo
    read -rp "  Choose [1-2, default=1]: " wp_choice
    wp_choice="${wp_choice:-1}"

    if [[ "$wp_choice" == "1" ]]; then
        # ── Path B: Fresh install ─────────────────────────────────────────────
        WP_INSTALL=true
        WP_PATH="/var/www/html"

        read -rp "  Domain name for this site (e.g. mysite.com): " WP_DOMAIN
        [[ -z "$WP_DOMAIN" ]] && die "Domain name is required."
        WP_DOMAIN="${WP_DOMAIN#http://}"; WP_DOMAIN="${WP_DOMAIN#https://}"
        WP_DOMAIN="${WP_DOMAIN%/}"
        WP_URL="http://${WP_DOMAIN}"

        read -rp "  Site title [default=My WordPress Site]: " WP_TITLE
        WP_TITLE="${WP_TITLE:-My WordPress Site}"

        read -rp "  Admin username [default=admin]: " WP_ADMIN_USER
        WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"

        read -rp "  Admin email: " WP_ADMIN_EMAIL
        [[ -z "$WP_ADMIN_EMAIL" ]] && die "Admin email is required."

        read -rsp "  Admin password (blank to auto-generate): " WP_ADMIN_PASSWORD; echo
        if [[ -z "$WP_ADMIN_PASSWORD" ]]; then
            WP_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 18)"
            warn "Auto-generated admin password — shown again in the final summary."
        fi

        WP_DB_NAME="wp_$(openssl rand -hex 4)"
        WP_DB_USER="wpuser_$(openssl rand -hex 4)"
        WP_DB_PASS="$(openssl rand -hex 24)"

    else
        # ── Path C: Remote WordPress ──────────────────────────────────────────
        WP_REMOTE=true
        read -rp "  WordPress URL (e.g. https://mysite.com): " WP_URL
        [[ -z "$WP_URL" ]] && die "WordPress URL is required."
        WP_URL="${WP_URL%/}"
        read -rp "  Admin username [default=admin]: " WP_ADMIN_USER
        WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"
        echo "  Tip: use an Application Password (WP Admin → Users → Profile)"
        read -rsp "  Admin password or Application Password: " WP_ADMIN_PASSWORD; echo
        [[ -z "$WP_ADMIN_PASSWORD" ]] && die "Password is required."
    fi
fi

# Adjust step count now that we know whether WP needs installing
[[ "$WP_INSTALL" == "true" ]] && TOTAL_STEPS=7 || TOTAL_STEPS=6

LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
BRIDGE_SECRET="$(openssl rand -hex 32)"
MCP_ENV_SECRET="$(openssl rand -hex 32)"

echo
ok "Configuration collected."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — System packages
# ─────────────────────────────────────────────────────────────────────────────
nextstep "System packages"

_apt_update() {
    _stop_apt_services   # kill background apt daemons before touching the lock
    _apt update -qq
}
task "Updating package lists" _apt_update

_install_base_pkgs() {
    local missing=()
    for p in curl git openssl ca-certificates gnupg lsb-release; do
        _pkg "$p" || missing+=("$p")
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
        log "Base packages already installed — skipping."
        return 0
    fi
    log "Installing missing packages: ${missing[*]}"
    _apt install -y -qq "${missing[@]}"
}
task "Installing curl, git, openssl" _install_base_pkgs

# Docker — wrapped in a function because it's multi-step
_install_docker() {
    if command -v docker &>/dev/null; then return 0; fi
    # Remove any partial state from a previous failed run (stale key / broken list
    # will cause apt-get update to fail on every subsequent run)
    rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.gpg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
    _apt update -qq
    local docker_missing=()
    for p in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; do
        _pkg "$p" || docker_missing+=("$p")
    done
    if [[ ${#docker_missing[@]} -gt 0 ]]; then
        _apt install -y -qq "${docker_missing[@]}"
    fi
    systemctl enable --now docker
}
task "Installing Docker" _install_docker

# WP-CLI on the host (needed for WordPress setup and bridge plugin)
_install_wpcli() {
    command -v wp &>/dev/null && return 0
    curl -fsSL \
        https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
        -o /usr/local/bin/wp
    chmod +x /usr/local/bin/wp
}
task "Installing WP-CLI" _install_wpcli

# UFW + SSH hardening — wrapped so task() runs it atomically
_setup_security() {
    _pkg ufw || _apt install -y -qq ufw

    ufw --force reset
    ufw default deny incoming
    ufw default deny outgoing
    # NOTE: Docker bypasses UFW via iptables. Container isolation is enforced
    # by Docker's internal:true network (agent-internal), not by UFW.
    # UFW here protects the host OS only.
    ufw allow out 22/tcp    # SSH (git, admin)
    ufw allow out 53        # DNS
    ufw allow out 123/udp   # NTP
    ufw allow out 80/tcp    # HTTP (apt, Docker Hub)
    ufw allow out 443/tcp   # HTTPS

    ufw allow in ssh

    # HTTP/HTTPS in only if WordPress is hosted here
    if [[ -n "$WP_PATH" ]] || [[ "$WP_INSTALL" == "true" ]]; then
        ufw allow in 80/tcp
        ufw allow in 443/tcp
    fi

    ufw allow in on docker0  || true
    ufw allow out on docker0 || true

    # Allow the Docker agent subnet to reach MariaDB on the host.
    # The agent-internal network uses 172.28.0.0/16 (fixed in docker-compose.yml).
    # This is needed because the agent container runs WP-CLI which connects to
    # MariaDB via host.docker.internal — traffic goes through the custom bridge,
    # NOT docker0, so "allow in on docker0" alone is not sufficient.
    ufw allow in from 172.28.0.0/16 to any port 3306 proto tcp \
        comment 'MariaDB from Docker agent subnet' || true

    ufw --force enable

    # SSH: key-only auth
    local sshd="/etc/ssh/sshd_config"
    [[ -f "$sshd" ]] || return 0
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/'           "$sshd"
    sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$sshd"
    sed -i 's/^#*UsePAM.*/UsePAM no/'                                           "$sshd"
    grep -q "^PubkeyAuthentication" "$sshd" || echo "PubkeyAuthentication yes" >> "$sshd"
    systemctl reload sshd || true
}
task "Configuring firewall and SSH" _setup_security
warn "SSH hardened — ensure you have a working SSH key before closing this session."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Install WordPress (only when WP_INSTALL=true)
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$WP_INSTALL" == "true" ]]; then
    nextstep "Installing WordPress (Nginx + PHP 8.3 + MariaDB)"

    _install_nginx() {
        _pkg nginx || _apt install -y -qq nginx
        systemctl enable nginx
    }
    task "Installing Nginx" _install_nginx

    _install_php() {
        local missing=()
        for p in php8.3-fpm php8.3-mysql php8.3-curl php8.3-gd php8.3-mbstring \
                 php8.3-xml php8.3-xmlrpc php8.3-soap php8.3-intl php8.3-zip \
                 php8.3-bcmath php8.3-imagick; do
            _pkg "$p" || missing+=("$p")
        done
        [[ ${#missing[@]} -eq 0 ]] && return 0
        _apt install -y -qq "${missing[@]}"
    }
    task "Installing PHP 8.3 + extensions" _install_php

    _install_mariadb() {
        _pkg mariadb-server || _apt install -y -qq mariadb-server
    }
    task "Installing MariaDB" _install_mariadb

    task "Starting MariaDB" \
        systemctl enable --now mariadb

    _create_db() {
        mysql -u root << SQLEOF
CREATE DATABASE IF NOT EXISTS \`${WP_DB_NAME}\`
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${WP_DB_USER}'@'localhost'
    IDENTIFIED BY '${WP_DB_PASS}';
GRANT ALL PRIVILEGES ON \`${WP_DB_NAME}\`.* TO '${WP_DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQLEOF
    }
    task "Creating WordPress database" _create_db

    _configure_nginx() {
        mkdir -p "$WP_PATH"
        chown -R www-data:www-data "$WP_PATH"
        cat > /etc/nginx/sites-available/wordpress << NGINXCONF
server {
    listen 80;
    listen [::]:80;
    server_name ${WP_DOMAIN} www.${WP_DOMAIN};
    root ${WP_PATH};
    index index.php index.html;
    client_max_body_size 64M;

    location / {
        try_files \$uri \$uri/ /index.php?\$args;
    }
    location ~ \.php\$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        include fastcgi_params;
    }
    location ~ /\.ht { deny all; }
    location = /favicon.ico { log_not_found off; access_log off; }
    location = /robots.txt  { log_not_found off; access_log off; allow all; }
    location ~* \.(css|gif|ico|jpeg|jpg|js|png|woff|woff2)\$ {
        expires max; log_not_found off;
    }
}
NGINXCONF
        ln -sf /etc/nginx/sites-available/wordpress /etc/nginx/sites-enabled/
        rm -f /etc/nginx/sites-enabled/default
        nginx -t
        systemctl reload nginx
    }
    task "Configuring Nginx vhost for ${WP_DOMAIN}" _configure_nginx

    _install_wp() {
        wp core download \
            --path="$WP_PATH" --allow-root
        wp config create \
            --dbname="$WP_DB_NAME" \
            --dbuser="$WP_DB_USER" \
            --dbpass="$WP_DB_PASS" \
            --dbhost=localhost \
            --path="$WP_PATH" --allow-root
        wp core install \
            --url="$WP_URL" \
            --title="$WP_TITLE" \
            --admin_user="$WP_ADMIN_USER" \
            --admin_password="$WP_ADMIN_PASSWORD" \
            --admin_email="$WP_ADMIN_EMAIL" \
            --skip-email \
            --path="$WP_PATH" --allow-root
        chown -R www-data:www-data "$WP_PATH"
    }
    task "Downloading and installing WordPress" _install_wp

fi  # end WP_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 or 4 — Write configuration files
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Writing configuration"

cd "$SCRIPT_DIR"

_write_env() {
    cat > .env << EOF
# Generated by install.sh on $(date)
# DO NOT COMMIT THIS FILE

ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
OPENAI_API_KEY=${OPENAI_API_KEY}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
GEMINI_API_KEY=${GEMINI_API_KEY}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}

DEFAULT_MODEL=${DEFAULT_MODEL}
FALLBACK_MODEL=${FALLBACK_MODEL}
MONTHLY_BUDGET_USD=${MONTHLY_BUDGET}

AUTO_ROUTING=${AUTO_ROUTING}
FAST_MODEL=${FAST_MODEL}
SMART_MODEL=${SMART_MODEL}

LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}

TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_ADMIN_USER_ID=${TELEGRAM_ADMIN_USER_ID}

WP_URL=${WP_URL}
WP_ADMIN_USER=${WP_ADMIN_USER}
WP_ADMIN_PASSWORD=${WP_ADMIN_PASSWORD}
WP_APP_PASSWORD=${WP_APP_PASSWORD}
WP_PATH=${WP_PATH}
BRIDGE_SECRET=${BRIDGE_SECRET}
MCP_ENV_SECRET=${MCP_ENV_SECRET}
EOF
    chmod 600 .env
}
task "Writing .env" _write_env

_update_gitignore() {
    grep -q "^\.env$"      .gitignore 2>/dev/null || echo ".env"        >> .gitignore
    grep -q "install\.log" .gitignore 2>/dev/null || echo "install.log" >> .gitignore
}
task "Updating .gitignore" _update_gitignore

task "Creating directories" \
    mkdir -p squid litellm agent telegram-bot openclaw-config wordpress-bridge-plugin

# When WordPress is local, MariaDB defaults to listening on localhost only.
# The agent runs in a Docker container and reaches the host via host.docker.internal.
# This task:
#   1. Opens MariaDB to listen on all interfaces (UFW already allows 172.28.0.0/16:3306)
#   2. Grants the WP DB user from the Docker agent-internal subnet (172.28.0.0/16)
#   3. Makes wp-config.php read DB_HOST from the WP_DB_HOST env var (set in docker-compose)
_bridge_mysql_to_agent() {
    [[ "$WP_REMOTE" == "true" ]] && return 0
    [[ -z "$WP_PATH" ]]          && return 0

    # Only run if MariaDB/MySQL is managed locally
    systemctl is-active --quiet mariadb 2>/dev/null \
        || systemctl is-active --quiet mysql 2>/dev/null \
        || { log "MariaDB not running locally — skipping bridge setup"; return 0; }

    # Read DB credentials — from install vars (fresh install) or wp-config.php (existing)
    local db_name db_user db_pass current_host
    if [[ "$WP_INSTALL" == "true" ]]; then
        db_name="$WP_DB_NAME"
        db_user="$WP_DB_USER"
        db_pass="$WP_DB_PASS"
    else
        db_name=$(wp config get DB_NAME     --path="$WP_PATH" --allow-root 2>/dev/null || echo "")
        db_user=$(wp config get DB_USER     --path="$WP_PATH" --allow-root 2>/dev/null || echo "")
        db_pass=$(wp config get DB_PASSWORD --path="$WP_PATH" --allow-root 2>/dev/null || echo "")
        [[ -z "$db_name" || -z "$db_user" ]] \
            && { log "Cannot read DB credentials from wp-config.php — skipping"; return 1; }
    fi

    # Skip if DB_HOST is already pointing somewhere non-local (managed DB, remote host, etc.)
    current_host=$(wp config get DB_HOST --path="$WP_PATH" --allow-root 2>/dev/null || echo "localhost")
    if [[ "$current_host" != "localhost" && "$current_host" != "127.0.0.1" ]]; then
        log "DB_HOST='$current_host' is already non-local — no bridge needed"
        return 0
    fi

    # 1. Make MariaDB listen on 0.0.0.0 so it accepts TCP from the Docker subnet.
    #    UFW is configured above to block port 3306 from the internet.
    for conf in \
        /etc/mysql/mariadb.conf.d/50-server.cnf \
        /etc/mysql/conf.d/mysql.cnf \
        /etc/mysql/my.cnf \
        /etc/mysql/mysql.conf.d/mysqld.cnf; do
        [[ -f "$conf" ]] && sed -i 's/^bind-address\s*=.*/bind-address = 0.0.0.0/' "$conf"
    done
    systemctl restart mariadb 2>/dev/null || systemctl restart mysql 2>/dev/null || true
    sleep 2

    # 2. Grant the WP DB user from the agent-internal Docker subnet (172.28.0.0/16)
    mysql -u root << SQLEOF
GRANT ALL PRIVILEGES ON \`${db_name}\`.* TO '${db_user}'@'172.28.%' IDENTIFIED BY '${db_pass}';
FLUSH PRIVILEGES;
SQLEOF

    # 3. Make DB_HOST in wp-config.php read from the WP_DB_HOST env var when set,
    #    falling back to localhost. This lets the Docker agent container use
    #    host.docker.internal while PHP-FPM on the host keeps using localhost (socket).
    sed -i -E \
        "s|define\(\s*'DB_HOST'\s*,\s*'[^']+'\s*\)|define('DB_HOST', getenv('WP_DB_HOST') ?: 'localhost')|" \
        "$WP_PATH/wp-config.php" 2>/dev/null || true
}
task "Bridging MariaDB to agent Docker network" _bridge_mysql_to_agent \
    || warn "MySQL bridge setup failed — WP-CLI in the agent container may not reach the DB."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 or 5 — Build Docker images
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Building Docker images  (3–8 min on first run)"

# Pull LiteLLM separately so failures don't kill the build step
task "Pulling LiteLLM image" \
    docker pull ghcr.io/berriai/litellm:main-stable \
    || warn "LiteLLM pull failed — compose will retry at startup."

# Squid is now built from ./squid/Dockerfile, no separate pull needed.
# Agent + bot + squid all built together.
task "Building agent, bot, and Squid images" \
    docker compose build --no-cache \
    || die "Docker build failed. Check $LOG_FILE"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 or 6 — Start containers
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Starting services"

task "Starting all containers" \
    docker compose up -d \
    || die "docker compose up failed. Check $LOG_FILE"

# ── Wait for healthy with a single updating line ───────────────────────────────
echo
SERVICES=("openclaw-squid" "openclaw-litellm" "openclaw-agent" "openclaw-bot")
TOTAL_SVC=${#SERVICES[@]}
MAX_WAIT=120
INTERVAL=5
FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
FRAME_I=0

all_healthy=false
for attempt in $(seq 1 $(( MAX_WAIT / INTERVAL ))); do
    healthy_count=0
    for svc in "${SERVICES[@]}"; do
        state=$(docker inspect --format='{{.State.Health.Status}}' "$svc" 2>/dev/null || echo "none")
        running=$(docker inspect --format='{{.State.Running}}' "$svc" 2>/dev/null || echo "false")
        if [[ "$state" == "healthy" ]] || [[ "$state" == "none" && "$running" == "true" ]]; then
            (( healthy_count++ )) || true
        fi
    done
    if [[ "$healthy_count" -eq "$TOTAL_SVC" ]]; then
        printf "\r  ${GREEN}✓${RESET}  All %d containers running%-40s\n" "$TOTAL_SVC" ""
        all_healthy=true
        break
    fi
    printf "\r  ${BLUE}%s${RESET}  Containers starting: %d of %d ready...%-20s" \
        "${FRAMES:$(( FRAME_I++ % ${#FRAMES} )):1}" "$healthy_count" "$TOTAL_SVC" ""
    sleep "$INTERVAL"
done

if [[ "$all_healthy" != "true" ]]; then
    printf "\r  ${YELLOW}⚠${RESET}  Some containers still starting — check: docker compose ps%-10s\n" ""
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 or 7 — Bridge plugin + Application Password
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Bridge plugin and finalizing"

PLUGIN_FILE="$SCRIPT_DIR/wordpress-bridge-plugin/openclaw-wp-bridge.php"

if [[ "$WP_REMOTE" == "true" ]]; then
    warn "WordPress is on a remote server. Install the bridge plugin manually:"
    echo "    1. Copy wordpress-bridge-plugin/openclaw-wp-bridge.php to the remote server"
    echo "       into: wp-content/plugins/openclaw-wp-bridge/"
    echo "    2. Activate in WP Admin → Plugins"
    echo "    3. Settings → OpenClaw Bridge → paste secret below"

elif [[ -n "$WP_PATH" ]] && [[ -f "$PLUGIN_FILE" ]]; then

    _copy_plugin() {
        local dest="$WP_PATH/wp-content/plugins/openclaw-wp-bridge"
        mkdir -p "$dest"
        cp "$PLUGIN_FILE" "$dest/"
        local owner
        owner=$(stat -c '%U' "$WP_PATH/wp-config.php" 2>/dev/null || echo "www-data")
        chown -R "$owner:$owner" "$dest" 2>/dev/null || true
    }
    task "Copying bridge plugin" _copy_plugin

    _activate_plugin() {
        wp plugin activate openclaw-wp-bridge \
            --path="$WP_PATH" --allow-root
        # Pre-populate the secret so the user doesn't need to visit the Settings UI
        wp option update openclaw_bridge_secret "$BRIDGE_SECRET" \
            --path="$WP_PATH" --allow-root || true
    }
    task "Activating bridge plugin" _activate_plugin \
        || warn "Auto-activate failed — activate 'OpenClaw Bridge' manually in WP Admin → Plugins."

    _create_app_password() {
        command -v wp &>/dev/null || return 1
        local ver major
        ver=$(wp core version --path="$WP_PATH" --allow-root 2>/dev/null || echo "0")
        major=$(echo "$ver" | cut -d. -f1)
        [[ "$major" -ge 5 ]] || return 1
        local raw
        raw=$(wp user application-password create \
            "$WP_ADMIN_USER" "OpenClaw Agent" \
            --path="$WP_PATH" --allow-root --porcelain 2>/dev/null || echo "")
        [[ -n "$raw" ]] || return 1
        WP_APP_PASSWORD="$raw"
        # Write back into .env (| is safe delimiter; password won't contain it)
        sed -i "s|^WP_APP_PASSWORD=.*|WP_APP_PASSWORD=${WP_APP_PASSWORD}|" \
            "$SCRIPT_DIR/.env"
    }
    task "Creating Application Password for agent" _create_app_password \
        || warn "App Password failed — agent will use admin password instead."

else
    warn "Bridge plugin file not found at $PLUGIN_FILE (run git pull?)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done!
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "${GREEN}${BOLD}"
cat << 'EOF'
  ╔═══════════════════════════════════════╗
  ║          Installation Complete!        ║
  ╚═══════════════════════════════════════╝
EOF
echo -e "${RESET}"

echo -e "  ${BOLD}━━━ WordPress ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  Site URL:      $WP_URL"
[[ -n "$WP_PATH" ]] && echo "  Admin panel:   ${WP_URL}/wp-admin"
echo "  Admin user:    $WP_ADMIN_USER"
[[ "$WP_INSTALL" == "true" ]] && \
    echo -e "  Admin pass:    ${YELLOW}${WP_ADMIN_PASSWORD}${RESET}  ← save this!"
[[ -n "$WP_APP_PASSWORD" ]] && \
    echo "  App password:  ${WP_APP_PASSWORD}  ← agent uses this"
echo

echo -e "  ${BOLD}━━━ Features ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [[ "$WHISPER_ENABLED" == "true" ]]; then
    echo "  Voice recognition:  ✓ enabled  (send voice notes to the bot)"
else
    echo "  Voice recognition:  ✗ disabled  (add OPENAI_API_KEY to .env to enable)"
fi
if [[ "$AUTO_ROUTING" == "true" ]]; then
    echo "  Smart routing:      ✓ enabled"
    echo "    ⚡ Fast:     $FAST_MODEL"
    echo "    ◆ Standard: $DEFAULT_MODEL"
    echo "    🧠 Smart:   $SMART_MODEL"
else
    echo "  Smart routing:      ✗ off  (all requests use $DEFAULT_MODEL)"
fi
[[ -n "$OPENROUTER_API_KEY" ]] \
    && echo "  OpenRouter:         ✓ enabled  (use /model openrouter/<slug> in Telegram)" \
    || echo "  OpenRouter:         ✗ disabled  (add OPENROUTER_API_KEY to .env to enable)"
echo

echo -e "  ${BOLD}━━━ Telegram Bot ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  Open Telegram, message your bot, then send:"
echo "    /start"
echo "    Show me all installed plugins"
echo "    Create a draft blog post about getting started with WordPress"
echo

echo -e "  ${BOLD}━━━ Management ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "    docker compose ps          — container status"
echo "    docker compose logs -f     — live logs"
echo "    docker compose restart     — restart all"
echo "    docker compose down        — stop all"
echo

echo -e "  ${BOLD}━━━ Security ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  Monthly budget:  \$${MONTHLY_BUDGET} (AI API spend cap)"
echo "  Bridge secret:   ${BRIDGE_SECRET}"
if [[ "$WP_INSTALL" == "true" ]]; then
    echo
    echo "  Database (auto-generated, stored in .env):"
    echo "    DB name:  $WP_DB_NAME"
    echo "    DB user:  $WP_DB_USER"
    echo "    DB pass:  $WP_DB_PASS"
    echo
    echo -e "  ${YELLOW}Next:${RESET} add HTTPS with Let's Encrypt:"
    echo "    apt install certbot python3-certbot-nginx -y"
    echo "    certbot --nginx -d ${WP_DOMAIN} -d www.${WP_DOMAIN}"
fi
echo
echo "  Full install log: $LOG_FILE"
echo
