#!/usr/bin/env bash
# Update the app on the server to the latest code on GitHub (keeps the database and .env):
#   sudo bash /opt/uu-bus-erp/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/uu-bus-erp
APP_USER=buserp
cd "$APP_DIR"
sudo -u "$APP_USER" node --disable-warning=ExperimentalWarning scripts/backup.js
sudo -u "$APP_USER" git pull --ff-only
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
systemctl restart bus-erp
sleep 2
curl -fsS http://127.0.0.1:3000/api/health && echo && echo "Updated."
