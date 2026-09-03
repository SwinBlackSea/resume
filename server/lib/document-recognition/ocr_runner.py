import json
import sys

from paddleocr import PaddleOCR


def main():
    if len(sys.argv) != 2:
        raise ValueError("missing image path")
    image_path = sys.argv[1]
    engine = PaddleOCR(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        enable_mkldnn=False,
        cpu_threads=2,
    )
    results = engine.predict(image_path)
    blocks = []
    for result in results:
        payload = result.json
        data = payload.get("res", payload)
        texts = data.get("rec_texts", [])
        scores = data.get("rec_scores", [])
        boxes = data.get("rec_boxes", [])
        for index, text in enumerate(texts):
            box = boxes[index] if index < len(boxes) else None
            bbox = None
            if box and len(box) >= 4:
                x1, y1, x2, y2 = [float(value) for value in box[:4]]
                bbox = {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}
            blocks.append(
                {
                    "text": str(text),
                    "confidence": float(scores[index]) if index < len(scores) else 0.0,
                    "bbox": bbox,
                }
            )
    print(json.dumps({"blocks": blocks}, ensure_ascii=False))


if __name__ == "__main__":
    main()
