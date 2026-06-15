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


_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _has_cjk(s: str) -> bool:
    return bool(_CJK_RE.search(s))


def _name_hit(line_text: str, keywords: Iterable[str], max_dist: int) -> str | None:
    """返回命中的关键词；没命中返回 None。

    严格策略：
    - 关键词与行文本都必须含 CJK 中文字符（防止纯数字误匹配）
      但例外：关键词全英文/数字（如 "DP12" "M4A1"）允许在英文/数字行命中
    - 子串包含 = 命中
    - 行文本与关键词长度差 <= max_dist 时，看整体编辑距离
    - 滑动窗口仅在行文本足够长时启用，且窗口内必须含 CJK
    """
    norm_line = _normalize(line_text)
    if not norm_line:
        return None
    for kw in keywords:
        nk = _normalize(kw)
        if not nk or len(nk) < 2:
            continue

        kw_has_cjk = _has_cjk(nk)
        line_has_cjk = _has_cjk(norm_line)

        # 1) 子串包含直接命中
        if nk in norm_line:
            return kw

        # 2) 中文关键词必须在含中文的行里匹配；
        #    英文/型号关键词（如 DP12）允许字母数字行匹配
        if kw_has_cjk and not line_has_cjk:
            continue

        # 3) 短关键词（<3 字符）只接受精确包含，不做模糊
        if len(nk) < 3:
            continue

        # 4) 整体编辑距离（仅当长度接近）
        if abs(len(nk) - len(norm_line)) <= max_dist:
            if Levenshtein.distance(nk, norm_line) <= max_dist:
                return kw

        # 5) 滑动窗口：仅当行文本明显比关键词长，避免误命中
        if len(norm_line) >= len(nk) + 2 and len(nk) >= 4:
            for i in range(0, len(norm_line) - len(nk) + 1):
                window = norm_line[i : i + len(nk)]
                # 中文关键词要求窗口也包含中文
                if kw_has_cjk and not _has_cjk(window):
                    continue
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
    """在与 name_line 同一卡片区域找价格。

    暗区商店物品名在卡片底部，价格在卡片右上角；卡片宽度大约 250-350 像素。
    所以价格行：
      - 必须在物品名上方（ly < name_y）
      - 垂直距离 < 280 像素
      - 水平距离 < 200 像素（同一卡片内）
    """
    name_y = _box_center_y(name_line["box"])
    name_x = _box_center_x(name_line["box"])
    candidates: list[tuple[float, int]] = []
    for line in all_lines:
        if line is name_line:
            continue
        text = line.get("text", "")
        # 排除明显的非价格文本（包含中文、字母过多）
        digits = re.sub(r"[^\d]", "", text)
        if len(digits) < 2 or len(digits) > 8:
            continue
        # 价格文本里非数字/逗号/空格的字符 < 30%（防止把"品质16"这种当价格）
        non_num = sum(1 for c in text if not (c.isdigit() or c in ",， .\t"))
        if non_num > len(text) * 0.3:
            continue

        price = _parse_price(text, price_regex)
        if price is None:
            continue
        # 价格合理性：商品价格 50 ~ 50,000,000
        if price < 50 or price > 50_000_000:
            continue

        ly = _box_center_y(line["box"])
        lx = _box_center_x(line["box"])
        dy = name_y - ly  # 价格在物品名上方时 dy 为正
        dx = abs(lx - name_x)
        # 同卡片：价格在物品名上方 280 像素内 + 水平偏移 200 像素内
        # 或者完全同一行（abs dy < 30）
        same_row = abs(dy) < 30 and dx < 300
        same_card = 0 < dy < 280 and dx < 200
        if same_row or same_card:
            score = abs(dy) * 1.0 + dx * 0.5
            candidates.append((score, price))
    if not candidates:
        # 兜底：name_line 自身就含价格
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
