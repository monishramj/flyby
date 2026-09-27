# FlyBy fly-reflex: handoff (for Monish / whoever runs the demo Mac)

Branch `fly/connectome` (monishramj/flyby). Read this first; details live in
`STATUS.md` (numbers, history), `INTEGRATION.md` (contract, merge table) and `DEMO.md`.

## What it is

The drone's close-in inspection flies with a **fly-brain reflex in the loop**: a 96×96
camera frame at up to 50 Hz → pretrained connectome-constrained fly eye (flyvis
`flow/0000/000`, 45,669 cells) → our engineered looming layer (a centre-weighted
"collision cone" plus 7 LPLC2-style units, fitted on simulated flights) → a fly-inspired
controller: cruise to the waypoint → brake on looming → 90° saccade away → hold the
heading 1 s → steer back. Looming is ignored during the drone's own turns
(efference copy). The browser shows the flight, the eye view and live activity on real
connectome neurons (fly-brain, 30,946 left-eye neurons mapped, 100% coverage).
Everything after the T4/T5 motion cells is engineered, not flyvis cells; say so on screen.

## Run it (Mac or any machine)

```sh
uv sync --extra fly                                  # CPU PyTorch only in this venv
uv run --extra fly python -m tools.prepare_flyvis    # once: verified 3.4 MB weights
uv run --extra fly python -m reflex.server           # :8001 (forces CPU itself)
cd web && npm ci && npm run dev                      # :5173, proxies /ws/reflex and /reflex
```

Pages: `/inspect.html` (one inspection flight + live 3D brain), `/flyviz.html` (eye,
looming trace, circuit), `/connectome.html` (3D view, recorded), `/bench.html`,
`/capture.html` (tools). Check `http://127.0.0.1:8001/health` shows
`"model_ready": true, "readout": "learned", "theta_calibrated": true`.
Do **not** install CUDA PyTorch into this venv (it broke CPU loading and coincided with
reflex crashes on Windows); use a separate venv for GPU training.

## Integration: the one call

```ts
import { runInspection } from './scene/flight';
const outcome = await runInspection(panel, { lead_id, person, waypoints, maxWallS: 27 });
const { reached, collided, found } = outcome;
send({ type: 'inspect.result', payload: { lead_id, reached, collided, found } });
// Display outcome.waypoints separately; server payloads reject extra fields.
```

- `waypoints`: `[{id, x, z}]` in the scene's metres (x right, forward is −z; the drone
  starts at z = 6 facing −z; the carport's front beam is at z = 0, roof to z = −5).
  Default route: `entry (0, 1.5)` → `target (0, −2.5)` (under the roof, where the person
  is drawn). The last waypoint is the target.
- `outcome` keeps the rehearsal's fields and adds per-waypoint status:
  `{lead_id, reached, collided, found: bool|null, waypoints: [{id, status}], t, frames,
  min_clearance_m, realtime_factor, reflex_ok, late_replies}`;
  `status` ∈ `reached | skipped | collided | pending` (pending = not attempted).
  `reached` = the target was reached. Not reached → the mission should send the lead to a
  human (`awaiting_human`), not mark it empty.
- A waypoint not reached in **8 s** of flight is skipped, so a route never loops forever.
- The flight is **lockstep**: each frame waits for the reflex reply, and the sim never runs
  ahead of real time. `realtime_factor` < 1 means the machine was slower than real time.
- `attachReflexStream(stream)` (same module) feeds the live eye/brain views.

## Mission timing: the window we need

A 2-waypoint route takes ~7 s of flight when clear and ~10–11 s with one detour; the
worst case is 1 s hover + 8 s + 8 s = 17 s of flight before it gives up. With the fast
eye (`aa9afda`) the reflex keeps up with 50 Hz on the Windows laptop (idle, no browser),
so wall time ≈ flight time + panel setup; the Mac is unmeasured.
Current triage gives an inspection ~10 s of wall time (`INSPECT_HOVER_S` 40 sim-s at
`LIVE_TIME_SCALE` 4); the rehearsal capped flights at 8.5 s to beat it.
**Needed:** either the mission waits for `inspect.result` (recommended, with a hard cap
of ~30 s wall), or raise `INSPECT_HOVER_S` to ≥ 120 sim-s (30 s wall at ×4). Then pass
`maxWallS` a few seconds below the mission cap.

## Starting point for the merge

The local branch remains `rehearsal/triage-fly` (head `a72eb03`, Windows laptop);
never push it. `rehearsal-triage.patch` beside this file is a `git diff` against triage
`68033b6` of only the 20 files the rehearsal resolved or changed (conflict resolutions
plus the mission prototype: server/app.py, mission/loop.py, protocol.py, web/src/
inspection.ts, main.ts, ws.ts, store.ts, queue.ts, style.css, scene/flight.ts,
package/uv locks, docs). To reproduce: merge `fly/connectome` into `triage`, then take
these 20 files from the patch; every other fly file comes unchanged from `fly/connectome`.
The panel now reads waypoints/realtime_factor and accepts maxWallS (27 s default).
Result compatibility: reached defaults true for old clients, found defaults null;
a collision or not-reached result always needs a human. The retry token and reset
checks remain. The updated rehearsal passed 159 tests (7 slow deselected) and
TypeScript/build checks. See INTEGRATION.md before applying: **the mission deadline
still needs changing** (wait for the result with a ~30 s cap, or temporarily set
INSPECT_HOVER_S=120 at scale 4). The patch does not implement that ownership handshake.

## Honest numbers (carport, 90° camera, 1.5 m/s, pretrained eye)

- **Detection, held-out flights** (100 flights never used for tuning): stopped in time for
  36/63 collisions; 1/37 false brakes plus 2 brakes > 2.5 s early. By obstacle, in time:
  falling debris 20/20, posts 12/20, sagging beam 4/20.
- **Route flights, closed loop** (entry → under the roof, efference copy on; 8 flights,
  seeds 0–2, not a held-out benchmark): 7/8 reached the target, including both
  debris flights (brake, turn, 0.56 m clearance, back to the target in ~10 s);
  the sagging-beam flight collided. Reflex-off comparison on this route: the post does
  not block it, so only debris/beam differ.

## Known limits (say them, don't hide them)

- Thin posts and cables are near the eye's resolution (721 facets; ~3.8° each at 90°).
- The sagging beam is the weakest case (only its lower edge moves near the centre).
- The readout was fitted on straight flights; during turns it is blind by design
  (efference copy). Training on turning flights would remove that.
- 1.5 m/s is the fitted speed. 1.0 m/s needs a refit (below) before using it.
- Everything is simulation; the carport is 2.8 × 5 m while triage's carport is 24 × 18 m
  (treat the scene as a close-in section, or align sizes later).

## Retrain (optional, GPU laptop in a separate CUDA venv)

With the reflex and Vite running (see Run it):
1. Record: `/bench.html?mode=record&n=40&seed0=100&fov=90` → move `bench/frames` to
   `frames_train`; `&n=20&seed0=500` → `frames_test`.
2. Replay: `python -m tools.record_drive frames_train drive_train --device cuda --batch 64`
   (and for test). Batched replay is bit-identical to the CPU path.
3. Fit: `python -m tools.fit_readout drive_train drive_test --adapt 0.1 --write`, then
   restart the reflex. Choose settings on train only; report the test numbers once.
Worth adding first: more beam variety, turning flights, and `NAV_CRUISE_MPS = 1.0`.
