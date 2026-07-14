#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Detect the best IP to reach the host from the container.
# In Rootless Docker, host.docker.internal (172.17.0.1) often doesn't route correctly to 0.0.0.0.
# We try to find a global IP (LAN or VPN).
HOST_IP=$(ip -4 addr show scope global | grep inet | awk '{print $2}' | cut -d/ -f1 | head -n 1)

if [ -z "$HOST_IP" ]; then
    echo "Could not detect a global host IP. Falling back to 172.17.0.1"
    HOST_IP="172.17.0.1"
fi

echo "Detected Host IP: $HOST_IP"

bash "$SCRIPT_DIR/setup-ssl.sh"

# Remove existing container if it exists
docker rm -f solux-nginx 2>/dev/null || true

docker run -d \
  --name solux-nginx \
  -p 8080:8080 \
  -p 8443:8443 \
  -v "$ROOT_DIR/infra/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$ROOT_DIR/infra/ssl:/etc/nginx/ssl:ro" \
  --add-host host.docker.internal:"$HOST_IP" \
  --restart unless-stopped \
  nginx:alpine

echo "HTTPS proxy started. Access via https://localhost:8443 or your configured domain. Run dev with VITE_HMR_PROTOCOL=wss for HMR."
