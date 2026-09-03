#!/usr/bin/env python3
"""Build a Page Scene from OCR blocks on raster pages."""

import json
import sys
from pathlib import Path

import cv2
import numpy as np


def rounded(value):
    return round(float(value), 3)


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("usage: raster_scene_runner.py <request.json>")
    request_path = Path(sys.argv[1]).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    pages = []
    backgrounds = []
    total_text_nodes = 0

    for page_index, item in enumerate(request.get("pages") or []):
        image_path = Path(item["image_path"]).resolve()
        output_path = Path(item["output_path"]).resolve()
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"cannot read raster page: {image_path}")
        pixel_height, pixel_width = image.shape[:2]
        logical_width = float(item.get("width") or pixel_width)
        logical_height = float(item.get("height") or pixel_height)
        scale_x = logical_width / max(1, pixel_width)
        scale_y = logical_height / max(1, pixel_height)
        mask = np.zeros((pixel_height, pixel_width), dtype=np.uint8)
        text_nodes = []

        for block_index, block in enumerate(item.get("blocks") or []):
            text = str(block.get("text") or "")
            bbox = block.get("bbox") or {}
            if not text.strip() or bbox.get("x") is None or bbox.get("y") is None:
                continue
            x = float(bbox.get("x") or 0)
            y = float(bbox.get("y") or 0)
            width = max(1.0, float(bbox.get("width") or 1))
            height = max(1.0, float(bbox.get("height") or 1))
            padding = max(1, round(height * 0.08))
            x1 = max(0, int(np.floor(x - padding)))
            y1 = max(0, int(np.floor(y - padding)))
            x2 = min(pixel_width, int(np.ceil(x + width + padding)))
            y2 = min(pixel_height, int(np.ceil(y + height + padding)))
            cv2.rectangle(mask, (x1, y1), (x2, y2), 255, thickness=-1)

            logical_bbox = {
                "x": rounded(x * scale_x),
                "y": rounded(y * scale_y),
                "width": rounded(width * scale_x),
                "height": rounded(height * scale_y),
            }
            font_size = max(5.0, logical_bbox["height"] * 0.78)
            text_nodes.append(
                {
                    "text": text,
                    "bbox": logical_bbox,
                    "direction": {"x": 1, "y": 0},
                    "writing_mode": 0,
                    "confidence": rounded(block.get("confidence") or 0),
                    "spans": [
                        {
                            "text": text,
                            "bbox": logical_bbox,
                            "relative_bbox": {
                                "x": 0,
                                "y": 0,
                                "width": logical_bbox["width"],
                                "height": logical_bbox["height"],
                            },
                            "origin": {
                                "x": logical_bbox["x"],
                                "y": rounded(logical_bbox["y"] + logical_bbox["height"]),
                            },
                            "font_family": "Noto Sans SC",
                            "font_size": rounded(font_size),
                            "color": "#202124",
                            "bold": False,
                            "italic": False,
                            "monospace": False,
                            "serif": False,
                            "ascender": 0,
                            "descender": 0,
                        }
                    ],
                    "id": f"ocr-{page_index + 1}-{block_index + 1}",
                }
            )

        total_text_nodes += len(text_nodes)
        if np.any(mask):
            cleaned = cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)
        else:
            cleaned = image
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(output_path), cleaned, [cv2.IMWRITE_PNG_COMPRESSION, 8]):
            raise RuntimeError(f"cannot write raster scene: {output_path}")
        pages.append(
            {
                "number": int(item.get("number") or page_index + 1),
                "width": rounded(logical_width),
                "height": rounded(logical_height),
                "background_contains_text": False,
                "text_source": "ocr",
                "text_nodes": text_nodes,
            }
        )
        backgrounds.append(
            {
                "page": int(item.get("number") or page_index + 1),
                "path": str(output_path),
                "mime_type": "image/png",
                "width": pixel_width,
                "height": pixel_height,
            }
        )

    sys.stdout.write(
        json.dumps(
            {
                "version": "page-scene-v1",
                "has_text_layer": total_text_nodes > 0,
                "text_source": "ocr",
                "text_node_count": total_text_nodes,
                "render_dpi": None,
                "pages": pages,
                "backgrounds": backgrounds,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
