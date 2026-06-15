"""
暗区商店监控 - 服务端主程序
职责：
  1. Flask 接收手机端上传的商店截图（带 token 鉴权）
  2. 派发到 OCR 子进程（用完即退，避免常驻占用内存）
  3. 解析 OCR 结果，与心愿单做模糊匹配
  4. 命中则发邮件通知（可附截图）

部署：python app.py  或  gunicorn -w 1 -k gthread --threads 4 app:app
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import yaml
from flask import Flask, abort, jsonify, request, send_from_directory

from matcher import match_wishlist, load_wishlist
from notifier import send_hit_email

# ---------- 路径与配置加载 ----------
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.yaml"
WISHLIST_PATH = BASE_DIR / "wishlist.json"

if not CONFIG_PATH.exists():
    print(f"[FATAL] 找不到 {CONFIG_PATH}，请先复制 config.example.yaml 为 config.yaml 并填写。")
    sys.exit(1)

with CONFIG_PATH.open("r", encoding="utf-8") as f:
    CFG = yaml.safe_load(f)

UPLOAD_DIR = BASE_DIR / CFG["server"]["upload_dir"]
LOG_DIR = BASE_DIR / CFG["server"]["log_dir"]
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- 日志 ----------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "server.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("arena")

# ---------- 心愿单加载 ----------
if not WISHLIST_PATH.exists():
    log.warning("wishlist.json 不存在，使用 wishlist.example.json 作为初始模板")
    WISHLIST_PATH.write_text(
        (BASE_DIR / "wishlist.example.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

WISHLIST = load_wishlist(WISHLIST_PATH)
log.info(f"已加载心愿单 {len(WISHLIST)} 项")

# ---------- Flask ----------
app = Flask(__name__)


def _check_auth(req) -> bool:
    token = req.headers.get("X-Auth-Token") or req.form.get("token")
    return token == CFG["server"]["auth_token"]


def _run_ocr(image_path: Path) -> list[dict]:
    """子进程执行 OCR，用完释放内存。返回 [{text, score, box}, ...]"""
    timeout = CFG["ocr"]["timeout"]
    max_width = CFG["ocr"]["max_width"]
    cmd = [
        sys.executable,
        str(BASE_DIR / "ocr_worker.py"),
        str(image_path),
        "--max-width",
        str(max_width),
    ]
    t0 = time.time()
    try:
        result = subprocess.run(
            cmd, capture_output=True, timeout=timeout, check=True
        )
    except subprocess.TimeoutExpired:
        log.error(f"OCR 子进程超时 ({timeout}s): {image_path}")
        return []
    except subprocess.CalledProcessError as e:
        log.error(f"OCR 子进程失败 rc={e.returncode}: {e.stderr.decode('utf-8', 'ignore')}")
        return []
    elapsed = time.time() - t0
    try:
        data = json.loads(result.stdout.decode("utf-8"))
    except json.JSONDecodeError:
        log.error(f"OCR 输出非 JSON: {result.stdout[:200]!r}")
        return []
    log.info(f"OCR 完成 用时 {elapsed:.1f}s，识别 {len(data)} 行")
    return data


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "wishlist_size": len(WISHLIST)})


# ====== 图片浏览 API（仅 debug_recon 模式用）======
@app.route("/uploads/<path:subpath>", methods=["GET"])
def serve_upload(subpath):
    """供本地浏览器查看侦察图。无需鉴权（建议仅临时开放）。"""
    return send_from_directory(UPLOAD_DIR, subpath)


@app.route("/browse", methods=["GET"])
def browse_index():
    """列出 uploads 下所有图片，便于快速预览。"""
    if not UPLOAD_DIR.exists():
        return "no uploads dir", 404
    items = []
    for p in sorted(UPLOAD_DIR.rglob("*.png"), key=lambda x: x.stat().st_mtime, reverse=True):
        rel = p.relative_to(UPLOAD_DIR).as_posix()
        items.append(rel)
    html = """<html><head><meta charset='utf-8'>
<style>
  body{font-family:sans-serif;background:#222;color:#eee;padding:20px}
  .day{margin:20px 0;padding:10px;background:#333;border-radius:6px}
  .item{display:inline-block;margin:6px;padding:8px;background:#444;border-radius:4px;
        max-width:280px;vertical-align:top}
  .item a{color:#8cf;text-decoration:none;font-size:12px}
  .item img{width:100%;border:1px solid #555;display:block;margin-top:4px}
  h3{margin:6px 0;color:#8cf}
</style></head><body>
<h2>Arena Shop Monitor - 图床（最新在前）</h2>
"""
    # 按日期分组
    by_day = {}
    for rel in items:
        day = rel.split("/")[0] if "/" in rel else "_root"
        by_day.setdefault(day, []).append(rel)
    for day in sorted(by_day.keys(), reverse=True):
        html += f"<div class='day'><h3>{day} ({len(by_day[day])} 张)</h3>"
        for rel in by_day[day][:200]:  # 每天最多展示 200 张
            html += f"<div class='item'><a href='/uploads/{rel}' target='_blank'>{rel}</a><br><a href='/uploads/{rel}' target='_blank'><img src='/uploads/{rel}' loading='lazy'></a></div>"
        html += "</div>"
    html += "</body></html>"
    return html


@app.route("/upload", methods=["POST"])
def upload():
    if not _check_auth(request):
        return jsonify({"ok": False, "error": "auth"}), 401

    if "image" not in request.files:
        return jsonify({"ok": False, "error": "no image"}), 400

    f = request.files["image"]
    raw = f.read()
    max_bytes = CFG["server"]["max_image_bytes"]
    if len(raw) > max_bytes:
        return jsonify({"ok": False, "error": "image too large"}), 413

    # 保存原图（按日期分目录便于排查）
    today = time.strftime("%Y%m%d")
    day_dir = UPLOAD_DIR / today
    day_dir.mkdir(exist_ok=True)
    fname = f"{int(time.time())}_{uuid.uuid4().hex[:6]}.png"
    img_path = day_dir / fname
    img_path.write_bytes(raw)

    # 附加元信息（手机端可传 tab 名等）
    tab = request.form.get("tab", "unknown")
    log.info(f"接收截图 tab={tab} size={len(raw)} -> {img_path.name}")

    # 跑 OCR（子进程）
    ocr_lines = _run_ocr(img_path)
    if not ocr_lines:
        return jsonify({"ok": False, "error": "ocr empty"}), 200

    # 匹配心愿单
    hits = match_wishlist(
        ocr_lines,
        WISHLIST,
        max_edit_distance=CFG["matcher"]["max_edit_distance"],
        price_regex=CFG["matcher"]["price_regex"],
    )

    # 持久化结果
    result_path = day_dir / (img_path.stem + ".json")
    result_path.write_text(
        json.dumps(
            {"tab": tab, "image": img_path.name, "ocr": ocr_lines, "hits": hits},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    if hits:
        log.warning(f"命中 {len(hits)} 项: {[h['name'] for h in hits]}")
        try:
            send_hit_email(
                CFG["smtp"],
                hits=hits,
                tab=tab,
                image_path=img_path if CFG["smtp"]["attach_image"] else None,
            )
        except Exception as e:
            log.exception(f"发邮件失败: {e}")
    else:
        log.info(f"未命中 (tab={tab})")

    return jsonify({"ok": True, "hits": hits, "ocr_lines": len(ocr_lines)})


@app.route("/reload_wishlist", methods=["POST"])
def reload_wishlist():
    if not _check_auth(request):
        return jsonify({"ok": False, "error": "auth"}), 401
    global WISHLIST
    WISHLIST = load_wishlist(WISHLIST_PATH)
    log.info(f"心愿单已重载 {len(WISHLIST)} 项")
    return jsonify({"ok": True, "size": len(WISHLIST)})


if __name__ == "__main__":
    host = CFG["server"]["host"]
    port = CFG["server"]["port"]
    log.info(f"启动 Arena Shop Monitor 服务 @ {host}:{port}")
    # 单进程（节省内存），threaded=True 让上传与上一次 OCR 不阻塞健康检查
    app.run(host=host, port=port, threaded=True, debug=False)
