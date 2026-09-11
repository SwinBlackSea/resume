"""Bounded native PDF image extraction and page references; no network access."""
import json
import os
import sys
import fitz

document = fitz.open(sys.argv[1])
out_dir = sys.argv[2]
if document.needs_pass or len(document) > 12:
    raise ValueError("PDF encrypted or exceeds 12-page image processing limit")
images = []
for page_index, page in enumerate(document):
    # The page reference lets the model distinguish decorations, portraits and
    # scanned whole-page rasters without guessing from isolated images.
    scale = min(2.0, 2200 / max(page.rect.width, page.rect.height))
    page_file = f"page-{page_index + 1}.png"
    page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(os.path.join(out_dir, page_file))
    images.append({"file": page_file, "kind": "page_reference", "page": page_index + 1})
    seen = set()
    for item in page.get_images(full=True):
        xref, smask = item[0], item[1]
        if xref in seen:
            continue
        seen.add(xref)
        rectangles = page.get_image_rects(xref)
        if not rectangles:
            continue
        if len(images) >= 24:
            raise ValueError("PDF has too many image candidates; upload portrait separately")
        if item[2] * item[3] > 64 * 1024 * 1024:
            raise ValueError("PDF image exceeds pixel budget")
        pix = fitz.Pixmap(document, xref)
        if smask:
            pix = fitz.Pixmap(pix, fitz.Pixmap(document, smask))
        if pix.colorspace and pix.colorspace.n > 3:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        image_file = f"image-{page_index + 1}-{xref}.png"
        pix.save(os.path.join(out_dir, image_file))
        images.append({"file": image_file, "kind": "embedded_image", "page": page_index + 1,
                       "placement": {"rectangles": [list(rect) for rect in rectangles],
                                     "page_width": page.rect.width, "page_height": page.rect.height}})
print(json.dumps({"images": images}))
