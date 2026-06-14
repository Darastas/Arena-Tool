#!/usr/bin/env bash
# Arena Shop Monitor - 远程一键部署脚本（Ubuntu 20.04+）
#
# 使用方式（在云服务器以 root 身份执行）：
#   方式1（已 clone 仓库）：
#     cd /opt && git clone https://github.com/<你的用户名>/<仓库名>.git arena_shop_monitor
#     cd arena_shop_monitor && sudo bash deploy.sh
#
#   方式2（一行命令，从 GitHub 拉脚本直接跑）：
#     export REPO_URL="https://github.com/<你的用户名>/<仓库名>.git"
#     curl -fsSL https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/remote_install.sh | sudo -E bash
#
# 脚本会做：
#   1. 装 git python3 等依赖
#   2. 加 1GB swap（防 OOM）
#   3. clone/更新代码到 /opt/arena_shop_monitor
#   4. 建 venv + 装 pip 依赖
#   5. 交互问 SMTP 信息生成 config.yaml
#   6. 注册 systemd 服务并启动
#   7. 健康检查
set -euo pipefail

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
say()  { echo -e "${G}[install]${N} $*"; }
warn() { echo -e "${Y}[warn]${N}    $*"; }
err()  { echo -e "${R}[error]${N}   $*" >&2; }

[[ $EUID -eq 0 ]] || { err "请用 sudo 或 root 运行"; exit 1; }

REPO_URL="${REPO_URL:-}"
INSTALL_DIR="/opt/arena_shop_monitor"
SERVICE_NAME="arena-shop"

if [[ -z "$REPO_URL" ]]; then
    read -rp "GitHub 仓库 URL（如 https://github.com/darastas/arena-shop-monitor.git）: " REPO_URL
fi
[[ -n "$REPO_URL" ]] || { err "REPO_URL 为空"; exit 1; }

# ---------- 1. 系统依赖 ----------
say "===== 1/7 安装系统依赖 ====="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git python3 python3-pip python3-venv libgomp1 curl ca-certificates

# ---------- 2. swap ----------
say "===== 2/7 检查 swap ====="
if ! swapon --show | grep -q '/swapfile'; then
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    say "已创建 1GB swap"
else
    say "swap 已存在，跳过"
fi

# ---------- 3. clone/更新代码 ----------
say "===== 3/7 拉取代码 ====="
if [[ -d "$INSTALL_DIR/.git" ]]; then
    cd "$INSTALL_DIR"
    git fetch --all
    git reset --hard origin/main
    say "已更新到最新版本"
else
    # 私有仓库需要 PAT
    say "克隆 $REPO_URL 到 $INSTALL_DIR"
    if ! git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
        warn "克隆失败，可能是私有仓库需要 PAT"
        read -rp "GitHub 用户名: " GH_USER
        read -rsp "GitHub Personal Access Token（输入不显示）: " GH_TOKEN
        echo
        # 把 token 拼到 URL 里只用于一次 clone，不写入 git 配置
        AUTH_URL="${REPO_URL/https:\/\//https:\/\/${GH_USER}:${GH_TOKEN}@}"
        git clone "$AUTH_URL" "$INSTALL_DIR"
        # 改回不含密码的 origin
        cd "$INSTALL_DIR"
        git remote set-url origin "$REPO_URL"
    fi
fi
cd "$INSTALL_DIR/server"

# ---------- 4. venv + pip ----------
say "===== 4/7 安装 Python 依赖（清华源） ====="
if [[ ! -d .venv ]]; then
    python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
.venv/bin/pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# ---------- 5. 配置 ----------
say "===== 5/7 生成配置 ====="
if [[ -f config.yaml ]]; then
    warn "config.yaml 已存在，是否覆盖？[y/N]"
    read -r OVERWRITE
    [[ "$OVERWRITE" == "y" || "$OVERWRITE" == "Y" ]] || say "保留现有 config.yaml"
fi

if [[ ! -f config.yaml ]] || [[ "${OVERWRITE:-}" == "y" || "${OVERWRITE:-}" == "Y" ]]; then
    read -rp "163 邮箱地址: " MAIL_USER
    read -rsp "163 授权码（16位字母数字，输入不显示）: " MAIL_PASS
    echo
    read -rp "收件邮箱（默认与发件相同）: " MAIL_TO
    MAIL_TO=${MAIL_TO:-$MAIL_USER}
    read -rp "服务监听端口（默认 8848）: " SRV_PORT
    SRV_PORT=${SRV_PORT:-8848}

    AUTH_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n' | head -c 40)
    say "自动生成 AUTH_TOKEN（手机端 config.js 必须填这个）："
    echo -e "${Y}${AUTH_TOKEN}${N}"

    cat > config.yaml <<EOF
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
    chmod 600 config.yaml
fi

[[ -f wishlist.json ]] || cp wishlist.example.json wishlist.json
mkdir -p uploads logs

# ---------- 6. systemd ----------
say "===== 6/7 注册 systemd 服务 ====="
SRV_PORT_FROM_CFG=$(grep -E '^\s+port:' config.yaml | head -n1 | awk '{print $2}')

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

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow ${SRV_PORT_FROM_CFG}/tcp || true
fi

# ---------- 7. 健康检查 ----------
say "===== 7/7 健康检查 ====="
sleep 3
for i in $(seq 1 15); do
    if curl -fsS "http://127.0.0.1:${SRV_PORT_FROM_CFG}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if curl -fsS "http://127.0.0.1:${SRV_PORT_FROM_CFG}/health" | grep -q '"ok": true'; then
    say "/health 通过 ✓"
else
    err "/health 失败"
    err "查看日志：journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    exit 1
fi

PUB_IP=$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || echo "你的服务器公网IP")
TOKEN_FROM_CFG=$(grep auth_token config.yaml | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')

cat <<EOF

==================================================
${G}部署完成 ✓${N}

外网访问 (确保云厂商安全组放行了 TCP ${SRV_PORT_FROM_CFG}):
    http://${PUB_IP}:${SRV_PORT_FROM_CFG}/health

${Y}手机端 AutoJs6 的 config.js 必须改成：${N}
    SERVER_URL: "http://${PUB_IP}:${SRV_PORT_FROM_CFG}"
    AUTH_TOKEN: "${TOKEN_FROM_CFG}"

常用命令：
    sudo systemctl status ${SERVICE_NAME}        # 查状态
    sudo systemctl restart ${SERVICE_NAME}       # 重启
    sudo journalctl -u ${SERVICE_NAME} -f        # 实时日志
    tail -f ${INSTALL_DIR}/server/logs/server.log

更新代码（GitHub push 新版本后）：
    cd ${INSTALL_DIR} && sudo git pull && sudo systemctl restart ${SERVICE_NAME}

修改心愿单后热重载（不用重启服务）：
    curl -X POST http://127.0.0.1:${SRV_PORT_FROM_CFG}/reload_wishlist \\
         -H "X-Auth-Token: ${TOKEN_FROM_CFG}"
==================================================
EOF
