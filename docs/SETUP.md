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

## Fly model setup and measurement

The fly dependencies are optional so Monish can install the ground station
without PyTorch. From the repository root:

```sh
uv sync --extra fly
uv run --extra fly python -m tools.prepare_flyvis
uv run --extra fly python -m tools.flyvis_smoke --device cpu
```

In this restricted Windows workspace, replace `uv` with
`& ../../work/bootstrap/bin/uv.exe` after setting the environment variables above.
Keep `--extra fly` in subsequent uv commands that need the installed model.

The setup downloads the official 3.4 MB archive, checks its published SHA256,
and extracts only `flow/0000/000` into ignored `data/checkpoints/flyvis/`.
The smoke command is offline after setup. It exports `data/flyvis_layout.json`
only when direction, orientation and gray-stability checks pass, and writes a
detailed report to `results/flyvis_smoke.json`.

`--device cuda` requires a CUDA-enabled PyTorch install. The validated Windows
installation currently uses CPU PyTorch; no GPU performance is claimed.
To reproduce the warm-up study:

```sh
uv run --extra fly python -m tools.check_flyvis_warmup
```

Flyvis 1.2.0 currently depends on datamate 1.0.0, whose cache writer fails on
Windows by deleting an open HDF5 file. `reflex/compat.py` temporarily replaces
that writer during model loading and restores it afterward. No installed
package files are edited. This workaround is disabled on other operating systems
or datamate versions. See the handoff for measured limitations and deviations.
