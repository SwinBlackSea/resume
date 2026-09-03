#!/usr/bin/env python3
"""Extract a canonical editable page scene and a text-free visual layer from PDF."""

import json
import re
import sys
from pathlib import Path

import fitz


RENDER_DPI = 120
PDF_POINTS_PER_INCH = 72


def rounded(value):
    return round(float(value), 3)


def rect_payload(rect):
    return {
        "x": rounded(rect.x0),
        "y": rounded(rect.y0),
        "width": rounded(max(0, rect.x1 - rect.x0)),
        "height": rounded(max(0, rect.y1 - rect.y0)),
    }


def clean_font_name(value):
    name = str(value or "").strip()
    return re.sub(r"^[A-Z]{6}\+", "", name)


def color_hex(value):
    number = int(value or 0) & 0xFFFFFF
    return f"#{number:06X}"


def span_payload(span, line_rect):
    bbox = fitz.Rect(span.get("bbox") or (0, 0, 0, 0))
    origin = span.get("origin") or (bbox.x0, bbox.y1)
    flags = int(span.get("flags") or 0)
    return {
        "text": str(span.get("text") or ""),
        "bbox": rect_payload(bbox),
        "relative_bbox": {
            "x": rounded(bbox.x0 - line_rect.x0),
            "y": rounded(bbox.y0 - line_rect.y0),
            "width": rounded(max(0, bbox.width)),
            "height": rounded(max(0, bbox.height)),
        },
        "origin": {"x": rounded(origin[0]), "y": rounded(origin[1])},
        "font_family": clean_font_name(span.get("font")),
        "font_size": rounded(span.get("size") or max(1, bbox.height)),
        "color": color_hex(span.get("color")),
        "bold": bool(flags & 16),
        "italic": bool(flags & 2),
        "monospace": bool(flags & 8),
        "serif": bool(flags & 4),
        "ascender": rounded(span.get("ascender") or 0),
        "descender": rounded(span.get("descender") or 0),
    }


def extract_page_lines(page):
    page_dict = page.get_text("dict", sort=False)
    lines = []
    redact_rects = []
    for block in page_dict.get("blocks") or []:
        if int(block.get("type") or 0) != 0:
            continue
        for line in block.get("lines") or []:
            raw_spans = [
                span
                for span in (line.get("spans") or [])
                if str(span.get("text") or "")
            ]
            if not raw_spans:
                continue
            line_rect = fitz.Rect(line.get("bbox") or raw_spans[0].get("bbox"))
            spans = [span_payload(span, line_rect) for span in raw_spans]
            text = "".join(span["text"] for span in spans)
            if not text.strip():
                continue
            for raw_span in raw_spans:
                rect = fitz.Rect(raw_span.get("bbox") or (0, 0, 0, 0))
                if rect.width > 0 and rect.height > 0:
                    redact_rects.append(rect)
            direction = line.get("dir") or (1, 0)
            lines.append(
                {
                    "text": text,
                    "bbox": rect_payload(line_rect),
                    "direction": {
                        "x": rounded(direction[0]),
                        "y": rounded(direction[1]),
                    },
                    "writing_mode": int(line.get("wmode") or 0),
                    "spans": spans,
                }
            )
    return lines, redact_rects


def main():
    if len(sys.argv) != 3:
        raise RuntimeError("usage: page_scene_runner.py <input.pdf> <output-dir>")
    pdf_path = Path(sys.argv[1]).resolve()
    output_dir = Path(sys.argv[2]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    document = fitz.open(pdf_path)
    pages = []
    backgrounds = []
    total_text_nodes = 0
    matrix = fitz.Matrix(RENDER_DPI / PDF_POINTS_PER_INCH, RENDER_DPI / PDF_POINTS_PER_INCH)

    for page_index, page in enumerate(document):
        lines, redact_rects = extract_page_lines(page)
        total_text_nodes += len(lines)
        page_rect = page.rect
        pages.append(
            {
                "number": page_index + 1,
                "width": rounded(page_rect.width),
                "height": rounded(page_rect.height),
                "background_contains_text": not bool(lines),
                "text_nodes": lines,
            }
        )

        for rect in redact_rects:
            page.add_redact_annot(rect, fill=False)
        if redact_rects:
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )
        background_path = output_dir / f"scene-background-{page_index + 1}.png"
        pixmap = page.get_pixmap(matrix=matrix, alpha=False, annots=False)
        pixmap.save(background_path)
        backgrounds.append(
            {
                "page": page_index + 1,
                "path": str(background_path),
                "mime_type": "image/png",
                "width": pixmap.width,
                "height": pixmap.height,
            }
        )

    payload = {
        "version": "page-scene-v1",
        "has_text_layer": total_text_nodes > 0,
        "text_node_count": total_text_nodes,
        "render_dpi": RENDER_DPI,
        "pages": pages,
        "backgrounds": backgrounds,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
