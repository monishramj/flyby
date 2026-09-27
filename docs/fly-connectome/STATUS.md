# Implementation status

**Start with `HANDOFF.md`** (run, integrate, timing, honest numbers, limits).

Completed: 0.1, 0.4, 6.1, 6.3, 6.4, fly-inspired navigation (brake → 90° saccade →
hold heading → goal steering; efference copy during own turns), waypoint routes in
lockstep, carport scene + bench + calibration tools, fitted cone + learned-units
readout with adaptation, live viz stream, eye/trace/circuit panels, live 3D connectome.
**Status:** held-out detection: stopped in time for 36/63 collisions (debris 20/20,
posts 12/20, beam 4/20), 1/37 false brakes + 2 early brakes. Route flights (entry →
under the roof, 8 flights): 7/8 reached the target; the sagging beam collides.
Integration with `triage`: `INTEGRATION.md` + `HANDOFF.md` (nothing pushed there).

## Viewer visuals + experimental house scene (2026-09-27)

`web/src/scene/dress.ts`: the chase (viewer) camera now shows a quadcopter with spinning
props and nav lights, coloured materials (brick, rusted posts, corrugated roof, plywood
debris, concrete), sun shadows, sky and haze, a casualty figure, waypoint beacons, a
flight trail with brake/saccade markers, and a smoothed camera. All of it uses three.js
layers (CHASE viewer-only, EYE fly-only), so **the fly camera's input is unchanged**:
recaptured `debris:0` and `beam:1` route flights match the pre-change capture in every
fly frame (515/515, 535/535 identical pixels), every command and S, and the result.
(A first attempt changed the benchmark seeds through one extra random draw; caught by this
check and fixed.) Held-out numbers therefore still apply unchanged.
`house` (dev page only, marked experimental; not in `SCENARIOS`, bench or mission defaults):
a gutted open-plan house (collapsed facade, cutaway walls for the viewer, hanging ceiling
panel, toppled wardrobe), route entry → living room → target. **The readout does not
transfer indoors:** 6 seeds reflex on: 0/6 reached the target (1 skipped it, 5 collided);
every flight brakes falsely at take-off, then hits the panel or wardrobe without braking.
Reflex off (2 seeds): both hit the panel. Earlier designs with a solid front wall or a
door frame dead ahead failed earlier: a looming reflex reads a doorway as a collision.
Making it work needs recording house flights and fitting/scoring the readout on them.

## Handoff to Monish (2026-09-27)

Pushed since the last handoff: backup recording (`inspect.html?record=1` +
`tools/record_inspection.py`, localhost only), three clips with measured JSON in
`media/` (debris reaches target, clear reaches target, beam collides), lockstep chase-view
fix (`d80fb80`), `rehearsal-triage.patch` (20 files, applies to triage `68033b6`).
New: `tools/merge_into_triage.sh` reproduces the merge on a local branch; verified here:
158 passed, 1 skipped, `tsc` + build clean. Fly branch alone: 76 fast tests pass.
**Open, Monish's side:** mission deadline (wait for `inspect.result` with a ~30 s cap, or
`INSPECT_HOVER_S` 120 at ×4); Mac live-rate check. Not done: retrain at 1.0 m/s / beam
variety (current weights are the 1.5 m/s fit).

## Waypoint routes and efference copy (2026-09-27)

`web/src/scene/inspect.ts`: ordered waypoints; each reached, skipped after
`WAYPOINT_TIMEOUT_S` = 8 s, or collided. `web/src/scene/flight.ts`: lockstep (waits for
every reply, never ahead of real time), default route entry (0, 1.5) → target (0, −2.5),
result keeps `{lead_id, reached, collided, found}` and adds `waypoints`,
`realtime_factor`. `reflex/controller.py`: a brake with the goal > 100° off-heading turns
toward the goal (no circling); looming ignored while self-turning > 10°/s and 0.2 s after
(goal-steering turns caused false brakes that chained into wandering).
Route capture (`tools.capture_flights --route`, 90°, cloud CPU): post ×2, debris ×2,
clear, near_post, post reflex-off: target reached; beam: collided. Before the efference
copy: post ×2 skipped both waypoints and debris skipped the target.
Headless `inspect.html` here runs at ~0.12× real time (software rendering of the 3D
connectome); use the capture page for tests in this container.

Read this folder's `README.md` and `MASTER_PLAN.md` first when resuming.

## Faster eye sampling: reflex now keeps up with 50 Hz (2026-09-27, Windows CPU)

`aa9afda`: `FlyEye._step` samples hexals with a precomputed gather equivalent to flyvis
`BoxEye` (bilinear resize + zero pad + 13×13 mean + receptor sampling is linear and
separable). Built from BoxEye's own resize at init and checked against BoxEye on 3 random
frames (raises if max abs err > 1e-5); `eye.box_eye` unchanged for batched callers.
Activity max abs diff vs BoxEye over 100 steps: 2.3e-6. Test: `test_hex_sampler_matches_flyvis_boxeye`.

Live reflex, real pretrained model, CPU 4 threads, machine idle (CPU ~8 %, 4.4 GB free),
throwaway Python WebSocket client (no browser), 500 live frames of a growing dark disc per
run, 2 runs each, servers new → old → new; the old path = BoxEye patched back in:

| eye path | lockstep replies/s | lockstep latency p50/p95 | paced 50 Hz: replies/s | paced 50 Hz latency p50/p95 | server `ms` p50/p95 |
| --- | --- | --- | --- | --- | --- |
| gather (new) | 56.1–58.2 | 16.5–17.0 / 20.5–21.2 ms | 49.9–50.0 | 17.5–18.2 / 35.5–42.8 ms | 15.4–15.9 / 18.0–19.3 |
| BoxEye (old) | 47.3–47.9 | 20.5–20.7 / 24.8–25.2 ms | 48.4–48.7 | 124–181 / 283–357 ms (backlog) | 19.1–19.4 / 22.5–23.2 |

All replies in order; 100 viz packets per 500 frames; no reflex crashes. With the old path a
50 Hz sender builds a backlog (replies 0.1–0.4 s late); with the gather it does not, on an
idle machine. Not measured: a browser flight after this change (the page's own rendering
shares the CPU, which is why earlier browser flights saw 20–36 replies/s), and the Mac.

## Windows laptop GPU/CPU benchmark (2026-09-26, measurement only, checkout `1e22904`)

Machine: i7-11800H (8C/16T), 15.7 GB RAM, RTX 3050 Ti Laptop 4 GB (driver 566.07), AC
power. Free RAM was only 0.1–3.1 GB during the runs (other apps open). torch
`2.14.0+cu126` was installed into `.venv` for this and has since been **reverted to the
locked CPU wheel** (with CUDA torch, `FlyEye(device="cpu")` fails unless
`CUDA_VISIBLE_DEVICES=-1`; flyvis picks its RNG device at import). For GPU work use a
separate venv.

`tools.flyvis_smoke`, 200 timed frames, p50 / p95 ms (all checks passed, gray drift 0.000253):

| device | preprocess | inference | output | total |
| --- | --- | --- | --- | --- |
| CPU (4 threads) | 4.05 / 6.60 | 16.14 / 22.02 | 0.13 / 0.24 | 20.77 / 28.19 |
| CUDA | 1.07 / 2.05 | 1.26 / 1.71 | 0.13 / 0.34 | 2.58 / 3.67 |

Batched stepping (random 96×96 frames, 30 warm-up + 200 timed steps, no host readback):

| B | CUDA median ms/step | CUDA frames/s | CUDA peak alloc MiB | CPU median ms/step | CPU frames/s |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.63 | 263.5 | 150 | 17.47–21.61 | 43.7–54.5 |
| 8 | 6.77 | 1,158 | 276 | 62.66–78.23 | 98.7–126.2 |
| 32 | 20.87 | 1,520 | 705 | crashed | – |
| 64 | 38.95 | 1,636 | 1,279 | crashed | – |
| 128 | 76.06 | 1,678 | 2,420 | crashed | – |

CUDA throughput plateaus at ~1.6–1.7k frames/s from B=32 (flyvis BoxEye filters each sample
in a Python loop). CPU B≥32 died with native Windows access violations on both attempts
(different faulting modules each time); not an out-of-memory error from Python.
Bench record mode: 10 flights (3,704 frames) in ~14.6 s wall; record mode does not run the
model, so this is render + transport + save only. The reflex process crashed natively
after/at connect in 2 recording attempts with CUDA torch installed; no crashes were seen
in later runs after reverting to CPU torch (13+ connections), cause unconfirmed.

## Steps 7.2 + 7.3 panels: eye, looming trace, circuit (2026-09-27, Windows)

New, fly-lane files only: `web/src/flyviz/eye.ts`, `trace.ts`, `circuit.ts`, `page.ts`,
`web/flyviz.html` (dev page). All three panels draw only from `VizStream` (eye.layout +
latest deviations + 10 s ring of S/dLR/cmd); they redraw on rAF only when a new viz packet arrived.

- **eye.ts**: 721 flat-topped hexes at (col_x, col_y), y up; hex size from the measured
  column spacing (the lattice is anisotropic: vertical step 0.0667, diagonal 0.0734).
  Tabs: receptors (mean R1–R6 deviation per column, grey), motion (strongest rectified
  T4/T5 subtype per column, hue = its `subtype_dir` direction, legend lists subtypes),
  looming (outward − inward rectified T4+T5 by the column's own position, diverging).
  The looming layer is computed in the browser without adaptation/EMA and is labelled
  "not the reflex's cone score". Colour scales follow a decaying recent peak (shown).
- **trace.ts**: Chart.js S over the last 10 s of frame time, θ line from `S_theta` (none
  drawn if null), dLR subplot, markers at onsets of brake / saccade_left / saccade_right /
  arrived from the viz header cmd (10 Hz resolution).
- **circuit.ts**: SVG, all 65 types (R1–R8 | L1–L5, Lawf1/2, Am, C2, C3 | ON Mi1 Tm3 Mi4
  Mi9, OFF Tm1 Tm2 Tm4 Tm9 | T4a–d, T5a–d | 31 others dimmed). Edges: strongest 3 inputs
  per column type from `type_edges` (thickness log weight, colour sign). Brightness = mean
  |deviation| per type. Dashed box "Our readout — not flyvis cells": Cone, 7 LPLC2-style
  units, S = max(cone/θc, 1 + units − θu) (text chosen from reflex `/health` readout =
  learned/default, matching `reflex/looming.py`). Cone/unit values are not streamed, so
  they stay unlit; S (header), Brake and Turn (header cmd) are live.
- **Driver** (`page.ts`): opens `/ws/reflex` via scene/inspect.ts `ReflexLink` (imported,
  not edited) and flies one closed-loop carport inspection (`Inspection`, `makeSpec`)
  in live mode (frame mode 0), lockstep (each frame waits for its reply, paced to at
  most real time). The 96×96 frame sent is shown beside the eye. URL
  `flyviz.html?scenario=debris&seed=0&fov=90&reflex=on&auto=1`; `window.__flyviz` holds counters.

Checks: `npx tsc --noEmit -p .` exit 0. Live: `python -m reflex.server` (pretrained model,
CPU, readout learned, θ = 1.0 calibrated) + Vite dev, desktop app built-in browser
(~1500 px wide, rAF not vsync-capped). debris seed 0, fov 90, reflex on, twice (same
result both times: no collision, not arrived, timed out at 25.02 s sim, 1251 frames, min
clearance 0.606 m, 6 brake onsets each):

| run | replies/s | wall s | viz received | panel redraws | panel Hz (wall) | rAF fps | p50 / p95 / p99 / max ms | gaps > 50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 35.9 | 34.8 | 251 (k 0→1250) | 250 | 7.18 | 141.5 | 6.9 / 7.1 / 7.2 / 236 | 2 |
| 2 | 36.3 | 34.4 | 251 | 250 | 7.26 | 144.0 | 6.9 / 7.1 / 7.2 / 13.9 | 0 |

Viz = exactly 10 per second of frame time; panels lag real time only because the
lockstep reflex runs at ~0.72× real time. One eye.layout per connection, 0 dropped viz.
Run 1's two stalls (236, 188 ms) coincided with my screenshots/tab clicks; run 2 was not
touched. Screenshots checked: receptors mirror the frame (dark debris at right edge,
darker ground half); during a left saccade the motion layer is mostly "right" (red),
as expected for yaw-left image flow; trace shows θ line, brake/saccade markers; circuit
Brake/Turn light with the header cmd. All servers stopped.

Open: `flyviz.html` is dev-only (not in vite.config.ts build inputs; not edited). Not yet
placed in the Fly tab / inspect overlay (Step 7.2 layout). The first S sample after
episode start is large (~8.5, during the 1 s hover when the controller ignores looming),
which compresses the S axis for 10 s. Debris seed 0 never arrives (repeated brakes).

## Live 3D connectome view moved out of scene/ (2026-09-27, Windows)

File ownership: `web/src/scene/*` belongs to the cloud session, so the live view now
lives in fly-lane files and `scene/` is back to exactly 3171080.

- New `web/src/flyviz/live.ts` (`mountLiveConnectome(host)`): a `VizStream` attached via
  `attachReflexStream()` (3171080); on every new viz packet `VizStream.latest` (45,669
  deviations, identity node map per `data/flybrain_node_map.json`) goes to
  `Connectome3D.setActivity()`. Caption "LIVE · live flyvis model activity from the
  reflex during this flight · frame k · S · cmd"; the view keeps its label and
  attribution. A malformed viz packet is dropped and never becomes a reply.
- `inspect.html` / `inspect-page.ts`: the view sits beside the flight (third column,
  below it under 1100 px) and is **built at page load, before any flight**. Fly never
  waits on it; load failure → "connectome view unavailable" + short error, flight runs.
- `connectome3d.ts`: only a `renders` counter (for measuring the view's frame rate).
- Reverted the 65e2579 hunks in `web/src/scene/flight.ts` and `web/src/scene/inspect.ts`
  (no later commit touched `web/src/scene/`). Checked first: in the 3171080 `ReflexLink`,
  binary messages return before the reply queue and `eye.layout` is filtered, so
  layout/viz still never count as replies; confirmed live (below).

Checks: `npx tsc --noEmit -p .` exit 0; `pytest -m "not slow"` 71 passed, 7 deselected.
Live: `python -m reflex.server` (real pretrained model, CPU) + Vite dev, headless Edge
(Intel UHD, ANGLE D3D11, 1600×900, not vsync-capped), scenario `clear`, seed 0, the view
loaded before pressing Fly:

| run | view | view load (page) | long task at load | replies in order from k=1 | reply Hz | viz/s | view renders/s | rAF fps | rAF p95 / max ms | gaps > 50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | on | 2.19 s | 199 ms | yes (205 replies) | 19.6 | 3.92 | 3.9 | 116.3 | 20.8 / 55.5 | 1 |
| 2 | on | 2.33 s | 146 ms | yes (335) | 33.7 | 6.80 | 6.8 | 129.8 | 13.9 / 27.8 | 0 |
| 3 | blocked | error shown | none | yes (335) | 34.8 | 7.05 | 0 | 143.8 | 7.1 / 7.3 | 0 |
| 4 | on | 1.71 s | 89 ms | yes (336) | 32.8 | 6.59 | 6.6 | 130.8 | 13.8 / 27.9 | 0 |

All flights reached the target, no collision; one eye.layout per connection; every viz
received was shown (runs 1/2/4: 41/67/68). In time with the flight: sampled each
second, the view's frame k trailed the newest command reply's k by 0–4 frames
(e.g. run 2: 31/33, 96/98, 201/203). The geometry-build long task (89–199 ms) now
happens at page load; in flight the long tasks were 59–117 ms within 0.25 s of Fly
(also with the view blocked, so the flight's own start) plus one 57 ms at the end of
run 1. The 0.1–0.9 s in-flight build stalls of the old inset were not seen. Screenshots checked (neurons lit beside the
flight; error text with assets blocked). All servers stopped.

Open: run 1 (first flight after reflex start) had lower reply/viz rates (19.6 Hz /
3.9 per s); the reflex backlog (issue 1 below) remains. Bench record mode not re-run
after the revert (its `ReflexLink` code is identical to 3171080). If Fly is pressed
before the view finishes loading (~2 s), the build still lands in that flight.

## Live connectome inset in the inspection flight (2026-09-27, Windows) — SUPERSEDED (moved to `flyviz/live.ts`, see above)

Changed: `web/src/scene/inspect.ts`, `web/src/scene/flight.ts`, `web/src/flyviz/connectome3d.ts`.

- `ReflexLink` now owns a `VizStream` (`link.viz`): every message goes to
  `viz.handle()` first (binaryType arraybuffer) and is a reply only when handle()
  returns false; a malformed viz packet is logged and dropped, never taken as a reply.
  The optional side channel (dd67770) and `attachReflexStream()` (3171080) still work:
  messages `viz` consumed are forwarded to it. Resolves Step 7.1 open issue 1.
- `runInspection` panel: an inset (bottom-right of the chase view) with the Step 7.4
  `Connectome3D`, loaded by dynamic import after the reflex connects. The flight loop
  never awaits it; each tick it calls `setActivity(link.viz.latest)` only when a new viz
  header arrived. Caption: "LIVE · flyvis model activity from this flight · frame k · S ·
  cmd"; the view keeps its label and attribution. Load failure → "connectome view
  unavailable" + short error, flight unaffected. No reflex → "no live flyvis activity",
  assets not loaded. The previous flight's view is disposed on the next flight.
- `Connectome3D`: renders only when activity, camera (OrbitControls.update() true) or
  size changed, instead of every frame; stops and disposes itself if its canvas is
  removed from the page; `dispose()` is idempotent.

Checks:
- `npx tsc --noEmit -p .` exit 0. `pytest -m "not slow"`: 71 passed, 7 deselected,
  **0 errors** (the 12 Windows `test_malformed_frames_are_rejected` errors are gone
  since dd67770).
- Live, real pretrained model (`python -m reflex.server`, CPU torch 2.14.0+cpu), Vite dev.
  (a) `bench.html?mode=record&n=2&fov=90` → `BENCH DONE 10`, 10 npz written, no errors
  (frames deleted afterwards).
  (b) `inspect.html`, scenario `clear`, seed 0, headless Edge 154 (Intel UHD, ANGLE D3D11,
  1400×850, rAF not vsync-capped), flights alternating view on / assets blocked
  (fetch+Worker rejected in-page, so the error path was exercised too):

  | run | view | frames | replies in order from k=1 | reply Hz in flight | viz/s in flight | late_replies | rAF fps | rAF p95 / p99 / max ms | gaps > 50 ms |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 1 | on | 336 | yes | 20.9 | 4.30 | 327 | 132.0 | 7.3 / 14.1 / 194 | 2 |
  | 2 | blocked | 335 | yes | 23.7 | 4.80 | 331 | 143.1 | 7.1 / 7.3 / 21 | 0 |
  | 3 | on | 335 | yes | 23.4 | 4.78 | 329 | 132.3 | 7.5 / 14.3 / 132 | 2 |
  | 4 | blocked | 335 | yes | 25.1 | 5.10 | 332 | 142.4 | 7.1 / 7.4 / 14 | 0 |

  One eye.layout per connection. Both "on" gaps coincide with one
  126–176 ms long task ~2.7–2.9 s after Fly (geometry build when the assets finish);
  first live update 3.1–3.6 s after Fly. Before render-on-demand the view cost more:
  93 fps, p95 20.9 ms. An earlier run in the desktop app's built-in browser (vsync):
  66.7 fps, p50 13.9 / p95 14.2 ms with the view, 33.9 Hz replies, 67 viz for 335 frames,
  caption frame numbers advancing 31 → 241 during flight. Screenshots checked (view live;
  error text when blocked).
- After rebasing on 3171080 (`attachReflexStream`), restarted everything and re-ran:
  bench record n=1 → `BENCH DONE 5`; one live flight with the view: replies in order
  from k=1, 23.5 Hz, 58 viz, late_replies 327/335, caption live from frame 76.
- The reflex did **not** crash: one process served 11 connects/disconnects until it was stopped.

Open issues:
1. **Reflex backlog in live flights (pre-existing, not caused by the view).** The page
   sends 50 frames/s but the reflex answered only ~21–34/s here (browser rendering
   competes for the CPU), so frames queue: 3 s after the last frame 43–103 replies were
   still outstanding and late_replies ≈ all frames. Commands then act seconds late.
   Needs client-side backpressure (send only when the previous reply arrived) or a faster eye.
2. Building the view blocks the main thread once per flight when the assets arrive:
   126–176 ms long tasks with warm caches, but **925 ms** on the first flight after
   restarting Vite + browser (post-rebase smoke run) and a 1,007 ms rAF gap in the first
   built-in-browser flight. The sim clamps a gap at 100 ms, so the drone visibly pauses
   up to ~1 s then continues (outcome unaffected). Fix if it matters: build the geometry
   in the decode worker or before the flight starts.
3. `maxWallS` counts wall time while the tab is hidden: a flight started in a hidden
   tab ends at the first visible frame with 0 frames (seen once). Pre-existing.
4. Only measured on this laptop's iGPU/headless and the built-in browser; not on the demo Mac.

## Step 7.4 prep — 3D connectome view (2026-09-26, Windows, dev page only)

Pinned fly-brain: https://github.com/Lulzx/fly-brain commit
`08cf8666bd3cb405c803f95821ebe06d22b3e5ab` (2026-09-22). Cloned to a temp dir, not committed.

Files: `web/vendor/fly-brain/` (codec `rc.js`, `skel.js`, `neurons.js` verbatim;
`decode.worker.js` and `data.js` minimally modified; `data.d.ts`; upstream `LICENSE`;
`ATTRIBUTION.md` with commit, licenses, sha256 per file), `web/public/fly-brain/`
(data, byte-identical to upstream), `tools/check_flybrain_map.py`,
`data/flybrain_node_map.json`, `tests/test_flybrain_map.py`,
`web/src/flyviz/connectome3d.ts`, `web/connectome.html` + `web/src/connectome-page.ts`,
`tools/record_connectome_sample.py`, `web/public/recordings/connectome_disc.{json,f16}`.

Asset sizes: `skeletons.flys` 11,588,816 B; `neurons.flyn` 1,006,198 B;
`vision/flyvis_map.json` 1,051,795 B; `vision/flyvis.bin` **12,882,225 B** (per-node
type/u/v are only the first 228 KB; the rest is model weights); `vision/flyvis.json`
1,499 B (the type names flyvis.bin's ids index; needed, not in the README list).
Recording 2,100,774 B. All are below GitHub's 50 MB warning. The browser does not load
`flyvis.bin`; only the check script reads it. Drop it later if repo size matters.

Node order (measured, `python -m tools.check_flybrain_map`): fly-brain's flyvis node
order is **identical** to `data/flyvis_layout.json` when matched by (type name, u, v):
45,669/45,669 nodes matched, remap = identity. **Coverage: 30,946/30,946 left-eye
pairs resolve (100.000%)**: 30,946 distinct neurons, 15,640 distinct nodes,
**609/721 columns** (the README's "about 410" is not what this map gives). Right eye:
31,211/31,211, 625 columns (not used). A one-off check against fly-brain's
`meta.json` (not vendored) found all 30,946 left pairs join neurons whose connectome
type equals the node's flyvis type. The mapping itself is upstream's approximate
retinotopic assignment (`scripts/prep_flyvis_map.py`).

Renderer: separate `THREE.WebGLRenderer`; skeletons of the 30,946 mapped neurons only
(346,118 vertices, 314,614 segments); mapped somas share the shader; all 134k other
neurons are dim gray somas. Per-neuron Float32 activity texture (2048 × 81), as in
fly-brain's viewer; `setActivity(Float32Array(45,669))` writes
clip(deviation / 0.5, ±1) per pair. Warm = above rest, blue = below rest.
Label and attribution are drawn in the view. Orbit controls.

Dev page `web/connectome.html` replays a **recording**: pretrained `flow/0000/000` on
CPU, a synthetic black disc approaching head-on at 3 m/s from 6 m
(`tools.looming_stimuli.disc_clip`), 0.5 s still hold + 1.7 s approach, 23 frames at
VIZ_HZ = 10, float16. It is labeled a recording on the page. Live stream = Step 7.1.

Validation:
- `python -m tools.check_flybrain_map` — PASS (stats above).
- `pytest tests/test_flybrain_map.py` — 2 passed (saved map current, >95% coverage,
  identical order, loader hash table and attribution match the files).
- `pytest -m "not slow and not network"` — 49 passed, 12 errors, all in
  `test_reflex_protocol.py::test_malformed_frames_are_rejected`: Windows rejects
  pytest's `PYTEST_CURRENT_TEST` env var (binary test ids > 32,767 chars). Pre-existing,
  unrelated to this step.
- `npx tsc -p .` in web — exit 0.
- Vite dev server + the desktop app's built-in Chromium (RTX 3050 Ti via ANGLE/D3D11):
  page renders, no console errors, activity visibly spreads/brightens in the left
  optic lobe as the disc grows. Load to first render with skeletons: 2.80 s (first
  visit), 2.92 s (Cache Storage cleared), 2.98 s (warm); decode-bound, localhost.
  Demo Mac load time is **unmeasured** (README target < 5 s).

Deviations / open issues:
- `web/connectome.html` is not a production build entry. To ship it in `npm run build`,
  add `connectome: resolve(import.meta.dirname, 'connectome.html')` to
  `web/vite.config.ts` (not edited here; shared file). Dev server serves it now.
- Added `web/src/connectome-page.ts` (page script) and `tools/record_connectome_sample.py`.
- The main-repo `.venv` has torch `2.14.0+cu126`; `FlyEye(device="cpu")` fails there
  unless CUDA is hidden (flyvis builds its RNG on `flyvis.device`, chosen at import).
  The recorder sets `CUDA_VISIBLE_DEVICES=-1` (empty string is dropped on Windows).
- Not wired into the Fly tab or the live stream yet (needs Step 7.1 `stream.ts`).
## Correction and adaptation (2026-09-27) — current numbers

**The earlier "29/63 in time" was wrong.** Closed-loop captures showed debris flights
braking at hover end and staying braked: the eye's rest was taken on gray, so a
static scene (e.g. the hanging debris panel) keeps the drive above rest and the
fitted θ_cone sat on that offset. Scoring only checked "first brake before contact",
so brakes 4–5 s early counted as detections. Honest scoring now counts a first brake
more than EARLY_S = 2.5 s before contact as a false (early) brake. Re-scored, that
readout stopped in time for only 7/63 test collisions, with 22 early brakes.

Fix: **adaptation** (`reflex.looming.Adapter`): relu(drive − running baseline) with
time constant τ, like motion adaptation in the fly, so steady responses fade.
τ was chosen on TRAIN only (sweep 0.04–2 s; 0.04 s and 0.1 s tied at 67 vs 65 in time;
0.1 s chosen as the smoother setting). Held-out TEST (100 flights, 90° FOV, 1.5 m/s):

| | caught | in time (≥ 0.415 s) | false brakes | early brakes (> 2.5 s) |
| --- | --- | --- | --- | --- |
| cone + units, τ = 0.1 s (live) | 47/63 | **36/63** | 1/37 | 2 |

In time by obstacle: debris 20/20 (median warning 1.32 s), post 12/20 (1.22 s),
beam 4/20 (0.32 s, too late), near_post 0/3. Calibration-set tuning was on train
seeds only; test seeds were used once for this report
(`measurements/readout-fit-fov90.json`).

## Fitted readout: collision cone + learned units (2026-09-27) — SUPERSEDED (numbers inflated, see correction above)

Camera now renders 384² with MSAA and is area-averaged to 96² (realistic camera,
no aliasing); fine concrete ground. 90° FOV, 1.5 m/s. Data: 200 train flights
(seeds 100–139) + 100 held-out test flights (seeds 500–519), replayed through the
pretrained eye (`tools/record_drive.py`); fit with `tools/fit_readout.py`.
Diagnostic finding: a sagging beam only shows its lower edge (moving down near the
image centre); wide all-sides-expanding units miss it. Edges that will hit the drone
sit near the centre of view, so a centre-weighted radial-motion "cone" pathway was
added (Gaussian σ = 0.1 in col_x/col_y units) alongside learned weights over the 7
units × 3 pathways. Either pathway brakes; each θ is the 97.5% quantile of train
safe peaks. Scored with the runtime `Readout` (identical to the fit prototype).

Held-out TEST (63 colliding, 37 safe; `measurements/readout-fit-fov90.json`):

| readout | caught | in time (≥ 0.415 s) | false brakes |
| --- | --- | --- | --- |
| previous 2-pathway rule | 8 | 1 | 0/37 |
| learned units only | 10 | 7 | 3/37 |
| **cone + learned units (live now)** | **34** | **29** | **3/37** |

In time by obstacle: debris 18/20, beam 5/20, post 6/20. Posts are at the eye's
resolution limit at 90° (0.1 m post < 2 facets until inside ~1 m). A 60° batch is
being recorded to test that. Not yet good enough to claim reliable avoidance.

## Step 7.1 — viz stream (2026-09-27, Windows CPU)

Files: `reflex/viz.py` (new), `reflex/server.py` (hooks only), `web/src/flyviz/stream.ts`
(new), `tests/test_reflex_viz.py` (new), `tests/test_reflex_protocol.py` (adapted).

- On connect the reflex sends one text message `{"type": "eye.layout", ...layout,
  "S_theta": θ}` (814,532 bytes; θ = the server's `THETA`, currently 1.2 uncalibrated).
- Live mode (0) only: after the JSON command reply, a binary viz message when due:
  16-byte LE header `k u32, S f32, dLR f32, cmd u8, 3 zero pad` + N float16 LE
  deviations (`FlyEye.deviation()`, native node order). 16 + 2 × 45,669 = 91,354 bytes.
- Command byte enum (`reflex.viz.CmdByte`, `CMD_BY_BYTE` in stream.ts):
  none 0, brake 1, saccade_left 2, saccade_right 3, arrived 4.
- Rate limit per episode on frame time k × DT_S (not wall clock): at most VIZ_HZ;
  at 50 Hz frames that is k = 0, 5, 10, … Dropped frames never cause a burst.
- JSON command replies are unchanged; bench modes never get viz.
- `stream.ts`: `VizStream.handle(data)` consumes eye.layout/viz and returns false
  for commands/acks/errors; exposes `layout`, `latest` (Float32Array, reused in
  place), `header`, and a typed ring buffer (`history()`: last 10 s of t, S, dLR, cmd).
  Half floats decode via a Uint16Array view and a hand-written half→float table.

Validation (this Windows laptop, CPU only):

- `pytest -m "not slow"` (after rebasing on b62cebf/85420be): 65 passed, 12 errors. All 12 errors are the existing
  `test_malformed_frames_are_rejected` params: on Windows their 9 KB byte-string IDs
  exceed the 32,767-char `PYTEST_CURRENT_TEST` env limit (setup error, not a test
  failure; the file's parameters are unchanged by this step). `tests/test_reflex_viz.py`:
  15 passed (reference decoder written from the byte layout incl. a manual half
  decoder; enum; limiter; 2 s live stream = 20 viz at k multiples of 5 whose headers
  match the preceding replies; replies identical with viz on/off for all 3 modes ×
  reflex_on).
- `npx tsc --noEmit -p .` passed. A Node check decoded a Python-encoded message
  with stream.ts: header exact, 45,669 values, max abs difference vs numpy float16 0.
- Live, real pretrained model (`python -m reflex.server`, CUDA hidden), throwaway
  client sending live frames paced at 50 Hz wall clock:
  | run | layout msgs | commands | reply rate | ms p50/p95 | viz msgs | viz bytes | viz/s wall |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 10 s | 1 | 500 | 39.96 Hz | 22.92 / 33.07 | 100 | 91,354 | 8.01 |
  | 10 s | 1 | 500 | 41.48 Hz | 22.56 / 28.56 | 100 | 91,354 | 8.31 |
  | 5 s | 1 | 250 | 39.39 Hz | 23.78 / 30.24 | 50 | 91,354 | 7.91 |
  Exactly 10 viz per second of frame time (1 per 5 frames). Wall-clock viz rate is
  ~8/s because the CPU eye only processed ~40 frames/s here, below 50 Hz.
  Pre-viz server code on the same machine: 42.83 and 40.08 Hz, p50 22.82 / 23.95 ms,
  so no measurable cost from viz (encode_viz p50 0.12 ms; layout JSON 10 ms at import).

Open issues:

1. **Browser client needs a one-line change before viz reaches the scene.**
   `ReflexLink` in `web/src/scene/inspect.ts` (not edited here, per ownership)
   treats every message as a command reply. The on-connect eye.layout will resolve
   the first `request()` (bench.ts `episode.begin`, capture.ts first frame), making
   every later reply off by one; binary viz makes `JSON.parse` throw (harmless,
   but noisy). Fix: set `binaryType = 'arraybuffer'`, pass each message to
   `VizStream.handle()` first and only treat it as a reply when that returns false.
2. **Pre-existing crash:** on this machine the reflex process dies with a Windows
   access violation (exit 139) within seconds after a live client disconnects
   (3 of 3 runs; once after the first client, twice after the second). The
   pre-viz server.py crashed the same way (4 s after its second client), so it is
   not caused by this step. Faulthandler shows no Python frame at the fault.
   The shared `.venv` has torch 2.14.0+cu126, so the server needs
   `CUDA_VISIBLE_DEVICES=-1` to load FlyEye on CPU (see the Step 7.4 notes); all
   runs above used it. Investigate the crash before the demo.
3. The eye does not sustain 50 Hz on this CPU under current load (~40 Hz, p50 ~23 ms).

Next: fix ReflexLink (issue 1), then Step 7.2 eye view and looming trace.

## Carport scene and first calibration (2026-09-27) — reflex NOT yet reliable

Built: `web/src/scene/inspect.ts` (carport: 4 posts, sagging front beam, roof,
hanging debris panel that drops into the path, back wall, bins, goal behind),
`web/inspect.html` (live chase view + drone camera + HUD), `web/bench.html`
(seeded record/closed-loop runs, lockstep), `tools/calibrate_reflex.py`,
`tools/plot_calibration.py`. Scenarios: post, beam, debris (collide);
clear, near_post (should not collide; heading jitter makes 3/12 near_post collide).
Headless runs work here: Chromium `--headless=new --use-angle=swiftshader`;
60 recorded flights take ~1 min; replaying them through the eye takes ~7 min.

Calibration result with the live 7-unit, 2-pathway readout at 120° FOV:
θ = 1.92 at 1/21 false brakes, but only **8/39 collisions detected**
(posts 0/12, beam 0/12, debris 7/12), one with ≥ 0.415 s warning.

Why (S traces: `results/reflex_calibration.png`, regenerate with the tools):
- Safe flights pass ~0.7–0.9 m under the front beam and roof edge; that
  overhead structure genuinely looms (S ≈ 1.5–1.75), as high as real hits.
- Wide units cannot separate a doorway (edges expanding around an empty centre)
  from an obstacle (covering the centre). A unit must be about the width of the
  drone's path at braking distance to discriminate.
- A full-width sagging beam only expands vertically, so neither the 2d nor the
  horiz pathway responds. A vertical (up/down) pathway catches it
  (19 units, 90–120°: 11–12/12 beams, ~0.5–0.9 s warning).

Offline sweep (cached drive; FOV 60/90/120; 7 or 19 units; all/centre/horizon/
inner subsets; 2d/horiz/vert pathways): **no single setting catches all three
obstacle types**; posts are rarely caught. θ at 5% false brakes on 21 safe flights.
Results are calibration-set only; the sweep is not saved in the repo.

Open decision for the user: a learned readout (weights on the per-unit
2d/horiz/vert pathway responses, fit on hundreds of simulated flights and
tested on held-out seeds), analogous to the giant fiber weighting its looming
inputs. The alternative is a nearness cue from optic-flow magnitude plus known
speed, which needs a T4/T5 speed calibration.

## Fly-inspired navigation controller (2026-09-26)

User decisions: no human in the loop for avoidance; expand scope to navigate
around obstacles toward a goal; demo on the Mac; one 120° eye first (two eyes
if the Mac is fast enough).

- `reflex/controller.py`: cruise at 1.5 m/s with yaw = 60°/s·sin(goal bearing) →
  brake when S > θ (latched 0.5 s, re-latched while S stays high) → 90° saccade at
  180°/s away from the looming side (goal side if |dLR| ≤ 0.5θ) → looming
  ignored for 0.3 s → cruise. `arrived` within 0.5 m of the goal. reflex_on=0
  cruises to the goal with no brake or saccade.
- Frame header is now 20 bytes (goal_bearing, goal_dist f32). Replies carry
  `speed` and `yaw_rate`. Swerve commands are gone; `SWERVE_MPS` removed.
- Tests: 60 passed with `-m "slow or not slow"`.
- Next: the carport scene with a goal behind obstacles, hover start, a 120°
  camera and a headless seeded bench to calibrate θ and the saccade.

## Two-pathway looming readout (live, 2026-09-26)

User decision: adopt the LPLC2-style readout, both pathways, with 1.5 m/s as the
planned inspection speed (`INSPECT_SPEED_PLANNED_MPS`; warning needed 0.415 s).

- `reflex/looming.py`: 7 units (`LPLC2_RINGS=1`, `LPLC2_SPACING=0.55`). The 2d
  and horiz pathways are each scaled by their obstacle-free maximum from the
  1.5 m/s, 90° corridor run (`LPLC2_NORM_2D=0.0475`, `LPLC2_NORM_HORIZ=0.1596`).
  S = larger scaled pathway; dLR from the same pathway.
  `THETA_UNCALIBRATED = 1.2`.
- `FlyEye.step` now returns `(drive, activity)`; drive is (4, 721) rectified
  T4+T5 deviation per direction. `RegionIndex.energies` keeps the §4.8 view for tests.
- Tests: 52 passed with `-m "slow or not slow"` (synthetic radial, bar and
  translation drives; swerve sign; protocol with a stub eye; real-model brake
  before an approaching disc fills the frame).
- Production readout reproduces the prototype scale on real model output
  (1.5 m/s, 90°): empty corridor S max 0.79, passing post 1.00.

**Open problems found while wiring:**

1. **Episode-start false brake.** The gray→scene onset keeps S above θ past
   0.4 s on several obstacle clips (brake at the first scored frame). Proposed
   fix in the scene: start each inspection with ~1 s of hover while streaming,
   then fly forward. A brake while hovering is harmless.
2. **Swerve is unreliable.** Debris on the left produced `brake_swerve_left`.
   Recommend brake-only until swerve is calibrated in the carport scene.
3. The first-crossing warning numbers from synthetic clips are not trustworthy
   (see the prototype notes below). Real calibration needs the carport scene.

## Readout prototype: LPLC2-style units (evidence behind the live readout)

Tools: `tools/looming_stimuli.py` (disc, texture and forward-flight corridor
clips with floor, posts, boxes and debris, plus collision truth) and
`tools/compare_readouts.py` (records real T4/T5 drive once per clip, then scores
readouts offline). flyvis has no LPLC2/LPi cells, so these units are an
**engineered layer on top of real T4/T5 output**, not flyvis cells.

Unit design: a hexagonal set of overlapping units (7, 19 or 37), each with four
branches. Each branch is excited by outward and inhibited by inward motion on its
side of the unit's own centre. The "2d" unit needs all four branches (geometric
mean, LPLC2-like). The "horiz" unit needs only left+right. S sums the units;
dLR = left units − right units.

Findings (S traces: `measurements/readout-traces-fov90-v3.png`, 90° FOV, 3 m/s):

- The §4.8 half-field readout fails in forward flight. An empty corridor holds
  S ≈ 0.33, and obstacles add signal only in the last ~0.2 s.
- Local units reject corridor and floor flow (baseline ~0.03 for 7×2d).
- 2d units rise genuinely only for compact debris, in the last ~0.3 s. They do
  not respond to posts or boxes taller than the frame, which only expand sideways.
- Horizontal units rise genuinely for a 0.8 m box from ~0.7 s before contact, and
  for thin posts in the last ~0.3 s.
- 7 larger units were less noisy than 19 or 37 smaller ones.
- At 3 m/s, genuine warning is about 0.3–0.7 s, short of the 0.79 s target.
- Swerve direction is unreliable in textured clutter.
- The first-crossing warning tables printed by the tool are **not reliable**:
  θ comes from only 2–3 obstacle-free clips, so texture noise crosses it early
  (e.g. "3 s" warnings at 1.5 m/s). Proper calibration needs many seeded
  non-colliding episodes (Step 8.2), ideally in the real carport scene.

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
  the load error if the fly extra or weights are missing. The 2 s gray warm-up
  runs once at startup; each episode resets to that saved state (<10 ms,
  bit-identical to a fresh warm-up per `test_cached_reset_matches_a_fresh_warm_up`).
  Live first-frame time fell from ~1.6 s to 13–36 ms. Live and bench_closed frames run the
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
4. (Fixed) Per-episode warm-up delay; see above.
5. A 50 Hz live stream has little CPU headroom (p95 ≈ 20 ms). Mac is unmeasured.

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
