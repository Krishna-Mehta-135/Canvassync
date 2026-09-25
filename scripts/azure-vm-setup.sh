#!/usr/bin/env bash
# One-time bootstrap for each Azure VM (Ubuntu 24.04, x86 or ARM).
#   ssh azureuser@<vm> 'bash -s' < scripts/azure-vm-setup.sh
# Installs Docker + compose plugin, adds 2 GB swap (VMs have 1 GB RAM),
# creates /opt/canvas + /opt/knowdex and the shared `edge` Docker network.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf >/dev/null
  sudo sysctl --system >/dev/null
fi

sudo mkdir -p /opt/canvas /opt/knowdex
sudo chown "$USER:$USER" /opt/canvas /opt/knowdex

# Shared network so Caddy (CanvasSync project) can reach the Knowdex containers.
sudo docker network inspect edge >/dev/null 2>&1 || sudo docker network create edge >/dev/null

echo "Done. Log out and back in so the docker group applies."
