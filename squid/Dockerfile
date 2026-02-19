FROM ubuntu:24.04

# Install Squid from Ubuntu's standard repo (no broken image tags to depend on)
RUN DEBIAN_FRONTEND=noninteractive apt-get update -qq \
    && apt-get install -y --no-install-recommends squid \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/squid /var/spool/squid \
    && chown -R proxy:proxy /var/log/squid /var/spool/squid

EXPOSE 3128

# squid -z  initialises the swap/cache directories on first run (required by Squid 6).
# squid -N  keeps the process in the foreground (required for Docker).
# squid -d1 prints minimal startup messages to stdout for docker logs visibility.
# squid -z writes a PID file then exits; the main squid process would see it
# and refuse to start ("already running"). Remove it before exec-ing the real process.
CMD ["sh", "-c", "squid -z 2>/dev/null; rm -f /run/squid.pid; exec squid -N -d1"]
