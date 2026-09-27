"""Drive web/capture.html in headless Chromium and save the recorded flights as JSON.

Needs the reflex server (:8001) and Vite (:5173) running.
Run: uv run python -m tools.capture_flights "post:0:on,post:0:off" --fov 90 --out results/capture
"""

import argparse
import asyncio
import glob
import json
from pathlib import Path
import subprocess
import time
import urllib.request

import websockets

PORT = 9340


async def evaluate(ws, expr, msg_id):
    await ws.send(json.dumps({"id": msg_id, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == msg_id:
            return msg["result"]["result"].get("value")


async def capture(flights, fov, every, out: Path):
    chrome = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))[0]
    url = f"http://127.0.0.1:5173/capture.html?flights={flights}&fov={fov}&every={every}"
    proc = subprocess.Popen([chrome, "--headless=new", "--no-sandbox", "--use-angle=swiftshader",
                             "--enable-unsafe-swiftshader", f"--remote-debugging-port={PORT}", url],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                page = next(p for p in pages if "capture.html" in p.get("url", ""))
                break
            except Exception:
                time.sleep(1)
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
            i = 0
            while True:
                i += 1
                if await evaluate(ws, "window.__capture && window.__capture.done", i):
                    break
                await asyncio.sleep(2)
            error = await evaluate(ws, "window.__capture.error || null", i + 1)
            if error:
                raise SystemExit(f"capture failed: {error}")
            n = await evaluate(ws, "window.__capture.flights.length", i + 2)
            out.mkdir(parents=True, exist_ok=True)
            for f in range(n):
                data = await evaluate(ws, f"JSON.stringify(window.__capture.flights[{f}])", i + 3 + f)
                flight = json.loads(data)
                name = f"{flight['spec']['scenario']}_{flight['spec']['seed']}_{'on' if flight['reflex_on'] else 'off'}.json"
                (out / name).write_text(data)
                r = flight["result"]
                print(f"{name}: {len(flight['frames'])} frames, collided={r['collided']} arrived={r['arrived']} t={r['t']}")
    finally:
        proc.terminate()
        proc.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flights")
    parser.add_argument("--fov", type=int, default=90)
    parser.add_argument("--every", type=int, default=2)
    parser.add_argument("--out", type=Path, default=Path("results/capture"))
    args = parser.parse_args()
    asyncio.run(capture(args.flights, args.fov, args.every, args.out))


if __name__ == "__main__":
    main()
