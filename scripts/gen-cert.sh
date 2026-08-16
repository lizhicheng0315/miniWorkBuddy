#!/usr/bin/env bash
# 生成自签 HTTPS 证书（开发/本地用）
set -e
mkdir -p certs
openssl req -x509 -newkey rsa:2048 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "[gen-cert] certs/server.crt / certs/server.key 生成完成"
echo "设置 TLS_ENABLED=true 后启动即启用 HTTPS"
