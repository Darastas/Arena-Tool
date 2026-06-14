"""
心愿单匹配
- 模糊匹配物品名（Levenshtein）
- 在物品名同行/邻近行抓取价格
- 命中规则：物品名匹配 且（未配置 max_price 或 当前价格 <= max_price）
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

import Levenshtein


def load_wishlist(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    # 规范化
    for item in data:
        item.setdefault("aliases", [])
        item.setdefault("max_price", None)
        item.setdefault("priority", "medium")
        item["_keywords"] = [item["name"], *item["aliases"]]
    return data


def _normalize(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def _name_hit(line_text: str, keywords: Iterable[str], max_dist: int) -> str | None:
    """返回命中的关键词；没命中返回 None。"""
    norm_line = _normalize(line_text)
    if not norm_line:
        return None
    for kw in keywords:
        nk = _normalize(kw)
        if not nk:
            continue
        # 1) 子串包含直接命中
        if nk in norm_line:
            return kw
        # 2) 短词整体编辑距离
        if abs(len(nk) - len(norm_line)) <= max_dist:
            if Levenshtein.distance(nk, norm_line) <= max_dist:
                return kw
        # 3) 滑动窗口（应对 OCR 把价格和物品名识到同一行）
        if len(norm_line) > len(nk):
            for i in range(0, len(norm_line) - len(nk) + 1):
                window = norm_line[i : i + len(nk)]
                if Levenshtein.distance(nk, window) <= max_dist:
                    return kw
    return None


def _parse_price(text: str, price_regex: str) -> int | None:
    m = re.search(price_regex, text)
    if not m:
        return None
    raw = m.group(1).replace(",", "").replace("，", "")
    try:
        return int(raw)
    except ValueError:
        return None


def _box_center_y(box) -> float:
    return sum(p[1] for p in box) / 4.0


def _box_center_x(box) -> float:
    return sum(p[0] for p in box) / 4.0


def _find_nearby_price(
    name_line: dict, all_lines: list[dict], price_regex: str
) -> int | None:
    """在与 name_line 同一卡片区域（y 接近 或 x 右侧）找价格。"""
    name_y = _box_center_y(name_line["box"])
    name_x = _box_center_x(name_line["box"])
    candidates: list[tuple[float, int]] = []
    for line in all_lines:
        if line is name_line:
            continue
        price = _parse_price(line["text"], price_regex)
        if price is None:
            continue
        ly = _box_center_y(line["box"])
        lx = _box_center_x(line["box"])
        # 同卡片：垂直距离 < 120 px 且水平距离 < 400 px（依分辨率而定）
        dy = abs(ly - name_y)
        dx = abs(lx - name_x)
        if dy < 120 and dx < 500:
            candidates.append((dy * 1.0 + dx * 0.3, price))
    # 同行价格优先（dy 越小越优先）
    if not candidates:
        # 最后兜底：name_line 自身文本里就含价格
        return _parse_price(name_line["text"], price_regex)
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def match_wishlist(
    ocr_lines: list[dict],
    wishlist: list[dict],
    max_edit_distance: int,
    price_regex: str,
) -> list[dict]:
    """
    返回命中列表：
      [{name, matched_keyword, price, max_price, priority, line_text}, ...]
    """
    hits: list[dict] = []
    seen_pairs: set[tuple[str, int | None]] = set()

    for line in ocr_lines:
        text = line.get("text", "")
        if not text or len(text) < 2:
            continue
        for item in wishlist:
            kw = _name_hit(text, item["_keywords"], max_edit_distance)
            if not kw:
                continue
            price = _find_nearby_price(line, ocr_lines, price_regex)
            key = (item["name"], price)
            if key in seen_pairs:
                continue
            seen_pairs.add(key)

            max_price = item.get("max_price")
            if price is not None and max_price is not None and price > max_price:
                continue  # 价格超预算，不算命中

            hits.append(
                {
                    "name": item["name"],
                    "matched_keyword": kw,
                    "price": price,
                    "max_price": max_price,
                    "priority": item["priority"],
                    "line_text": text,
                    "note": item.get("note", ""),
                }
            )
    # 高优先级排前面
    priority_rank = {"high": 0, "medium": 1, "low": 2}
    hits.sort(key=lambda h: priority_rank.get(h["priority"], 9))
    return hits
