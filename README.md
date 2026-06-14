# Arena Shop Monitor 部署指南

> 暗区突围每日商店刷新自动监控 + 邮件提醒
>
> 架构：闲置安卓机 (AutoJs6) → 截图上传 → 2GB 云服务器 (Flask + RapidOCR) → 邮件

---

## 一、目录结构

```
arena_shop_monitor/
├── server/                       # 部署到云服务器
│   ├── app.py                    # Flask 主程序
│   ├── ocr_worker.py             # OCR 子进程（用完即退）
│   ├── matcher.py                # 心愿单模糊匹配
│   ├── notifier.py               # SMTP 邮件
│   ├── config.example.yaml       # 配置模板
│   ├── wishlist.example.json     # 心愿单示例
│   └── requirements.txt
└── autojs/                       # 部署到手机 AutoJs6
    ├── main.js                   # 主流程
    └── config.js                 # 手机端配置
```

---

## 二、云服务器部署（2GB 内存友好）

### 2.1 准备

建议系统：Ubuntu 22.04 / Debian 12。
建议给系统加 1GB swap，防止 OCR 子进程偶发峰值 OOM：

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.2 安装 Python 与依赖

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv libgomp1
cd /opt
sudo git clone <你的仓库> arena_shop_monitor   # 或直接 scp 上传
cd arena_shop_monitor/server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> RapidOCR 首次运行会下载 ~14MB ONNX 模型，建议先在服务器执行一次 `python ocr_worker.py 任意图.png` 让它把模型下载完。

### 2.3 配置

```bash
cp config.example.yaml config.yaml
cp wishlist.example.json wishlist.json
nano config.yaml      # 填入 auth_token、SMTP 账号密码、收件人
nano wishlist.json    # 改成你想监控的物品
```

QQ 邮箱授权码获取：QQ 邮箱网页版 → 设置 → 账号 → 开启 SMTP → 生成授权码（不是邮箱密码！）。

### 2.4 防火墙放行端口

```bash
sudo ufw allow 8848/tcp    # 或在云厂商安全组放行
```

### 2.5 systemd 守护

新建 `/etc/systemd/system/arena-shop.service`：

```ini
[Unit]
Description=Arena Shop Monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/arena_shop_monitor/server
ExecStart=/opt/arena_shop_monitor/server/.venv/bin/python app.py
Restart=on-failure
# 限制内存（防止 OCR 异常吃光）
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arena-shop
sudo systemctl status arena-shop
curl http://127.0.0.1:8848/health   # 应返回 {"ok": true, ...}
```

### 2.6 修改心愿单后热重载

```bash
curl -X POST http://127.0.0.1:8848/reload_wishlist \
     -H "X-Auth-Token: 你的token"
```

---

## 三、手机端部署（AutoJs6）

### 3.1 安装

下载 AutoJs6（开源，GitHub: SuperMonster003/AutoJs6）。安装后授予以下权限（缺一不可）：
- 无障碍服务（设置-无障碍-AutoJs6 开启）
- 显示在其他应用上层（悬浮窗）
- 截图权限（首次运行 captureScreen 时弹出）
- 自启动 + 后台保活（小米/华为/OPPO 务必关闭"省电策略"）
- 忽略电池优化

### 3.2 上传脚本

把 `autojs/main.js` 与 `autojs/config.js` 放到手机 `/sdcard/脚本/arena_shop/` 目录下。

修改 `config.js`：
- `SERVER_URL`：你的云服务器公网地址 + 端口
- `AUTH_TOKEN`：与服务端保持一致
- `GAME_PACKAGE`：默认 `com.tencent.cd.bm`，如包名变更请用 ADB 查询：
  ```bash
  adb shell pm list packages | grep -i bm
  ```
- `SHOP_TABS`：根据游戏内实际商店分类按钮文字调整（中文）
- 第一次部署建议把 `DEBUG_DRY_RUN: true`，仅截当前屏验证服务器收图与 OCR 是否正常

### 3.3 运行

在 AutoJs6 中打开 main.js → 运行。脚本会等待到 `SCHEDULE_TIMES` 指定时间触发。
建议在 AutoJs6 设置里开启「开机启动 + 守护进程」。

### 3.4 测试链路

```
config.js: DEBUG_DRY_RUN: true
   → 立即把当前手机屏截图上传
服务器日志看到 "OCR 完成" 与 "未命中/命中" 即链路通
```

确认 OK 后改回 false。

---

## 四、心愿单格式

`server/wishlist.json`：

```json
[
  {
    "name": "M4A1",
    "aliases": ["m4a1", "M4"],
    "max_price": 80000,
    "priority": "high",
    "note": "看到就抢"
  }
]
```

字段说明：
- `name` 主名称，OCR 命中或别名命中都算命中此项
- `aliases` 别名（应对 OCR 误识 / 游戏内显示差异）
- `max_price` 最高可接受价格；`null` 或省略表示任何价格都通知
- `priority` `high|medium|low`，邮件标题会标注高优先级
- `note` 备注，会出现在邮件里

修改后调用 `POST /reload_wishlist` 即可热生效，无需重启服务。

---

## 五、风控与稳定性建议

1. **保持账号正常游戏行为**：周末自己上线打几把，避免脚本是唯一登录来源。
2. **不要把脚本运行频率拉太高**：每天 1-2 次足够，频繁登录会被风控盯上。
3. **网络环境与你手机日常一致**：连家里 WiFi，不要走 VPN/代理。
4. **遇到验证码 / 公告弹窗**：脚本无法处理，会在 `/upload` 上传一张异常截图，你看到邮件可立刻人工介入。
5. **OCR 误判**：如果某物品反复漏识或误识，调大 `matcher.max_edit_distance`（最大 3），或在 `aliases` 加更多写法。
6. **服务器内存监控**：`docker stats` 或 `free -m`。OCR 子进程峰值约 350MB，主进程 ~80MB，正常水位 < 500MB。

---

## 六、常见问题

**Q: AutoJs6 的 `http.postMultipart` 在某些版本签名不同？**
A: 如果上报报错，可改成 `http.post` 配合 base64：把图 base64 后 POST `/upload_b64`（需要后端加一个对应路由），或升级到 AutoJs6 latest。

**Q: 云服务器跑 OCR 太慢？**
A: 减小 `ocr.max_width`（默认 1280，可降到 960），并把手机端截图先压缩。一张 720p 商店图 RapidOCR 约 3-8 秒。

**Q: 邮件被 QQ 标记垃圾？**
A: 改用 163 / 阿里云邮 SMTP，或者把发件人加入收件人白名单。
