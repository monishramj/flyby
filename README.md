# FlyBy Triage

Drone search-and-rescue triage. A simulated drone sweeps a flooded neighborhood and a detector flags possible people. Many flags are debris, animals or warm spots, so reviewing them is the bottleneck. FlyBy ranks every flag, proposes an action, and lets an incident commander approve it in one click.

Built at HackGT 13. Everything is simulated: the town, people, detector noise and operator behavior come from a seed, and the same `(seed, config)` replays the same run. Detector and operator parameters are declared assumptions, not measurements.

## Components

| Component | Role |
| --- | --- |
| **Mission sim** (`server/mission/`) | Seeded scenario, lawnmower sweep, detector noise, ground-truth labels. |
| **Laya** (`server/triage/`) | Local open-weights model ([convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya)). One pass returns an action with probabilities, urgency and P(person). A rule policy is the fallback on error or timeout. |
| **Grok** (`server/grok/`) | Via `xai-sdk`. Parses radio/text intel into a schema and writes crew orders. Never chooses the action. |
| **Incident picture** (`server/incident/`) | In-memory state merged by code from parsed intel: sector priority, reported subjects, hazards, last known point. |
| **UI** (`web/`) | 3D map, work queue (approve, override, "Why?"), reviewable auto-closed bin, intel context, Results tab. |
| **Persistence** (`server/store/`) | MongoDB Atlas write-behind with a local JSONL spool; Atlas Vector Search over past flags. |
| **Fly reflex** (`reflex/`) | Optional fly-eye collision reflex for inspection flights. |

## Hard rules

1. The decision path never waits on Grok, never reads Mongo, never uses the network.
2. Mongo writes are queued and never awaited; reads are off the decision path.
3. Grok never decides. Code merges its schema-checked output and inserts every number; digits in Grok text are stripped.
4. Every constant lives in [`server/config.py`](server/config.py).
5. Same `(seed, config)`, same run, apart from latency and any timeouts it causes.

## Lead lifecycle

```
captured → decided ─┬─ auto (max prob ≥ TAU_ROUTE):
                    │    ignore, low score, in the open, ≥ TAU_CLOSE → auto_closed (reopenable)
                    │    ignore, otherwise           → awaiting_human
                    │    reimage_zoom                → reimaging → recapture (pass+1) → decided
                    │    dispatch / inspect          → awaiting_approval
                    └─ routed (max prob < TAU_ROUTE, fallback, or pass > MAX_PASSES) → awaiting_human

awaiting_approval / awaiting_human ──approve / override──▶ dispatched | reimaging | inspecting | ignored
inspecting ──drone visit, INSPECT_HOVER_S──▶ person found → awaiting_approval (dispatch) | none → resolved_empty
```

- Dispatch and inspection always need a human click. Nothing is closed silently.
- **Re-decision:** an incident update that changes the built state of an `awaiting_approval`, `awaiting_human` or `auto_closed` lead re-decides it, appends to its history and re-sorts the queue. Dispatched, ignored, reimaging and inspecting leads are never re-decided.
- A lead is re-imaged at most once (`MAX_PASSES` = 2); reimage and inspection pause the sweep for a drone visit.
- **Inspection hook:** the server emits `inspect.request`; an `inspect.result` before the timer wins (a collision or unreached target goes to a human), otherwise truth resolves it.

## Decisions

**Laya input.** A state of `lead` (detector confidence and band, box size, sector, near-structure, passes), `context` (from the incident picture) and `mission` fields. Unknown fields are omitted, never null. It is rendered as plain-language sentences before scoring (`server/triage/laya_runtime.render`).

**Questions.** `action` (choice: `dispatch_ground_team`, `reimage_zoom`, `close_in_inspect`, `ignore`), `urgency` (score, low to critical), `is_person` (noul). Leads are decided one at a time, FIFO; the `LAYA_TIMEOUT_MS` clock starts when inference begins.

**Ground truth** (`server/mission/truth.py`):

| Object | Pass 1 | Pass 2 |
| --- | --- | --- |
| Decoy | `ignore` | `ignore` |
| Subject, `under_structure` | `close_in_inspect` | `close_in_inspect` |
| Subject, `partial` or `box_px < 20` | `reimage_zoom` | `dispatch_ground_team` |
| Subject, other | `dispatch_ground_team` | `dispatch_ground_team` |

**Intel merge** (`server/incident/merge.py`): sector priority is the highest urgency among non-retracted reports; reported subjects is the maximum count; hazards are the union; the last known point is the latest firsthand report, else the latest naming a landmark; a retraction removes the latest earlier matching report.

**Crew orders.** When a dispatch or inspection is queued, Grok writes the order (approach, hazards and direction, what to verify) in the background. Code supplies every number and direction; approval makes no network call. On timeout a template is used.

## Evaluation

Simulated, with assumptions printed in the output files. Numbers live in `results/` and [docs/GATES.md](docs/GATES.md).

- **Flag flow:** each flag by who handled it and the outcome, plus time from first sighting to crew (`batch/`).
- **Trust:** Laya confidence curve, choice-vs-right-action grid, P(person) calibration (`tools.laya_check`).
- **Grok, live:** order latency, timeouts, stripped digits, intel parsing vs scripted truth (`tools.grok_eval`).
- **Fine-tuning:** stock vs fine-tuned Laya on held-out missions (`tools.laya_finetune`).

## Fly-reflex inspection

Optional and separate: without it, inspections resolve from simulation truth.

**Pipeline** (`reflex/`): 96×96 camera frame at up to 50 Hz → pretrained fly eye ([flyvis](https://github.com/TuragaLab/flyvis) `flow/0000/000`) → looming readout → controller (cruise, brake on looming, 90° saccade, hold heading, steer back; looming ignored during the drone's own turns). Only the eye's motion cells are real flyvis cells; the readout and controller are engineered, and the UI says so.

**In the UI:** the inspection panel flies the route beside a live 3D view of mapped connectome neurons, rotating `debris`, `post` and `clear` per lead, then posts `inspect.result`. If the reflex fails, a labelled scripted operator takeover is shown. On reaching the target, the photo can go to `POST /api/vision` for an advisory Grok person check that changes no lead state.

Extra dev pages: `/inspect.html`, `/flyviz.html`, `/connectome.html`, `/bench.html`, `/capture.html`. Backup clips: `docs/fly-connectome/media/`. Needs CPU PyTorch (Apple Silicon, macOS 14+); never install CUDA PyTorch in this venv. See [HANDOFF](docs/fly-connectome/HANDOFF.md) and [DEMO](docs/fly-connectome/DEMO.md).

## Run

Requires Python 3.12 with [uv](https://docs.astral.sh/uv/) and Node.

```
uv sync && (cd web && npm install)
printf 'XAI_API_KEY=\nXAI_MODEL=\nMONGODB_URI=\n' > .env   # optional; without keys Grok reports offline, writes go to logs/*.jsonl
uv run python -m tools.setup_laya                          # once: downloads the local Laya checkpoint
```

```
(cd web && npm run build) && uv run uvicorn server.app:app --port 8000   # demo: http://127.0.0.1:8000
uv run uvicorn server.app:app --port 8000 & (cd web && npm run dev)      # dev: http://127.0.0.1:5173
```

**With the fly reflex**, run both servers with `--extra fly` (plain `uv run` removes flyvis and torch):

```
uv run --extra fly python -m tools.prepare_flyvis      # once
uv run --extra fly uvicorn server.app:app --port 8000
uv run --extra fly python -m reflex.server             # :8001; check /health shows model_ready: true
```

**Checks and tools**

```
uv run pytest -m "not slow and not network"   # no model, no network
uv run python -m tools.demo_check [--find-seed]
uv run python -m batch.run_eval               # seeds 0-19 → results/summary.json
uv run python -m tools.laya_check             # accuracy, calibration, TAU_ROUTE sweep
uv run python -m tools.grok_eval              # → results/grok.json
uv run python -m tools.laya_finetune          # → results/finetune.json
uv run python -m tools.grok_smoke             # live xAI check
uv run python -m tools.atlas_smoke            # write-behind proof
uv run python -m tools.atlas_setup            # once per cluster
uv run python -m tools.atlas_replay           # push the JSONL spool to Atlas
```

## Interfaces

**WebSocket `/ws/mission`.** Server → web: `mission.snapshot`, `mission.state` (10 Hz), `lead.new`, `lead.decided`, `lead.status`, `lead.order`, `intel.new`, `intel.parsed`, `incident.update`, `dispatch.created`, `inspect.request`, `error`. Web → server: `mission.control {cmd, seed?}`, `lead.approve`, `lead.override {lead_id, action}`, `inspect.result {lead_id, reached, collided, found}`. Validated in `server/protocol.py`.

**HTTP.** `POST /api/ask` (Grok with read-only tools; UI chat disabled, backend intact), `POST /api/vision`, `GET /api/truth`, `GET /api/similar/{lead_id}`, `GET /api/results/{name}`, `GET /api/health`.

**MongoDB.** `runs`, `leads`, `intel`, `incidents`, `qa`; every document carries `run_id`.

## Layout

```
server/   app, config, protocol; mission/ incident/ triage/ grok/ store/
reflex/   fly-eye reflex server, controller, looming readout
web/      Vite + TypeScript UI
batch/    evaluation runner and metrics
tools/    smoke tests, calibration, evaluation, Atlas setup
data/  results/  tests/
docs/     GATES (decisions), LAYA (runtime), PLAN (original build plan), fly-connectome/
```

**Out of scope:** real drones, autonomous navigation, multi-drone coordination.
