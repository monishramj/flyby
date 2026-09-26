"""Setup-only download: verify upstream archive, extract only flow/0000/000.

Run: uv run --extra fly python -m tools.prepare_flyvis
The checksum is published in flyvis 1.2.0's download_pretrained_models.py.
No model downloads occur in the reflex process.
"""

import argparse
import hashlib
import io
from pathlib import Path
import zipfile

from reflex.config import FLYVIS_MODEL, FLYVIS_ROOT

ARCHIVE_URL = "https://drive.usercontent.google.com/download?id=13cJr2nMn89j-jBAd5RduYRJpBcXwoNrC&export=download"
ARCHIVE_SHA256 = "71c78d4070556a536b13b23ee3139cd2788aa2a9d07d430a223b4edead281db1"


def extract_checkpoint(content: bytes, destination: Path) -> list[str]:
    digest = hashlib.sha256(content).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError(f"Pretrained archive checksum mismatch: {digest}")
    destination = destination.resolve()
    prefix = f"results/{FLYVIS_MODEL}/"
    written = []
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        for member in archive.infolist():
            if not member.filename.startswith(prefix) or member.is_dir():
                continue
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(destination):
                raise ValueError("Archive member escapes destination")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
            written.append(member.filename)
    if not written:
        raise ValueError("Expected pretrained model is absent from archive")
    return written


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already-downloaded upstream ZIP")
    args = parser.parse_args()
    if args.archive:
        content = args.archive.read_bytes()
    else:
        import httpx
        with httpx.Client(follow_redirects=True, timeout=60) as client:
            response = client.get(ARCHIVE_URL)
            response.raise_for_status()
            content = response.content
    written = extract_checkpoint(content, FLYVIS_ROOT)
    print(f"Verified SHA256 {ARCHIVE_SHA256}")
    print(f"Prepared {FLYVIS_MODEL}: {len(written)} files in {FLYVIS_ROOT}")


if __name__ == "__main__":
    main()
