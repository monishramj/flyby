# Implementation status

Completed step: 0.1 scaffold and configuration. Next active step: 0.4 flyvis smoke.

Read this folder's `README.md` and `MASTER_PLAN.md` first when resuming. The plan captures the user-provided context,
ownership, complete fly-lane sequence, hardware/Colab decision, interface details,
acceptance gates and a replacement-agent prompt.

## Repository handoff

- Shared baseline: `3812336`; active branch: `fly/connectome`.
- Remote: https://github.com/monishramj/flyby (configured as `origin`).
- The user accepted the collaborator invitation for `wikzAM`. Write access is
  confirmed; the initial HTTP 403 is resolved and the shared main branch is published.
- Git credential-helper execution failed in the restricted session. Outside it,
  the helper found the existing sign-in; Git needed a command-scoped safe.directory
  for this exact repository because sandbox and host users differ. No global
  Git trust or credential settings were changed.
- Our branch is `fly/connectome`. The shared plan belongs to the foundation;
  subsequent model and reflex implementation belongs to our branch. Fetch before
  integration and never force-push.
- No long-running services or model downloads are active.

## Compute decision

No Colab H100 job is needed now. Keep it available for a Linux reference smoke
test if local flyvis loading fails, or later offline batches. Upstream documents
Linux testing on Python 3.9–3.12; Windows/macOS model compatibility remains untested.
The proposed demo host remains the Mac, subject to measured integrated performance.

Implemented: Python 3.12 project, separate service entry points and health
routes, README constants, secret loading, CPU thread helper, Vite/TypeScript
starter with Three.js and Chart.js dependencies, baseline config and isolation
tests. Health routes explicitly report that the model and mission are not ready.

Next: Step 0.4, the flyvis smoke test. After that, implement the reflex
protocol, eye wrapper, looming readout and controller; then eye/circuit views,
followed by 3D projection. The inspection scene is a shared integration task.

## Step 0.4 acceptance checklist

- Inspect real flyvis APIs and load pretrained `flow/0000/000`.
- Confirm accepted frame size and persistent state at dt = 0.02 s.
- Measure all eight T4/T5 subtype directions using drifting gratings.
- Verify top-right camera input maps to positive col_x and col_y.
- Export native node ordering, sampling coordinates and signed type edges.
- Report warm p50/p95 step time and device. Do not equate simulation dt with speed.

## Deliberate scaffold deviations

- `FRAME_R`, `SUBTYPE_DIR`, and `THETA` are unset until measured/calibrated.
- Only runnable scaffold files exist; later modules have reserved directories,
  rather than empty implementations that appear finished.
- Health routes and this status page are setup checks, not the mission UI.
- Flyvis/PyTorch, weights and fly-brain assets are not installed or vendored yet.
- The private conversation was used as background and is not included in Git.

## Upstream checks, 2026-09-26

The current [flyvis package metadata](https://github.com/TuragaLab/flyvis/blob/main/pyproject.toml)
requires Python >=3.9,<3.13, matching the project choice of 3.12. The installed
system Python here is 3.13, so an isolated 3.12 interpreter is necessary.
The metadata alone does not prove pretrained weights work on this machine.

Use only the loaders, required assets and texture-rendering approach from
[fly-brain](https://github.com/Lulzx/fly-brain). Preserve actual upstream
license files when vendoring. Node mapping, asset sizes and licenses must be
checked at the pinned revision during Step 7.4. No whole-brain simulator is needed.

## Validation on Windows, 2026-09-26

- Python 3.12.14: `python -m pytest -m "not slow and not network"` — 7 passed.
- `npm run build` — TypeScript and Vite production build passed.
- Started both Python services and Vite on temporary local ports: both health
  endpoints and the browser entry page returned HTTP 200 with expected content.
- uv.lock and web/package-lock.json capture the installed dependencies.
- No model inference, 50 Hz throughput, Mac compatibility, or neural mapping
  has been tested yet.

The sandbox denied default global npm-cache and pytest-temp writes. Redirecting
those paths into this workspace resolved setup; see docs/SETUP.md. Python 3.12
works from the local installation without PATH or registry changes.
