# Local setup

Prerequisites: Git, uv, Node.js 22.12+ (this machine has 22.19), and npm.
uv can install Python 3.12 without changing the system Python.

From the repository root:

```sh
uv sync
uv run pytest -m "not slow and not network"
cd web
npm ci
npm run build
npm run dev
```

Open the local URL printed by Vite. This is a foundation/status page, not the
finished mission dashboard. Three.js and Chart.js are installed for later steps.

In separate terminals from the repository root:

```sh
uv run uvicorn server.app:app --host 127.0.0.1 --port 8000
uv run python -m reflex.server --port 8001
```

`http://127.0.0.1:8000/health` and `http://127.0.0.1:8001/health` report scaffold
status. There are no mission or reflex WebSocket routes yet. Do not connect a
flight controller to these placeholders.

Cloud credentials are optional for the scaffold. When Monish adds the services,
copy `.env.example` to `.env` and set the actual credentials locally. `.env` is
ignored by Git; never put credentials in the browser.

## This Codex workspace

uv and Python 3.12 are installed under the parent workspace's `work/` folder,
not globally. From this repository in PowerShell:

```powershell
$env:UV_PYTHON_INSTALL_DIR = (Resolve-Path ../../work/python).Path
$env:UV_CACHE_DIR = (Resolve-Path ../../work/uv-cache).Path
$env:TEMP = (Resolve-Path ../../work/tmp).Path
$env:TMP = $env:TEMP
$env:npm_config_cache = (Resolve-Path ../../work/npm-cache).Path
& ../../work/bootstrap/bin/uv.exe sync
& ../../work/bootstrap/bin/uv.exe run pytest -m "not slow and not network"
```

The setup does not need Python registry entries or a change to the system PATH.
On the Mac, install/use uv normally and run the platform-independent commands
above. Mac validation and model benchmarks are still pending.
