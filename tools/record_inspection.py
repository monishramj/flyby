"""Local-only collector for inspect.html?record=1 backup recordings.

Run with --out results/video-input, then open inspect.html?record=1&scenario=debris&seed=0
and press Fly. Saves the actual canvas WebM and its measured outcome/timeline.
The final MP4 encoding/caption is a separate ffmpeg step; no model is changed.
"""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("results/video-input"))
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)

    class Collector(BaseHTTPRequestHandler):
        def respond(self, code):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5173")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_OPTIONS(self):
            self.respond(204)

        def do_POST(self):
            if self.headers.get("Origin") != "http://127.0.0.1:5173":
                return self.respond(403)
            if not re.fullmatch(r"/(clear|post|debris|beam|texture)_\d+_(on|off)\.(webm|json)", self.path):
                return self.respond(400)
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size < 100_000_000:
                return self.respond(413)
            path = output / self.path[1:]
            path.write_bytes(self.rfile.read(size))
            print(f"Saved {path.name}: {size} bytes", flush=True)
            self.respond(201)

    print(f"Recording collector on 127.0.0.1:8002; output {output}", flush=True)
    HTTPServer(("127.0.0.1", 8002), Collector).serve_forever()


if __name__ == "__main__":
    main()
