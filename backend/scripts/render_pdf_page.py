"""Render one PDF page to a JPEG for a vision model. PDF bytes on stdin, JSON on stdout."""
import base64
import io
import json
import sys

import pypdfium2

MAX_BYTES = 1_500_000


def main() -> int:
    page = int(sys.argv[1])
    dpi = float(sys.argv[2]) if len(sys.argv) > 2 else 110.0
    pdf = pypdfium2.PdfDocument(sys.stdin.buffer.read())
    count = len(pdf)
    if page < 1 or page > count:
        json.dump({"ok": False, "error": "page_out_of_range", "page_count": count}, sys.stdout)
        return 0
    image = pdf[page - 1].render(scale=dpi / 72.0).to_pil().convert("RGB")
    for quality, shrink in ((80, 1.0), (65, 1.0), (55, 0.75), (45, 0.6)):
        frame = image if shrink == 1.0 else image.resize(
            (max(1, int(image.width * shrink)), max(1, int(image.height * shrink))))
        buffer = io.BytesIO()
        frame.save(buffer, format="JPEG", quality=quality, optimize=True)
        data = buffer.getvalue()
        if len(data) <= MAX_BYTES:
            break
    json.dump({"ok": True, "page": page, "page_count": count, "width": frame.width,
               "height": frame.height, "jpeg_base64": base64.b64encode(data).decode("ascii")},
              sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
