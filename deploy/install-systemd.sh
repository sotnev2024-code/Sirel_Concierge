#!/usr/bin/env bash
# Установка systemd-сервиса sirel-bots.
# Использование:
#   sudo bash deploy/install-systemd.sh
#   sudo bash deploy/install-systemd.sh /root/Sirel_Concierge root
#   sudo bash deploy/install-systemd.sh /home/ubuntu/Sirel_Concierge ubuntu
set -euo pipefail

PROJECT="${1:-/root/Sirel_Concierge}"
SERVICE_USER="${2:-root}"
SERVICE_SRC="${PROJECT}/deploy/sirel-bots.service"
SERVICE_DST="/etc/systemd/system/sirel-bots.service"

if [[ ! -f "$SERVICE_SRC" ]]; then
  echo "Не найден $SERVICE_SRC — укажите путь к клону:"
  echo "  sudo bash deploy/install-systemd.sh /path/to/Sirel_Concierge [user]"
  exit 1
fi

if [[ ! -x "${PROJECT}/.venv/bin/python3" ]]; then
  echo "Нет ${PROJECT}/.venv/bin/python3 — создайте venv: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

cp -f "$SERVICE_SRC" "$SERVICE_DST"
sed -i "s|/root/Sirel_Concierge|${PROJECT}|g" "$SERVICE_DST"
sed -i "s/^User=.*/User=${SERVICE_USER}/" "$SERVICE_DST"

systemctl daemon-reload
systemctl enable sirel-bots.service
systemctl restart sirel-bots.service
echo "Готово. Статус:"
systemctl --no-pager status sirel-bots.service || true
echo ""
echo "Логи: journalctl -u sirel-bots.service -f"
