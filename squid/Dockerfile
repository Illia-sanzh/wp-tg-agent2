FROM ubuntu:24.04

# Install Squid from Ubuntu's standard repo (no broken image tags to depend on)
RUN DEBIAN_FRONTEND=noninteractive apt-get update -qq \
    && apt-get install -y --no-install-recommends squid \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/squid /var/spool/squid \
    && chown -R proxy:proxy /var/log/squid /var/spool/squid

EXPOSE 3128

# -N  = no daemon mode (stay in foreground, required for Docker)
# -d1 = minimal startup messages to stdout
CMD ["squid", "-N", "-d1"]
