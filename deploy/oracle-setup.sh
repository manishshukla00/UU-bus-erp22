#!/usr/bin/env bash
# One-command setup of UU Bus ERP on an Ubuntu server (written for Oracle Cloud "Always Free"
# Ampere A1, works on any Ubuntu 22.04/24.04 VPS). Safe to run again: it updates in place.
#
#   sudo DOMAIN=bus.example.edu bash deploy/oracle-setup.sh
#
# DOMAIN is the web address students' phones open (QR codes point to it). Without a domain, use
# <public-ip>.sslip.io (for example 152.67.10.20.sslip.io): it points at the server for free and
# still gets a real HTTPS certificate.
#
# Result: Node 22 app on 127.0.0.1:3000 (systemd service "bus-erp", local SQLite database, instant
# live updates), Caddy in front with automatic HTTPS, the Oracle firewall opened for 80/443, and a
# nightly database backup kept for 14 days.
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. sudo DOMAIN=1.2.3.4.sslip.io bash deploy/oracle-setup.sh}"
REPO="${REPO:-https://github.com/manishshukla00/UU-bus-erp22.git}"
APP_DIR=/opt/uu-bus-erp
APP_USER=buserp

echo "==> Packages (Node.js 22, Caddy, git, sqlite3)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git sqlite3 debian-keyring debian-archive-keyring apt-transport-https iptables-persistent
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("Node 22.13+ needed, got "+process.version); process.exit(1) }'

echo "==> Oracle images block web traffic in the OS firewall: open 80 and 443"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true

echo "==> App user and code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build

echo "==> Configuration (.env)"
if [ ! -f .env ]; then
  cat > .env <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
BASE_URL=https://${DOMAIN}
TRUST_PROXY=1
COOKIE_SECURE=true
ENV
  chown "$APP_USER:$APP_USER" .env && chmod 600 .env
else
  sed -i "s#^BASE_URL=.*#BASE_URL=https://${DOMAIN}#" .env
fi
mkdir -p data && chown -R "$APP_USER:$APP_USER" data

echo "==> Service"
cat > /etc/systemd/system/bus-erp.service <<UNIT
[Unit]
Description=UU Bus ERP
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable bus-erp >/dev/null
systemctl restart bus-erp

echo "==> HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000 {
		# live updates (Server-Sent Events) must not be buffered
		flush_interval -1
	}
}
CADDY
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "==> Nightly backup at 01:30 India time (kept 14 days in ${APP_DIR}/data/backups)"
cat > /etc/cron.d/bus-erp-backup <<CRON
CRON_TZ=Asia/Kolkata
30 1 * * * ${APP_USER} cd ${APP_DIR} && /usr/bin/node --disable-warning=ExperimentalWarning scripts/backup.js >> data/backup.log 2>&1 && find data/backups -name 'bus-erp-*.sqlite' -mtime +14 -delete
CRON

sleep 2
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  echo "==> Done. Open https://${DOMAIN} (the certificate can take a minute the first time)."
  echo "    First run only: the admin password is in ${APP_DIR}/data/initial-admin.txt"
else
  echo "!! The app did not answer yet. Check: journalctl -u bus-erp -n 50"; exit 1
fi
