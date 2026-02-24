FROM ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# Install system deps: PHP (for WP-CLI), curl, Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    php-cli \
    php-mysql \
    php-curl \
    php-xml \
    php-mbstring \
    php-zip \
    php-gd \
    curl \
    ca-certificates \
    mysql-client \
    rsync \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install WP-CLI
RUN curl -sS -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
    && chmod +x /usr/local/bin/wp \
    && wp --info --allow-root 2>/dev/null || true

WORKDIR /app

# Install Node dependencies (production + dev for tsx)
COPY package.json package-lock.json* ./
RUN npm install

COPY agent.ts tsconfig.json ./

EXPOSE 8080

# tsx runs TypeScript directly — no separate compile step
CMD ["node", "node_modules/.bin/tsx", "agent.ts"]
