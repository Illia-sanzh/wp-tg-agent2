FROM ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system deps: PHP (for WP-CLI), curl, python3
RUN apt-get update && apt-get install -y --no-install-recommends \
    php-cli \
    php-mysql \
    php-curl \
    php-xml \
    php-mbstring \
    php-zip \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    mysql-client \
    rsync \
    && rm -rf /var/lib/apt/lists/*

# Install WP-CLI
RUN curl -sS -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
    && chmod +x /usr/local/bin/wp \
    && wp --info --allow-root 2>/dev/null || true

# Python venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Force httpx to stay <=0.27.x: openai SDK reads HTTP_PROXY/HTTPS_PROXY and
# calls httpx.Client(proxies=...), an arg removed in httpx 0.28+. The explicit
# http_client in agent.py is the primary fix; this pin is belt-and-suspenders.
RUN pip install --no-cache-dir "httpx>=0.27.0,<0.28.0"

COPY agent.py .

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--worker-class", "gthread", "--workers", "1", "--threads", "4", "--timeout", "360", "--log-level", "info", "agent:app"]
