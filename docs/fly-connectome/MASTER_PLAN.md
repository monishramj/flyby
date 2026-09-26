# FlyBy: master plan and agent handoff

Last updated: 2026-09-26. This file is the entry point for a replacement agent.
It preserves the current scope and decisions without requiring the original chat.

## Start here

1. Read this file, root `AGENTS.md`, `docs/fly-connectome/STATUS.md`, and `docs/TEAM.md`.
2. Check `git status --short`, branch, latest commits, and remotes. Preserve
   uncommitted work; do not reset or replace another person's implementation.
3. Read the relevant sections of `README.md`, which contains the supplied full
   build specification and step-by-step prompts. It describes the intended final
   product, not what is already implemented.
4. Work on `fly/connectome`. Complete the next unfinished checkpoint and its
   acceptance checks. Update `docs/fly-connectome/STATUS.md` before handing off.

**Steps 0.4, 6.1, 6.3, 6.4 passed (θ uncalibrated). Next: Step 6.2 scene or 7.1 viz.**
The real pretrained model runs on Windows CPU and the layout is exported.
`/ws/reflex` accepts frames but returns `none`; there is no avoidance demonstration yet.
Read STATUS.md for current measurements and the warm-up deviation from the README.

## Product and ownership

FlyBy is a simulated search-and-rescue ground-control system with two linked
features: context-aware lead triage, and a visible fly-inspired inspection reflex.

| Lane | Responsibility | Files |
| --- | --- | --- |
| Our lane | Flyvis inference, looming readout, brake/swerve, neural views, reflex evaluation | `reflex/`, `web/src/flyviz/`, `bench/`, fly-specific `tools/`, `tests/`, and `data/` |
| Monish | Mission, Laya, Grok, incident picture, persistence, triage metrics, mission UI | `server/`, `batch/`, related web UI/tests |
| Shared | Inspection scene, web entry point, dependencies, event contracts | `web/src/scene/inspect.ts`, `web/src/main.ts`, root/web manifests |

Monish is handling Grok/Laya and the ground station. Do not implement those
features as a side effect of fly work. Coordinate changes to shared files.

The user supplied an older architecture conversation and a later full README.
The later README wins where they disagree. The private conversation is not
committed; the decisions needed to continue are captured here.

## Decisions already made

- Use pretrained **flyvis**, a connectome-constrained visual model. Do not build
  an entire biological brain or train a new visual model for the first demo.
- Motion features come from T4/T5 cells; our engineered looming readout and
  controller sit after those cells. Do not label these added layers as flyvis cells.
- **Optical flow comparisons are out of scope**, along with YOLO panels, low-light
  sweeps, real hardware, autonomous navigation and multiple drones.
- The reflex benchmark compares **reflex on versus off**. It cannot support a
  claim that the fly model outperforms another avoidance algorithm.
- Use fly-brain only for selected loaders/assets and 3D activity projection.
  Skip its LIF brain, WASM simulator, MuJoCo, arena and browser inference runtime.
- Label the 3D view “flyvis activity projected onto matching connectome neurons.”
  The mapping is approximate; verify node order and preserve attribution.
- Grok maintains a schema-checked incident picture asynchronously; Laya reads
  its in-memory snapshot. Neither Grok nor MongoDB belongs on the decision path.
- Human approval is required for dispatch and close-in inspection.

## Current repository state

- Repository: https://github.com/monishramj/flyby
- Shared scaffold commit: `3812336`.
- Local branches: `main`, `fly/connectome` (our working branch), `ground/triage`.
- `origin` is configured. The user accepted the collaborator invitation for
  `wikzAM`; write access is confirmed and the shared scaffold is published on main.
  The initial HTTP 403 is resolved. Our development branch is `fly/connectome`.
- Correction from the user: the initial scaffold push to main was an agent
  mistake. **All further work and pushes must stay on fly/connectome.** Do not
  merge or push to main, or delete its remote branch without explicit direction.
- Fetch and inspect remote state before pushing; Monish may also be working.
  Reconcile concurrent changes without force-push.
- Only publish our branch; do not publish or alter
  Monish's branch on his behalf. The existing `ground/triage` branch is local only.

Implemented: Python 3.12 project and lockfile; two health-only FastAPI processes;
configuration; thread helper; Vite/TypeScript starter; Three.js/Chart.js dependencies;
tests; full original build specification. Validation: seven Python tests passed,
web production build passed, and all three local services returned HTTP 200.

Step 0.4 is implemented: optional flyvis dependencies, verified setup download,
real persistent-state smoke script and complete exported layout. FRAME_R=96 and
all eight directions are measured. WARMUP_S is 2.0 s after a gray-settling study.
Step 6.1 is implemented: `/ws/reflex` frame/episode protocol with local bench
recording, and Step 6.3 `reflex/hexeye.py` (energies use relu(activity − rest);
see STATUS.md). Not implemented: readout/controller, inspection simulator, neural
views and avoidance benchmarks. THETA intentionally remains unset.

## Hardware and compute

- Development: Windows laptop, RTX 3050 laptop GPU, 16 GB RAM.
- Proposed integrated demo host: Monish's Apple-silicon Mac. Exact chip and RAM
  are unconfirmed; the user estimates an M4 Pro-class machine. Do not record that
  estimate as verified hardware.
- Prefer one demo host. Keep a portable CPU reference path; measure CUDA on the
  Windows machine and CPU/MPS compatibility on the Mac before selecting acceleration.
- Flyvis upstream documents Linux testing on Python 3.9–3.12. Our Windows scaffold
  works, but that does not validate flyvis on Windows or on macOS.
- **No H100 needed now.** First unblock package/weight loading and correctness.
  A Colab GPU can provide a Linux compatibility reference if local loading stalls,
  then accelerate offline stimulus/episode batches. No new training is planned.
- H100 timings do not establish demo-laptop latency. Transfer exported artifacts
  back to the laptop and rerun single-stream latency there. Never place a Colab
  endpoint in the live reflex path.

If Colab becomes useful, prepare a small reproducible notebook against the exact
branch commit, select one pretrained checkpoint, record Python/package/CUDA/device
versions, save output files and checksums, and stop when the job finishes. Do not
download a whole ensemble blindly or start paid compute without a concrete need.

## Execution checkpoints

### A. Validate the model — README Step 0.4

Inspect real package source before implementing APIs. Record package version or
upstream commit and checkpoint identity. Inspect the download mechanism and size;
prefer only the required `flow/0000/000` artifact where supported.

Implement `tools/flyvis_smoke.py`: gray warm-up, four drifting-grating directions,
top-right bright-spot orientation check, persistent-state stepping at dt=0.02 s,
and warm step timing. Export `data/flyvis_layout.json` in native node order.

Acceptance: measured frame size; direction response table for all eight T4/T5
subtypes; correct image orientation; finite activity; layout arrays and signed
type edges validated; p50/p95 with device and timing boundaries recorded. Expected
counts from the design are 45,669 nodes, 65 types, 721 columns; verify rather than
silently hardcoding mismatches. Warm up outside the timed loop; synchronize GPU
work for timing. Report preprocessing, inference and end-to-end time separately.

Do not overwrite uncertain direction labels with an assumed a/b/c/d mapping.
If a subtype is ambiguous, record the response table and investigate the stimulus.

### B. Isolated frame service — README Step 6.1

Implement `reflex/frames.py` and `/ws/reflex` in `reflex/server.py`. Validate frame
length, mode, flags, episode boundaries and sequence numbers. Keep state per
episode/session. Support live, record-only and closed-loop modes. Add protocol
round-trip/malformed-frame tests and maintain the isolation guard.

Acceptance: a browser can send a valid frame, receive a documented command, reset
an episode cleanly, and record frames locally. Reflex-off always returns `none`.
No ground-station imports, DB access or outbound network activity.

### C. Eye and controller — README Steps 6.3–6.4

Use the verified smoke path for `FlyEye.reset/step/deviation`. Warm up for 0.5 s;
rest is each node's mean over the last 0.2 s. Preserve state between frames.
Readout uses rectified T4/T5 activity, while visualization uses deviation from rest.

For each image-space region, q = outward − inward. S = EMA(sum q);
dLR = EMA(q_left − q_right). S > theta triggers a brake held at least 0.5 s.
If |dLR| > 0.5 theta, swerve away from the more-looming side.

Acceptance: expansion, contraction, translation and steady-gray stimuli behave
as specified; positive dLR swerves right; brake latch and reflex-off tests pass.
Clearly label any temporary hand-tuned threshold as uncalibrated.

### D. Inspection scene — README Step 6.2; coordinate with Monish

Provide a standalone route for development until the mission carport module is
ready. Use the specified posts/beam/falling debris, seeded kinematics, collision
geometry and camera frames. Live mode must not wait indefinitely for a response;
benchmark mode uses lockstep. Make image vertical orientation explicit.

Acceptance: a straight approach collides with reflex off, a measured reflex can
brake before contact, and the mission receives the inspection result. Any late
or stale command behavior must be explicit and tested before the live demo.

### E. Essential visualization — README Steps 7.1–7.3

Send layout once and activity deviations at 10 Hz. Implement browser decoding,
eye layers, trace and circuit graph. Put T4/T5 → looming → brake edges in a clearly
marked engineered layer. Use real stream values only.

Acceptance: independent byte-layout test; rate limiting; receptor orientation
matches camera; motion colors follow measured directions; looming trace shows
threshold and command events; circuit responds to the real activity vector.

### F. 3D connectome projection — README Step 7.4; cut first if time is short

Pin the fly-brain revision; vendor only required loaders/decoder/assets with real
licenses. Compare native node (type,u,v) order and create a remap if needed.
Require more than 95% of supplied pairs to resolve; report the exact coverage.
Use a separate renderer and a per-neuron activity texture.

Acceptance: verified mapping, visibly changing mapped optic-lobe activity,
approximation label/attribution, and measured load time on the demo host.

### G. Evidence — README Step 8.2

Record 60 seeded straight-approach episodes across posts, beams and debris with
collision truth. Evaluate threshold crossings, false-brake rate and warning time;
choose a threshold near the specified 5% target and report the achieved rate and
sample counts. Treat this as calibration-set performance unless independently
tested; do not call it held-out generalization. Handle empty denominators and
missed crossings explicitly.

Run 30 seeded closed-loop episodes both off and on when time permits. Report
collision counts, mean and fifth-percentile warning time, and the fraction with
warning >= v / 4.0 + 0.04 s (0.79 s at 3 m/s). Write real results to JSON and PNGs;
do not populate charts with hand-entered numbers.

### H. Integration and rehearsal

Run the models and browser together on the demo host. Confirm real frame throughput,
correct brake behavior, inspection approval/result integration and visualization.
Run an offline rehearsal with local weights already available. Record a backup
video and preserve the exact commit, seed, config and measured results.

If time is short, drop 3D first, then closed-loop benchmark, then swerve. Keep the
fly brake, eye/circuit views and an honest measured warning-time result. Ground
station cuts remain Monish's decision; the overall README preserves triage, Ask
Ground Control and time-to-dispatch as essential features.

## Integration contract that must remain stable

- Ground station: port 8000; reflex: port 8001; browser bridges them.
- Mission emits `inspect.request {lead_id}`; browser returns
  `inspect.result {lead_id, collided}` after inspection.
- Frame header: episode u32, k u32, reflex_on u8, mode u8, pad u16; 12 bytes,
  followed by FRAME_R squared grayscale bytes. Use little-endian explicitly.
- Modes: 0 live, 1 bench_record, 2 bench_closed. Command JSON:
  `{k, cmd, S, dLR, ms}`; cmd is none, brake, brake_swerve_left or brake_swerve_right.
- `eye.layout`: native node types/coordinates/column map, image-space column
  positions, receptor/motion type lists, measured subtype directions, signed type
  edges and S_theta. See README 4.7 for exact field names.
- Viz header: k u32, S f32, dLR f32, cmd u8, three pad bytes; exactly 16 bytes,
  then N little-endian float16 deviations. Define/test the command-byte enum when
  implementing the protocol; the supplied README does not assign its numbers.
- Decode half floats explicitly in TypeScript; do not depend on Float16Array.
- Camera coordinates: x right, y up; regions use col_x/col_y, never raw u/v.
- Bench `episode.begin/end` bracket frames; records go to local files only.

## Setup and handoff discipline

Use `docs/SETUP.md`. On this machine, uv and Python 3.12 are under the parent
workspace's `work/` directory. System Python is 3.13 and is unsuitable for the
current flyvis package. npm cache and pytest temporary paths must be redirected
into the workspace in restricted sessions. No services are intentionally left
running after the scaffold validation.

At every handoff update `docs/fly-connectome/STATUS.md` with: last completed checkpoint, next
concrete action, changed files/commits, exact checks/results, dependency and
checkpoint identities, measured constants, deviations, active processes, and
blockers. Distinguish passed, not run, and failed. Keep credentials and bulk
weights out of Git. Commit working changes on our branch; push when access works.

Replacement-agent prompt:

> Continue FlyBy on fly/connectome. Start at docs/fly-connectome/README.md,
> then read its master plan and status, root AGENTS.md and relevant root README steps.
> Preserve existing work and keep
> Monish's ground-station lane separate. Complete the next unfinished checkpoint
> with real validation, record measured results and update the handoff before
> stopping. Do not invent model output, API details, benchmarks or readiness.

## Primary references

- [Flyvis source](https://github.com/TuragaLab/flyvis)
- [Installation and pretrained downloads](https://turagalab.github.io/flyvis/install/)
- [Custom stimuli / BoxEye tutorial](https://turagalab.github.io/flyvis/examples/07_flyvision_providing_custom_stimuli/)
- [Fly-brain source and assets](https://github.com/Lulzx/fly-brain)

The installed source at the pinned version is authoritative for API signatures.
The upstream docs confirm a pretrained inference workflow and GPU-capable image
sampling; they do not establish FlyBy's latency or avoidance quality.
