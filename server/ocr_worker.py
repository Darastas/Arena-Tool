"""
OCR 子进程 worker
- 加载 RapidOCR (ONNX Runtime, CPU)
- 处理一张图片，输出 JSON 到 stdout，然后进程退出
- 这样模型内存随子进程结束自然释放，不会常驻

使用：python ocr_worker.py <image_path> [--max-width 1280]
输出：[{"text": "...", "score": 0.95, "box": [[x,y],[x,y],[x,y],[x,y]]}, ...]
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def _resize_for_ocr(img_path: Path, max_width: int) -> Path:
    """如果图过大就缩到 max_width，覆盖式保存为临时文件返回。"""
    img = Image.open(img_path)
    w, h = img.size
    if w <= max_width:
        return img_path
    ratio = max_width / w
    new_size = (max_width, int(h * ratio))
    img = img.resize(new_size, Image.LANCZOS)
    tmp = img_path.with_name(img_path.stem + "_resized.png")
    img.save(tmp, format="PNG", optimize=True)
    return tmp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=str)
    parser.add_argument("--max-width", type=int, default=1280)
    args = parser.parse_args()

    img_path = Path(args.image)
    if not img_path.exists():
        print(json.dumps([]))
        sys.exit(0)

    # 先缩放（节省 OCR 时间和内存）
    use_path = _resize_for_ocr(img_path, args.max_width)

    # 延迟导入：进程启动时才加载，避免反复加载
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    result, _elapsed = ocr(str(use_path))

    out = []
    if result:
        for item in result:
            # rapidocr 返回 [box, text, score]
            box, text, score = item
            out.append(
                {
                    "text": text,
                    "score": float(score),
                    "box": [[float(p[0]), float(p[1])] for p in box],
                }
            )

    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
