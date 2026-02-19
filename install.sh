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

# Dynamic step counter
CURRENT_STEP=0
TOTAL_STEPS=7   # adjusted below once we know if WP needs installing

nextstep() {
    CURRENT_STEP=$(( CURRENT_STEP + 1 ))
    echo
    echo -e "${BOLD}Step ${CURRENT_STEP} of ${TOTAL_STEPS}: $1${RESET}"
    echo
}

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

if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
    warn "This script is designed for Ubuntu. Proceeding anyway..."
fi

: > "$LOG_FILE"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Configuration
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Configuration"
echo "  Answer the questions below. Press Enter to accept defaults."
echo

# ── AI Provider ──────────────────────────────────────────────────────────────
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
       read -rsp "  OpenAI API key: "    OPENAI_API_KEY;    echo
       read -rsp "  DeepSeek API key: "  DEEPSEEK_API_KEY;  echo
       read -rsp "  Gemini API key: "    GEMINI_API_KEY;    echo
       if [[ -n "$ANTHROPIC_API_KEY" ]]; then   DEFAULT_MODEL="claude-sonnet-4-6"
       elif [[ -n "$OPENAI_API_KEY" ]];   then  DEFAULT_MODEL="gpt-4o"
       elif [[ -n "$DEEPSEEK_API_KEY" ]]; then  DEFAULT_MODEL="deepseek-chat"
       elif [[ -n "$GEMINI_API_KEY" ]];   then  DEFAULT_MODEL="gemini-2.0-flash"
       else die "No API key entered."; fi ;;
    *) die "Invalid choice." ;;
esac

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

# ── WordPress detection ───────────────────────────────────────────────────────
echo
echo -e "  ${BOLD}WordPress${RESET}"
echo

# Variables — all get filled in by one of the three paths below
WP_INSTALL=false     # true  → we will install WordPress from scratch
WP_REMOTE=false      # true  → WordPress lives on a different server
WP_PATH=""           # local filesystem path (empty for remote)
WP_URL=""
WP_DOMAIN=""
WP_ADMIN_USER="admin"
WP_ADMIN_PASSWORD=""
WP_APP_PASSWORD=""   # filled in later (Step 7) via WP-CLI
WP_TITLE="My WordPress Site"
WP_ADMIN_EMAIL=""
WP_DB_NAME=""
WP_DB_USER=""
WP_DB_PASS=""

# Scan common paths for an existing installation
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

    # Try to read site URL without WP-CLI (WP-CLI isn't installed yet at this point)
    DETECTED_URL=""
    DETECTED_URL=$(grep -oP "define\s*\(\s*'(WP_HOME|WP_SITEURL)'\s*,\s*'\K[^']+" \
        "${FOUND_WP_PATH}/wp-config.php" 2>/dev/null | head -1 || true)

    read -rp "  Use this installation? [Y/n]: " use_existing
    use_existing="${use_existing:-Y}"

    if [[ "$use_existing" =~ ^[Yy]$ ]]; then
        WP_PATH="$FOUND_WP_PATH"

        if [[ -n "$DETECTED_URL" ]]; then
            echo "  Site URL: $DETECTED_URL"
            read -rp "  Is this correct? [Y/n]: " url_ok
            if [[ "${url_ok:-Y}" =~ ^[Yy]$ ]]; then
                WP_URL="$DETECTED_URL"
            else
                read -rp "  WordPress URL: " WP_URL
                WP_URL="${WP_URL%/}"
            fi
        else
            read -rp "  WordPress URL (e.g. https://mysite.com): " WP_URL
            WP_URL="${WP_URL%/}"
        fi

        read -rp "  Admin username [default=admin]: " WP_ADMIN_USER
        WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"
        read -rsp "  Admin password: " WP_ADMIN_PASSWORD; echo
        [[ -z "$WP_ADMIN_PASSWORD" ]] && die "Admin password is required."
    else
        FOUND_WP_PATH=""   # user declined, fall through to install/remote
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
        # ── Path B: Fresh install ────────────────────────────────────────────
        WP_INSTALL=true
        WP_PATH="/var/www/html"

        read -rp "  Domain name for this site (e.g. mysite.com): " WP_DOMAIN
        [[ -z "$WP_DOMAIN" ]] && die "Domain name is required."
        # Strip protocol prefix if user typed it
        WP_DOMAIN="${WP_DOMAIN#http://}"
        WP_DOMAIN="${WP_DOMAIN#https://}"
        WP_DOMAIN="${WP_DOMAIN%/}"
        WP_URL="http://${WP_DOMAIN}"

        read -rp "  Site title [default=My WordPress Site]: " WP_TITLE
        WP_TITLE="${WP_TITLE:-My WordPress Site}"

        read -rp "  Admin username [default=admin]: " WP_ADMIN_USER
        WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"

        read -rp "  Admin email: " WP_ADMIN_EMAIL
        [[ -z "$WP_ADMIN_EMAIL" ]] && die "Admin email is required."

        read -rsp "  Admin password (leave blank to auto-generate): " WP_ADMIN_PASSWORD; echo
        if [[ -z "$WP_ADMIN_PASSWORD" ]]; then
            WP_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 18)"
            warn "Auto-generated admin password — shown again in the final summary."
        fi

        # Auto-generate database credentials (user never needs to see these)
        WP_DB_NAME="wp_$(openssl rand -hex 4)"
        WP_DB_USER="wpuser_$(openssl rand -hex 4)"
        WP_DB_PASS="$(openssl rand -hex 24)"

    else
        # ── Path C: Remote WordPress ─────────────────────────────────────────
        WP_REMOTE=true

        read -rp "  WordPress URL (e.g. https://mysite.com): " WP_URL
        [[ -z "$WP_URL" ]] && die "WordPress URL is required."
        WP_URL="${WP_URL%/}"

        read -rp "  Admin username [default=admin]: " WP_ADMIN_USER
        WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"

        echo "  Tip: use an Application Password (WP Admin → Users → Profile → Application Passwords)"
        read -rsp "  Admin password or Application Password: " WP_ADMIN_PASSWORD; echo
        [[ -z "$WP_ADMIN_PASSWORD" ]] && die "Password is required."
    fi
fi

# Adjust total step count now that we know whether WP needs installing
[[ "$WP_INSTALL" == "true" ]] && TOTAL_STEPS=7 || TOTAL_STEPS=6

# Generate internal secrets
LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
BRIDGE_SECRET="$(openssl rand -hex 32)"

echo
ok "Configuration collected."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — System packages
# ─────────────────────────────────────────────────────────────────────────────
nextstep "System packages"

TOTAL_PKG=5; CUR=0

progress $((++CUR)) $TOTAL_PKG "Updating package lists"; echo
apt-get update -qq >> "$LOG_FILE" 2>&1 || warn "apt update had warnings (check $LOG_FILE)"

progress $((++CUR)) $TOTAL_PKG "Installing curl, git, openssl"; echo
apt-get install -y -qq curl git openssl ca-certificates gnupg lsb-release \
    >> "$LOG_FILE" 2>&1

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
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin >> "$LOG_FILE" 2>&1
    systemctl enable --now docker >> "$LOG_FILE" 2>&1
    ok "Docker installed."
else
    ok "Docker already installed: $(docker --version | head -1)"
fi

progress $((++CUR)) $TOTAL_PKG "Installing WP-CLI"; echo
if ! command -v wp &>/dev/null; then
    curl -fsSL \
        https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
        -o /usr/local/bin/wp >> "$LOG_FILE" 2>&1
    chmod +x /usr/local/bin/wp
    ok "WP-CLI installed: $(wp --version --allow-root 2>/dev/null | head -1)"
else
    ok "WP-CLI already installed: $(wp --version --allow-root 2>/dev/null | head -1)"
fi

progress $((++CUR)) $TOTAL_PKG "Installing UFW + hardening SSH"; echo
apt-get install -y -qq ufw >> "$LOG_FILE" 2>&1

# ── UFW firewall ──────────────────────────────────────────────────────────────
# NOTE: Docker bypasses UFW via iptables. Container isolation is enforced by
# Docker's internal:true network flag (agent-internal network), NOT by UFW.
# UFW here protects the host OS; Docker handles its own container egress.
ufw --force reset         >> "$LOG_FILE" 2>&1
ufw default deny incoming >> "$LOG_FILE" 2>&1
ufw default deny outgoing >> "$LOG_FILE" 2>&1

ufw allow out 22/tcp      >> "$LOG_FILE" 2>&1   # SSH (git, maintenance)
ufw allow out 53          >> "$LOG_FILE" 2>&1   # DNS
ufw allow out 123/udp     >> "$LOG_FILE" 2>&1   # NTP
ufw allow out 80/tcp      >> "$LOG_FILE" 2>&1   # HTTP (apt, Docker Hub)
ufw allow out 443/tcp     >> "$LOG_FILE" 2>&1   # HTTPS

ufw allow in ssh          >> "$LOG_FILE" 2>&1

# Allow HTTP/HTTPS in if WordPress is hosted locally
if [[ -n "$WP_PATH" ]] || [[ "$WP_INSTALL" == "true" ]]; then
    ufw allow in 80/tcp   >> "$LOG_FILE" 2>&1
    ufw allow in 443/tcp  >> "$LOG_FILE" 2>&1
fi

# Allow Docker bridge traffic (inter-container communication)
ufw allow in on docker0   >> "$LOG_FILE" 2>&1 || true
ufw allow out on docker0  >> "$LOG_FILE" 2>&1 || true

ufw --force enable        >> "$LOG_FILE" 2>&1
ok "Firewall configured (deny-all-in, deny-direct-outbound)."

# ── SSH hardening ─────────────────────────────────────────────────────────────
SSHD="/etc/ssh/sshd_config"
if [[ -f "$SSHD" ]]; then
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/'           "$SSHD"
    sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$SSHD"
    sed -i 's/^#*UsePAM.*/UsePAM no/'                                           "$SSHD"
    grep -q "^PubkeyAuthentication" "$SSHD" \
        || echo "PubkeyAuthentication yes" >> "$SSHD"
    systemctl reload sshd >> "$LOG_FILE" 2>&1 || true
    ok "SSH hardened: password login disabled (key-only)."
    warn "Ensure you have a working SSH key BEFORE closing this session."
else
    warn "sshd_config not found — SSH hardening skipped."
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Install WordPress (only if WP_INSTALL=true)
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$WP_INSTALL" == "true" ]]; then
    nextstep "Installing WordPress (Nginx + PHP + MariaDB + WP)"

    TOTAL_WP=6; CUR=0

    # ── 3a: Nginx ────────────────────────────────────────────────────────────
    progress $((++CUR)) $TOTAL_WP "Installing Nginx"; echo
    apt-get install -y -qq nginx >> "$LOG_FILE" 2>&1
    systemctl enable nginx       >> "$LOG_FILE" 2>&1

    # ── 3b: PHP 8.3 ──────────────────────────────────────────────────────────
    progress $((++CUR)) $TOTAL_WP "Installing PHP 8.3 + extensions"; echo
    apt-get install -y -qq \
        php8.3-fpm php8.3-mysql php8.3-curl php8.3-gd php8.3-mbstring \
        php8.3-xml php8.3-xmlrpc php8.3-soap php8.3-intl php8.3-zip \
        php8.3-bcmath php8.3-imagick >> "$LOG_FILE" 2>&1
    systemctl enable php8.3-fpm >> "$LOG_FILE" 2>&1

    # ── 3c: MariaDB ───────────────────────────────────────────────────────────
    progress $((++CUR)) $TOTAL_WP "Installing MariaDB"; echo
    apt-get install -y -qq mariadb-server >> "$LOG_FILE" 2>&1
    systemctl enable mariadb >> "$LOG_FILE" 2>&1
    systemctl start  mariadb >> "$LOG_FILE" 2>&1

    # ── 3d: Create database ───────────────────────────────────────────────────
    progress $((++CUR)) $TOTAL_WP "Creating WordPress database"; echo
    mysql -u root >> "$LOG_FILE" 2>&1 << SQLEOF
CREATE DATABASE IF NOT EXISTS \`${WP_DB_NAME}\`
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${WP_DB_USER}'@'localhost'
    IDENTIFIED BY '${WP_DB_PASS}';
GRANT ALL PRIVILEGES ON \`${WP_DB_NAME}\`.* TO '${WP_DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQLEOF
    ok "Database '${WP_DB_NAME}' ready."

    # ── 3e: Nginx vhost ───────────────────────────────────────────────────────
    progress $((++CUR)) $TOTAL_WP "Configuring Nginx vhost"; echo
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
        expires max;
        log_not_found off;
    }
}
NGINXCONF

    ln -sf /etc/nginx/sites-available/wordpress /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    nginx -t >> "$LOG_FILE" 2>&1 \
        && systemctl reload nginx >> "$LOG_FILE" 2>&1 \
        || warn "Nginx config test failed — check $LOG_FILE"
    ok "Nginx configured for ${WP_DOMAIN}."

    # ── 3f: Download + install WordPress ─────────────────────────────────────
    progress $((++CUR)) $TOTAL_WP "Downloading and installing WordPress"; echo

    wp core download \
        --path="$WP_PATH" \
        --allow-root >> "$LOG_FILE" 2>&1

    wp config create \
        --dbname="$WP_DB_NAME" \
        --dbuser="$WP_DB_USER" \
        --dbpass="$WP_DB_PASS" \
        --dbhost="localhost" \
        --path="$WP_PATH" \
        --allow-root >> "$LOG_FILE" 2>&1

    wp core install \
        --url="$WP_URL" \
        --title="$WP_TITLE" \
        --admin_user="$WP_ADMIN_USER" \
        --admin_password="$WP_ADMIN_PASSWORD" \
        --admin_email="$WP_ADMIN_EMAIL" \
        --skip-email \
        --path="$WP_PATH" \
        --allow-root >> "$LOG_FILE" 2>&1

    # Ensure web server owns the files
    chown -R www-data:www-data "$WP_PATH"
    ok "WordPress installed at $WP_PATH"

fi  # end WP_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 or 4 — Write configuration files
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Writing configuration"

cd "$SCRIPT_DIR"

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

progress 2 3 "Updating .gitignore"; echo
grep -q "^\.env$"      .gitignore 2>/dev/null || echo ".env"        >> .gitignore
grep -q "install\.log" .gitignore 2>/dev/null || echo "install.log" >> .gitignore

progress 3 3 "Creating directories"; echo
mkdir -p squid litellm agent telegram-bot openclaw-config wordpress-bridge-plugin

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 or 5 — Build and pull Docker images
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Building Docker images"
echo "  This may take 3–8 minutes on first run. Please wait."

cd "$SCRIPT_DIR"
TOTAL_IMG=3; CUR=0

progress $((++CUR)) $TOTAL_IMG "Pulling LiteLLM image"; echo
docker pull ghcr.io/berriai/litellm:main-stable >> "$LOG_FILE" 2>&1 \
    || warn "Failed to pull LiteLLM (check $LOG_FILE). Will retry with compose."

progress $((++CUR)) $TOTAL_IMG "Pulling Squid image"; echo
docker pull ubuntu/squid:5.7-22.04_beta >> "$LOG_FILE" 2>&1 \
    || warn "Failed to pull Squid. Will retry with compose."

progress $((++CUR)) $TOTAL_IMG "Building agent + bot images"; echo
docker compose build --no-cache >> "$LOG_FILE" 2>&1 \
    || die "Docker build failed. Check $LOG_FILE for details."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 or 6 — Start containers
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Starting services"

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
for attempt in $(seq 1 $(( MAX_WAIT / INTERVAL ))); do
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
    warn "Some containers may not be healthy yet. Check: docker compose ps"
    warn "Full logs: docker compose logs"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 or 7 — Bridge plugin + Application Password
# ─────────────────────────────────────────────────────────────────────────────
nextstep "Bridge plugin & finalizing"

PLUGIN_FILE="$SCRIPT_DIR/wordpress-bridge-plugin/openclaw-wp-bridge.php"

if [[ "$WP_REMOTE" == "true" ]]; then
    # ── Remote site: manual instructions ─────────────────────────────────────
    warn "WordPress is on a remote server. Install the bridge plugin manually:"
    echo "  1. Copy wordpress-bridge-plugin/openclaw-wp-bridge.php to the remote server"
    echo "     (into wp-content/plugins/openclaw-wp-bridge/)"
    echo "  2. Activate it in WP Admin → Plugins"
    echo "  3. Go to Settings → OpenClaw Bridge"
    echo "  4. Paste this secret:  BRIDGE_SECRET=${BRIDGE_SECRET}"
    echo
    echo "  Alternatively, create an Application Password:"
    echo "  WP Admin → Users → Your Profile → Application Passwords"
    echo "  Name it 'OpenClaw Agent' and paste the password in .env as WP_APP_PASSWORD"

elif [[ -n "$WP_PATH" ]] && [[ -f "$PLUGIN_FILE" ]]; then
    # ── Local site: copy + activate + create App Password ────────────────────
    TOTAL_LOCAL=3; CUR=0

    progress $((++CUR)) $TOTAL_LOCAL "Copying bridge plugin"; echo
    DEST="$WP_PATH/wp-content/plugins/openclaw-wp-bridge"
    mkdir -p "$DEST"
    cp "$PLUGIN_FILE" "$DEST/"
    WP_OWNER=$(stat -c '%U' "$WP_PATH/wp-config.php" 2>/dev/null || echo "www-data")
    chown -R "$WP_OWNER:$WP_OWNER" "$DEST" 2>/dev/null || true
    ok "Bridge plugin copied to $DEST"

    progress $((++CUR)) $TOTAL_LOCAL "Activating bridge plugin"; echo
    if command -v wp &>/dev/null; then
        wp plugin activate openclaw-wp-bridge \
            --path="$WP_PATH" --allow-root >> "$LOG_FILE" 2>&1 \
            && ok "Bridge plugin activated." \
            || warn "Could not auto-activate. Activate manually in WP Admin → Plugins."

        # Store BRIDGE_SECRET in plugin's option (saves the user from Settings UI)
        wp option update openclaw_bridge_secret "$BRIDGE_SECRET" \
            --path="$WP_PATH" --allow-root >> "$LOG_FILE" 2>&1 || true
    else
        warn "WP-CLI not on PATH. Activate 'OpenClaw Bridge' manually in WP Admin → Plugins."
    fi

    progress $((++CUR)) $TOTAL_LOCAL "Creating Application Password for agent"; echo
    if command -v wp &>/dev/null; then
        # Application Passwords require WordPress 5.6+
        WP_VER=$(wp core version --path="$WP_PATH" --allow-root 2>/dev/null || echo "0")
        WP_MAJOR=$(echo "$WP_VER" | cut -d. -f1)
        if [[ "$WP_MAJOR" -ge 5 ]]; then
            RAW_APP_PASS=$(wp user application-password create \
                "$WP_ADMIN_USER" "OpenClaw Agent" \
                --path="$WP_PATH" --allow-root --porcelain 2>/dev/null || echo "")
            if [[ -n "$RAW_APP_PASS" ]]; then
                WP_APP_PASSWORD="$RAW_APP_PASS"
                # Update .env in-place (use | as delimiter; password won't contain |)
                sed -i "s|^WP_APP_PASSWORD=.*|WP_APP_PASSWORD=${WP_APP_PASSWORD}|" .env
                ok "Application Password created for '${WP_ADMIN_USER}'."
            else
                warn "Could not create Application Password. Agent will use admin password."
            fi
        else
            warn "WordPress < 5.6 — Application Passwords not supported. Agent will use admin password."
        fi
    fi

else
    warn "Bridge plugin file not found at $PLUGIN_FILE"
    warn "Run git pull to get the latest plugin file, then manually install."
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
    echo "  Admin pass:    ${WP_ADMIN_PASSWORD}  ← save this!"
[[ -n "$WP_APP_PASSWORD" ]] && \
    echo "  App password:  ${WP_APP_PASSWORD}  ← agent uses this"
echo

echo -e "  ${BOLD}━━━ Telegram Bot ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  Message your bot, then:"
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
    echo "  Database credentials (stored in .env, not needed day-to-day):"
    echo "    DB name:  $WP_DB_NAME"
    echo "    DB user:  $WP_DB_USER"
    echo "    DB pass:  $WP_DB_PASS"
fi
echo

if [[ "$WP_INSTALL" == "true" ]]; then
    echo -e "  ${YELLOW}Next step — add HTTPS:${RESET}"
    echo "    apt install certbot python3-certbot-nginx -y"
    echo "    certbot --nginx -d ${WP_DOMAIN} -d www.${WP_DOMAIN}"
    echo
fi

echo "  Full install log: $LOG_FILE"
echo
