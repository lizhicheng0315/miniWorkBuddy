@echo off
REM 生成自签 HTTPS 证书（开发/本地用）
REM 需要 openssl；Windows 10/11 通常自带，或用 Git Bash / WSL
setlocal
if not exist certs mkdir certs
echo [gen-cert] 正在生成自签证书到 certs\server.crt / server.key ...
openssl req -x509 -newkey rsa:2048 -keyout certs\server.key -out certs\server.crt -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
if errorlevel 1 (
  echo [gen-cert] 失败：请确认已安装 openssl 并加入 PATH
  exit /b 1
)
echo [gen-cert] 完成。可以通过设置 TLS_ENABLED=true 启用 HTTPS
endlocal
