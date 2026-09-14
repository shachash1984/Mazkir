#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 ufw unattended-upgrades
systemctl enable --now docker
ufw allow OpenSSH
ufw default deny incoming
ufw --force enable
install -d -m 700 /opt/mazkir
install -d -o 1000 -g 1000 -m 700 /opt/mazkir/backups
docker --version
docker compose version
