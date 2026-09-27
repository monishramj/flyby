# Simulation graphics overhaul

Implemented on `sim-overhaul`, based on local `triage` at `2af9027`, in `/private/tmp/flyby-sim-overhaul`. The original checkout was on `mongodb-atlas` with uncommitted work when execution began, so an isolated worktree preserves it, including `.env.example`.

Files changed:
- `web/src/models.ts`: procedural damaged structures, palms, dense instanced wreckage, sediment textures, dented/weathered cached vehicle assets, and replacement truth visuals.
- `web/src/map.ts`: overcast illumination, gray-green sea and muddy floodwater, rescue drone, resource disposal, and integration with existing overlays.
- `web/test/scenery.mjs`: geometry, immutable scene, determinism, truth visual, and shared GLTF resource regression checks. Uses Node's built-in TypeScript stripping (tested with Node 26).
- `web/test/fixture.json`: added the missing `MISSION` field to both recorded snapshots, using the server's existing Sweep implementation; confirmed the recorded sweep path matched.
- `docs/SIM_OVERHAUL.md`: this report.

Decisions:
- Grounded recent aftermath in overcast daylight, built with installed Three.js and local assets; no dependencies added.
- Buildings, people, truth decoys, landmarks, water regions, roads, sectors, and mission paths retain their mission data. Buildings retain exact footprints and overhead shelter at their centres. Decorative debris and vegetation may change.
- Decorative wreckage never enters the detector or truth data. The detector operates on server-generated objects, not rendered pixels.
- Existing vehicle/boat/prop assets are reused and weathered; buildings, vegetation, drone detailing, and truth visuals are rebuilt locally. Small debris uses three instanced batches and buildings merge geometry by material.
- UI panels, controls, and operational overlays retain their existing behavior.

Validation commands and output (from the worktree root):

```text
npm run build --prefix web
✓ built in 675ms

node web/test/scenery.mjs
ok — seeds 0, 7, 104: structure anchors, footprints, shelter, truth fade, decorative separation, determinism, immutable scene, truth visuals
ok — cached shared GLTF materials and geometry are weathered once

node web/test/render.mjs
All checks printed ok, including approve/override, selection, truth controls, mission controls, and results.
No JavaScript errors.

uv run pytest tests/test_ui_contract.py tests/test_mission.py tests/test_loop.py
30 passed, 1 warning in 28.67s

 git diff --check
(no output; exit 0)
```

Browser validation used isolated headless Chrome with software WebGL and a server-generated seed-7 scene, plus recorded UI events for the jsdom test. Compared original and replacement orbit views; inspected top-down, follow, and truth views. Truth mode showed all 21 subject/decoy labels; the browser reported no JavaScript exceptions. Missing-WebGL fallback was also exercised. The geometry test runs without loaded GLTF assets, verifying the procedural structures and debris remain available.

Deviations and open issues:
- One additional GPU texture allocation was observed per scene rebuild despite disposal of scene-owned materials/textures. Investigation was stopped at the user's request to wrap up; the exact retained texture owner is unresolved. Buffer counts remained stable in consecutive completed rebuilds. Reloading the page clears the renderer.
- Native GPU performance and a live backend mission were not measured in this browser session. Software rendering was slow (roughly 3–6 fps); this is not a hardware performance claim.
- Existing build size warning remains (about 890 kB JS / 247 kB gzip). Pytest reports a pre-existing Starlette/httpx deprecation, and Node reports its TypeScript-stripping experimental warning.
- No README or backend changes. No commits or merges were made.
