#!/usr/bin/env bash
# Arena Shop Monitor 一键部署脚本 (Ubuntu 20.04/22.04/24.04)
# 用法：
#   1. 把整个 arena_shop_monitor 目录上传到服务器（任何路径都可）
#   2. cd 到 arena_shop_monitor 目录
#   3. sudo bash deploy.sh
#
# 脚本会：
#   - 加 1GB swap（如未存在）
#   - 装 Python 与系统依赖
#   - 把项目复制到 /opt/arena_shop_monitor
#   - 建虚拟环境 + 装 pip 依赖（清华源）
#   - 交互生成 config.yaml（auth_token 自动随机生成）
#   - 预热 OCR 模型
#   - 注册 systemd 服务并启动
#   - 跑健康检查 + 自测一次上传
set -euo pipefail

# 颜色
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
say()  { echo -e "${G}[deploy]${N} $*"; }
warn() { echo -e "${Y}[warn]${N}   $*"; }
err()  { echo -e "${R}[error]${N}  $*" >&2; }

# 必须以 root 运行
if [[ $EUID -ne 0 ]]; then
    err "请用 sudo 或 root 运行：sudo bash deploy.sh"
    exit 1
fi

# 必须在源码目录（带 server/ 子目录）
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -d "$SRC_DIR/server" ]] || [[ ! -f "$SRC_DIR/server/app.py" ]]; then
    err "请在 arena_shop_monitor 目录下运行（应包含 server/app.py）"
    exit 1
fi

INSTALL_DIR="/opt/arena_shop_monitor"
SERVICE_NAME="arena-shop"

# ------------- 1. 交互输入 -------------
say "===== 步骤 1/8：收集配置 ====="
read -rp "你的 163 邮箱地址（如 xxx@163.com）: " MAIL_USER
read -rsp "163 授权码（16位字母数字，输入不显示）: " MAIL_PASS
echo
read -rp "收件邮箱（默认与发件相同：$MAIL_USER）: " MAIL_TO
MAIL_TO=${MAIL_TO:-$MAIL_USER}
read -rp "服务监听端口（默认 8848）: " SRV_PORT
SRV_PORT=${SRV_PORT:-8848}

# 自动生成 token
AUTH_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n' | head -c 40)
say "已自动生成 AUTH_TOKEN（手机端 config.js 必须填这个值）："
echo -e "${Y}${AUTH_TOKEN}${N}"
echo

# ------------- 2. swap -------------
say "===== 步骤 2/8：检查/创建 swap ====="
if swapon --show | grep -q '/swapfile'; then
    say "swap 已存在，跳过"
else
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    if ! grep -q '/swapfile' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
    say "已创建 1GB swap"
fi

# ------------- 3. 系统依赖 -------------
say "===== 步骤 3/8：安装系统依赖 ====="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-pip python3-venv libgomp1 libgl1 libglib2.0-0 curl ca-certificates

# ------------- 4. 复制源码 -------------
say "===== 步骤 4/8：复制源码到 $INSTALL_DIR ====="
mkdir -p "$INSTALL_DIR"
# 用 rsync 增量复制（首次就是全量），保留权限
if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete-excluded \
          --exclude='*.pyc' --exclude='__pycache__' \
          --exclude='.venv' --exclude='uploads' --exclude='logs' \
          "$SRC_DIR"/ "$INSTALL_DIR"/
else
    cp -r "$SRC_DIR"/. "$INSTALL_DIR"/
fi

# ------------- 5. Python 虚拟环境 -------------
say "===== 步骤 5/8：创建虚拟环境 + 装依赖（清华源）====="
cd "$INSTALL_DIR/server"
if [[ ! -d .venv ]]; then
    python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
.venv/bin/pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# ------------- 6. 写配置文件 -------------
say "===== 步骤 6/8：写入 config.yaml & wishlist.json ====="
cat > "$INSTALL_DIR/server/config.yaml" <<EOF
server:
  host: "0.0.0.0"
  port: ${SRV_PORT}
  auth_token: "${AUTH_TOKEN}"
  upload_dir: "uploads"
  log_dir: "logs"
  max_image_bytes: 8388608

ocr:
  subprocess_mode: true
  timeout: 90
  max_width: 1280

matcher:
  max_edit_distance: 2
  price_regex: '(\d{1,3}(?:[,，]\d{3})+|\d{4,8})'

smtp:
  host: "smtp.163.com"
  port: 465
  use_ssl: true
  username: "${MAIL_USER}"
  password: "${MAIL_PASS}"
  from_addr: "${MAIL_USER}"
  to_addrs:
    - "${MAIL_TO}"
  subject_prefix: "[暗区商店]"
  attach_image: true
EOF
chmod 600 "$INSTALL_DIR/server/config.yaml"   # 含密码，限权

# 心愿单：若已存在则保留，否则用示例
if [[ ! -f "$INSTALL_DIR/server/wishlist.json" ]]; then
    cp "$INSTALL_DIR/server/wishlist.example.json" "$INSTALL_DIR/server/wishlist.json"
fi

mkdir -p "$INSTALL_DIR/server/uploads" "$INSTALL_DIR/server/logs"

# ------------- 7. 预热 OCR 模型 + systemd -------------
say "===== 步骤 7/8：预热 OCR 模型（首次会下载约 14MB）====="
# 用一张 1x1 png 触发模型下载（rapidocr 启动时会拉取）
python3 - <<'PY'
import base64, pathlib
png = base64.b64decode(b'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=')
pathlib.Path('/tmp/__warm.png').write_bytes(png)
PY
"$INSTALL_DIR/server/.venv/bin/python" "$INSTALL_DIR/server/ocr_worker.py" /tmp/__warm.png >/dev/null 2>&1 || warn "OCR 预热返回非零（首次下载可能较慢，systemd 启动后会重试）"

say "===== 步骤 7/8：注册 systemd 服务 ====="
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Arena Shop Monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/server
ExecStart=${INSTALL_DIR}/server/.venv/bin/python app.py
Restart=on-failure
RestartSec=5
MemoryMax=1500M
StandardOutput=append:${INSTALL_DIR}/server/logs/stdout.log
StandardError=append:${INSTALL_DIR}/server/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

# 防火墙（ufw 启用时才放行）
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow ${SRV_PORT}/tcp || true
    say "已放行 ufw ${SRV_PORT}/tcp"
fi

# ------------- 8. 健康检查 + 自测上传 -------------
say "===== 步骤 8/8：健康检查 ====="
sleep 3
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:${SRV_PORT}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if curl -fsS "http://127.0.0.1:${SRV_PORT}/health" | grep -q '"ok": true'; then
    say "/health 通过 ✓"
else
    err "/health 失败，请查日志：journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    exit 1
fi

say "执行测试上传（不会发邮件，因为测试图不会命中心愿单）..."
curl -fsS -X POST "http://127.0.0.1:${SRV_PORT}/upload" \
     -H "X-Auth-Token: ${AUTH_TOKEN}" \
     -F "image=@/tmp/__warm.png" \
     -F "tab=selftest" \
     -F "token=${AUTH_TOKEN}" || warn "测试上传非 200，可能 OCR 还在初始化，可稍后手动重试"

PUB_IP=$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || echo "你的服务器公网IP")

cat <<EOF

==================================================
${G}部署完成 ✓${N}

服务状态：systemctl status ${SERVICE_NAME}
实时日志：journalctl -u ${SERVICE_NAME} -f
应用日志：tail -f ${INSTALL_DIR}/server/logs/server.log

外网访问（确保云厂商安全组放行了 TCP ${SRV_PORT}）：
    http://${PUB_IP}:${SRV_PORT}/health

${Y}手机端 AutoJs6 的 config.js 必须改成：${N}
    SERVER_URL: "http://${PUB_IP}:${SRV_PORT}"
    AUTH_TOKEN: "${AUTH_TOKEN}"

修改心愿单后热重载：
    curl -X POST http://127.0.0.1:${SRV_PORT}/reload_wishlist \\
         -H "X-Auth-Token: ${AUTH_TOKEN}"

修改 SMTP/端口等配置后重启：
    sudo systemctl restart ${SERVICE_NAME}
==================================================
EOF
