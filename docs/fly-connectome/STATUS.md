# Implementation status

Completed: 0.1 scaffold, 0.4 flyvis smoke, 6.1 frame protocol, 6.3 fly eye,
**6.4 looming readout and controller (with an uncalibrated θ)**.
Next: **6.2 inspection scene** (shared with Monish) or **7.1 viz stream** (ours).
Step 8.2 must calibrate θ before any avoidance claim.

Read this folder's `README.md` and `MASTER_PLAN.md` first when resuming.

## Step 6.4 — looming readout and avoidance (2026-09-26, Linux CPU)

Files: `reflex/looming.py`, `reflex/controller.py` (new), `reflex/server.py`,
`reflex/config.py` (`THETA_UNCALIBRATED`, `REFLEX_DEVICE`), `reflex/hexeye.py`
(index class renamed `RegionIndex`), `tests/test_controller.py` (new),
`tests/test_reflex_protocol.py`.

- `Readout(alpha)`: S = EMA(Σ q), dLR = EMA(q_L − q_R), starting from 0.
- `Controller(theta)`: S > θ latches a brake for `BRAKE_LATCH_S` (25 frames,
  counted in k). While braking, |dLR| > 0.5θ swerves away from the more-looming
  side. reflex_on=0 always returns none.
- θ: `bench/thresholds.json` `{"theta": x}` if present, else
  `THETA_UNCALIBRATED = 0.2`. `/health` reports `theta` and `theta_calibrated`.
- The server loads FlyEye once at startup. `/health` reports `model_ready`, or
  the load error if the fly extra or weights are missing. Each episode resets
  the eye (about 1.6 s, off the event loop). Live and bench_closed frames run the
  eye and report real S/dLR even with reflex_on=0; bench_record skips the model.
  Without a model, those frames return an error instead of fake values.

How θ = 0.2 was chosen (hand-set, **not calibrated**): the maximum S seen on
non-approaching synthetic stimuli was 0.177. That covers a large disc appearing
suddenly (0.168), a texture sliding sideways (0.164) and a contracting disc
(0.177). Onset spikes settle within about 0.2–0.4 s.

End-to-end (real server, real WebSocket, pretrained model, 1 s hold then a
disc approaching at 3 m/s from 3 m, filling the frame at approach frame 45):

| reflex | first command | S max | ms/frame p50 / p95 (after reset) |
| --- | --- | --- | --- |
| on | brake at approach frame 40 (≈0.2 s before contact) | 0.403 | 16.6 / 20.2 |
| off | none | 0.403 | 16.3 / 18.6 |

**Known limitations (important for 8.2 and the demo):**

1. **Warning time is short.** The brake fires about 0.2 s before contact at
   3 m/s; the README target is ≥ 0.79 s. θ is uncalibrated, and the region-averaged
   looming signal only grows large late in the approach.
2. **Swerve does not discriminate side.** §4.8 defines out/in relative to the
   image centre. For an object entirely in the left half, its outward and inward
   edges both sit in region L and cancel. A left-offset approach gave dLR ≤ 0.044,
   about the same as head-on, so no swerve fired. Swerve is also first in the
   plan's cut order.
3. **Sideways texture motion raises S to about 0.15**, near θ. Forward flight
   through a cluttered scene makes global expansion flow, so false brakes on
   the carport scene are likely until 8.2 calibrates θ on real episodes.
4. A 50 Hz live stream has little CPU headroom (p95 ≈ 20 ms). Mac is unmeasured.

Demo: a private claude.ai page, "FlyBy Reflex Bench", replays recorded
pretrained output (camera, R1–R6, T4/T5 maps, S/θ trace) for a head-on approach,
a left-offset approach and a sliding texture. It was generated from session
scratch scripts, not repo code. The head-on S trace matched the live-server
run exactly. It is not the carport scene.

Validation: `uv run --extra fly pytest -m "slow or not slow"` — 48 passed
(includes brake-before-fill on the real model, latch, reflex-off, swerve
direction on synthetic energies, and θ file loading).

## Step 6.3 — fly eye (2026-09-26, Linux cloud container, CPU)

Files: `reflex/hexeye.py` (new), `tests/test_hexeye.py` (new),
`tools/check_readout_baseline.py` (new), measurements
`linux-cpu-smoke.json` and `readout-baseline.json`.

- `FlyEye(device)` loads pretrained `flow/0000/000` (checksum-verified setup),
  checks native node types against `data/flyvis_layout.json`, and builds a
  `Readout` from the layout and `SUBTYPE_DIR`.
- `reset()`: new state, `WARMUP_S` (2.0 s) of gray, rest = mean of last 0.2 s.
- `step(frame_u8)`: frame / 255 → BoxEye → one network step with persistent
  state. Returns `(energies, activity)`; energies are `{L,R,U,D: {out, in}}`.
  `last_ms` holds the step time. `deviation()` = activity − rest.
- Regions use `col_x/col_y` (L x<0, R x>0, U y>0, D y<0). Each T4/T5 subtype has
  exactly one node per column; the readout checks this.

**Deviation from README §4.8 (needs team awareness):** energies use
`relu(activity − rest)`, not `relu(activity)`. Measured with the pretrained model
(`python -m tools.check_readout_baseline`), raw rectified activity already has a
resting out−in offset at gray: q = L 0.308, R 0.151, U 0.130, D 0.091.
That would give S ≈ 0.68 and dLR ≈ +0.16 (a rightward swerve bias) with nothing
moving. With the raw readout, a contracting disc still gave outward > inward
everywhere. With rest subtracted (mean q over 1 s):

| stimulus | L | R | U | D |
| --- | --- | --- | --- | --- |
| expanding disc | +0.067 | +0.032 | **+0.001** | +0.126 |
| contracting disc | −0.063 | −0.086 | −0.050 | −0.034 |
| static disc | +0.007 | −0.014 | −0.017 | +0.052 |
| rightward texture | −0.257 | +0.267 | +0.107 | −0.071 |

The expanding-disc U margin is very small, and the static disc gives D +0.05.
Treat these as single-stimulus measurements, not calibration. θ must come from
Step 8.2 data; per-region behavior on carport scenes is unverified.

Validation:

- `uv sync --extra fly`; `python -m tools.prepare_flyvis` — SHA256 verified
  (needs `drive.usercontent.google.com` in the environment's network allowlist;
  the user added it).
- `python -m tools.flyvis_smoke --device cpu` reproduced Step 0.4 on Linux:
  passed, identical SUBTYPE_DIR, orientation passed, gray drift 0.00025,
  total p50/p95 17.3/21.7 ms. The re-exported layout differed only by
  <1e-7 relative float noise in type-edge weights; the committed layout was kept.
- `uv run --extra fly pytest -m "slow or not slow"` — 40 passed. Includes the
  four README 6.3 stimuli on the pretrained model and an untrained-network
  plumbing test (not evidence of model behavior).
- Pretrained `FlyEye.step` on this container (4 CPUs, 4 threads, 250 warm frames):
  p50 16.1 ms, p95 19.6 ms, max 50.8 ms. This is under the 20 ms frame budget,
  with little headroom. Mac timing is still unmeasured.
- `reset()` takes about 2 s (100 warm-up steps). Step 6.4 must not block the
  WebSocket event loop with it, and the live scene should allow for it.

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
