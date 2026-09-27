# Triage interface and scene polish

Scope: the `triage` branch frontend. No mission logic, model decisions, server contracts, main, or fly/connectome changes.

## Presentation

- Restrained graphite, sage and amber command interface; persistent desktop Work sidebar; incident and radio context in a collapsed drawer below the map.
- Live elapsed time, coverage, pending reviews and dispatch counts derived from the existing snapshot. Simulation label remains explicit. Service state and errors remain visible.
- Responsive tablet and phone layouts, labelled action probabilities, keyboard lead selection, visible focus and reduced-motion support.
- Ground texture with sediment, finer surface grain and road markings. Broken fencing, displaced roof sections, supply crates, two field shelters and an instanced sandbag perimeter reuse existing CC0 assets or simple geometry. These are decoration and never affect detections or metrics.
- Water normal texture replaces CPU-deformed water geometry. Screen-space label collision handling prioritizes selected leads and hazards.
- Results charts use the interface palette; the missing Chart.js logarithmic scale registration is fixed.

## Rendering

Repeated rigid model parts share instanced draws. House materials stay independent for the ground-truth fade. Shadows update on scene rebuild/truth changes, not every frame; the drone does not cast a moving shadow. Device pixel ratio is capped at 1.5. Map rendering pauses in a hidden tab, on Evaluation, and when scrolled offscreen. Labels update at 30 Hz with collision checks at about 8 Hz.

Mission reset releases scene-owned maps, normal textures, materials and instance buffers while preserving model-cache geometry and textures.

## Validation

Commands from `web/`:

```sh
npm run build
node test/render.mjs
node test/scenery.mjs
```

The scenery check requires Node 22.18+ for native TypeScript stripping. It verifies 24 repeated meshes become one draw while preserving nested transforms, cache ownership and independent house materials.

Actual WebGL checks used headless Microsoft Edge on Windows, the repository's recorded mission, and a 1440 × 1000 viewport at device pixel ratio 1. Before/after counters:

| Counter | Original triage | Updated triage |
| --- | ---: | ---: |
| Render calls per frame (including shadows) | 1,407 | 182 |
| Rendered triangles per frame | 276,638 | 145,240 |
| Frame interval p50 | 16.7 ms | 16.7 ms |
| Frame interval p95 | 17.0 ms | 17.0 ms |

The composition/camera changed, so these counters describe the complete before/after experience, not an isolated GPU benchmark. Both sustained approximately 60 fps on this test machine; no claim is made about the demo Mac or concurrent model inference.

Also checked: 768 × 1024 and 390 × 844 with no horizontal overflow; orbit/follow/top-down; keyboard selection; live telemetry and queue controls through the replay test; all three real canvas charts; no browser JavaScript errors. Six scene resets held steady at 135 geometries and 43 textures. Switching to Evaluation left the map frame counter unchanged.

## Teammate reconciliation

Merged upstream `baee1ff` (work-centric queue, Grok crew orders and human-load metrics) into the local UI upgrade. All upstream server, batch, results data and Python test changes are preserved without alteration. Main and fly/connectome were not modified.

- Retained Needs you / Auto-closed tabs, risk indicators, reopen controls, code-written reasons, expandable exact model inputs, experimental probability labels and pre-approval crew orders. Removed the superseded assistant panel.
- Styled the four headline KPI cards and three charts without changing their data or the upstream categorical palette. Corrected the calibration caption to describe its Laya-only plot.
- Search completion remains capped at the configured sweep duration; mission elapsed time continues while leads resolve.
- Re-ran `pnpm run build` (TypeScript + Vite), `node test/render.mjs` and `node test/scenery.mjs`: all passed. Vite retains its non-failing warning about the bundled Three.js/Chart.js chunk exceeding 500 kB.
- Repeated WebGL checks after merging: 182 calls, 145,240 triangles, frame interval p50 16.7 ms / p95 17.0 ms. No horizontal overflow on desktop, tablet, phone or phone Evaluation. Crew-order approval, Why expansion, context expansion and queue tabs passed browser checks using recorded events plus a synthetic crew-order event. No live Grok/Laya calls were made.
- Python tests were not rerun here: this checkout has no Python 3.12/uv environment, and the reconciled backend is byte-for-byte upstream.

The merge is local only. Publishing requires the user's explicit permission.

No new runtime dependencies, downloaded art, or changes to asset licenses.
