"""Download the pinned public checkpoint once; serving never downloads models."""
import json
from pathlib import Path
from urllib.request import urlopen

from huggingface_hub import snapshot_download

from server.config import settings


def main():
    path = Path(snapshot_download(
        settings.LAYA_MODEL_ID,
        revision=settings.LAYA_REVISION,
        allow_patterns=["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*", "rl_agent_api.py", "rl_common.py", "README.md"],
        local_dir=settings.LAYA_MODEL_DIR,
    ))
    # The Hub card declares Apache-2.0; upstream's repository carries its text.
    license_url = "https://raw.githubusercontent.com/NandhaKishorM/laya/main/LICENSE"
    with urlopen(license_url, timeout=30) as response:
        (path / "LICENSE").write_bytes(response.read())
    (path / "provenance.json").write_text(json.dumps({
        "model": settings.LAYA_MODEL_ID, "revision": settings.LAYA_REVISION,
        "runtime": "laya==0.3.20", "license": "Apache-2.0", "license_url": license_url,
    }, indent=2) + "\n")
    print(f"Laya installed locally at {path}")


if __name__ == "__main__":
    main()
