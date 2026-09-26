# Implementation status

Completed: 0.1 scaffold, 0.4 flyvis smoke, **6.1 reflex frame protocol**.
Next active step: **6.3 fly eye (`reflex/hexeye.py`)**. Step 6.2 (inspection
scene) is shared with Monish and can proceed in parallel against the 6.1 socket.

Read this folder's `README.md` and `MASTER_PLAN.md` first when resuming.

## Step 6.1 — reflex process and protocol (2026-09-26)

Files: `reflex/frames.py` (new), `reflex/server.py`, `reflex/config.py`
(`BENCH_FRAMES_DIR`, `CLOSED_LOOP_PATH`), `tests/test_reflex_protocol.py` (new).

Implemented on `ws://127.0.0.1:8001/ws/reflex`:

- Binary frame: `<IIBBH` little-endian header (episode, k, reflex_on, mode, pad)
  then `FRAME_R²` = 9,216 grayscale bytes, 9,228 bytes total. Row 0 is the top of
  the image. Rejected: wrong length, reflex_on not 0/1, mode not 0–2, pad ≠ 0.
- Reply per frame: `{k, cmd, S, dLR, ms}`. `ms` is measured server handling time.
- Text messages (web → reflex): `{"type": "episode.begin", "episode": u32, "params": {}}`
  and `{"type": "episode.end", "episode": u32, "result": {}}`. Reply
  `{"ack": "<type>", "episode": n}`.
- Errors reply `{"error": "..."}` and keep the connection open.
- Per-connection session, one active episode. Live frames with a new episode id
  start a fresh episode; bench-mode frames must be inside begin/end for the same id.
  `k` must strictly increase; mode and reflex_on are fixed per episode.
- `bench_record`: on `episode.end`, writes `bench/frames/<episode>.npz` with
  `frames (n,R,R) uint8`, `k u32`, `reflex_on`, `params` and `result` (JSON strings).
- `bench_closed`: on `episode.end`, appends `{episode, reflex_on, params, result}`
  to `bench/closed_loop.jsonl`. Both outputs are local and Git-ignored.

Deviations / choices the README did not specify:

- **No eye or controller is wired yet**, so every command is `none` with
  `S` and `dLR` = `null`. Nothing is fabricated; Step 6.4 replaces this.
  `/health` reports `status: "protocol"`, `model_ready: false`.
- Envelope `type` field and the `ack`/`error` replies are our additions; the
  browser distinguishes reply kinds by key (`cmd`, `ack`, `error`).
- Frame-header endianness set to little-endian (agreed in docs/TEAM.md).
- Closed-loop lines also carry `episode`, `reflex_on` and `params` so results can
  be split by reflex state and seed.
- An empty bench episode ending returns an error and writes nothing.
- `eye.layout` on connect is deferred to Step 7.1 (`reflex/viz.py`), where the
  README places it.

Validation (Linux cloud container, Python 3.12, `uv sync` without the fly extra):

- `uv run pytest -m "not slow and not network"` — 30 passed, 2 skipped
  (skips are the model-dependent layout tests; weights are not installed here).
- Live-socket check: started `python -m reflex.server --port 8011`, sent three
  live frames over a real WebSocket client, a 5-byte malformed frame, and an
  `episode.begin`. Received three `none` commands (ms 0.01–0.05), the length
  error and the ack; `/health` returned the protocol status. Server stopped.
- Isolation guard (`tests/test_scaffold.py`) still passes for the new files.
- Not run: browser client (Step 6.2 does not exist yet), Mac, 50 Hz sustained load.

## Step 6.3 — next action

Implement `reflex/hexeye.py` `FlyEye.reset/step/deviation` from the path
verified in `tools/flyvis_smoke.py` (persistent state, dt = 0.02 s, FRAME_R 96,
WARMUP_S 2.0, rest = mean over last 0.2 s). Regional energies use
`col_x/col_y` and `SUBTYPE_DIR`. Add slow tests: expanding/contracting disc,
rightward texture, 5 s gray. Report ms/step p50/p95. Requires
`uv sync --extra fly` and `python -m tools.prepare_flyvis` on the test machine.

## Step 0.4 results (from `measurements/cpu-smoke.json`, Windows CPU)

- flyvis 1.2.0, torch 2.14.0+cpu, `flow/0000/000`, 4 threads.
- 45,669 nodes, 65 types, 721 columns; FRAME_R 96 (resampled internally to 391×391).
- SUBTYPE_DIR measured: T4a/T5a left, b right, c up, d down; orientation passed.
- Gray after 5 s: max deviation 0.00025. WARMUP_S raised from 0.5 to 2.0 s
  (0.5 s leaves 0.241 drift; see `measurements/gray-settling.json`).
- Warm step p50/p95: preprocess 3.6/4.8 ms, inference 15.1/18.7 ms,
  total 18.8/23.0 ms. Windows CPU only; no Mac or GPU timing yet.
- THETA remains unset (Step 8.2).

## Repository handoff

- Work and push only on `fly/connectome`. Do not push/merge to main. Never force-push.
- Remote: https://github.com/monishramj/flyby. Fetch before pushing; Monish may
  be working in parallel.
- No long-running services or model downloads are active.

## Compute decision

No Colab/H100 job needed. Demo host is the Mac (chip/RAM unconfirmed);
measure both models together there before promising 50 Hz.
