"""
SMTP 邮件通知
- 命中物品时发邮件
- 可附原始截图
"""
from __future__ import annotations

import smtplib
import time
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path


def _build_html(hits: list[dict], tab: str) -> str:
    rows = []
    for h in hits:
        price_str = f"{h['price']:,}" if h.get("price") is not None else "未识别"
        max_price = h.get("max_price")
        max_price_str = f"{max_price:,}" if max_price else "—"
        prio_color = {"high": "#d9534f", "medium": "#f0ad4e", "low": "#5bc0de"}.get(
            h["priority"], "#777"
        )
        rows.append(
            f"""<tr>
              <td><b>{h['name']}</b><br><span style='color:#888;font-size:12px'>{h.get('note','')}</span></td>
              <td><b style='color:#2a8d2a'>{price_str}</b></td>
              <td>{max_price_str}</td>
              <td><span style='color:{prio_color}'>{h['priority']}</span></td>
              <td style='color:#666;font-size:12px'>{h['line_text']}</td>
            </tr>"""
        )
    table = "\n".join(rows)
    return f"""
<html><body>
<h2>暗区商店命中提醒</h2>
<p>来源 tab：<b>{tab}</b> &nbsp;&nbsp; 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}</p>
<table border="1" cellpadding="6" cellspacing="0" style='border-collapse:collapse;font-family:sans-serif'>
  <tr style='background:#eee'>
    <th>物品</th><th>当前价格</th><th>预算上限</th><th>优先级</th><th>OCR原文</th>
  </tr>
  {table}
</table>
<p style='color:#999;font-size:12px'>由 Arena Shop Monitor 自动发送，速速上号！</p>
</body></html>
"""


def send_hit_email(
    smtp_cfg: dict,
    hits: list[dict],
    tab: str,
    image_path: Path | None = None,
) -> None:
    msg = MIMEMultipart("related")
    high_count = sum(1 for h in hits if h["priority"] == "high")
    flag = "⚡" if high_count else "🛒"
    msg["Subject"] = (
        f"{smtp_cfg['subject_prefix']} {flag} 命中 {len(hits)} 项"
        f"{' (含高优先级)' if high_count else ''}"
    )
    msg["From"] = formataddr(("ArenaMonitor", smtp_cfg["from_addr"]))
    msg["To"] = ", ".join(smtp_cfg["to_addrs"])

    alt = MIMEMultipart("alternative")
    msg.attach(alt)
    alt.attach(MIMEText(_build_html(hits, tab), "html", "utf-8"))

    if image_path and image_path.exists():
        with image_path.open("rb") as f:
            img = MIMEImage(f.read())
        img.add_header("Content-Disposition", "attachment", filename=image_path.name)
        msg.attach(img)

    if smtp_cfg.get("use_ssl", True):
        s = smtplib.SMTP_SSL(smtp_cfg["host"], smtp_cfg["port"], timeout=20)
    else:
        s = smtplib.SMTP(smtp_cfg["host"], smtp_cfg["port"], timeout=20)
        s.starttls()
    try:
        s.login(smtp_cfg["username"], smtp_cfg["password"])
        s.sendmail(smtp_cfg["from_addr"], smtp_cfg["to_addrs"], msg.as_string())
    finally:
        try:
            s.quit()
        except Exception:
            pass
