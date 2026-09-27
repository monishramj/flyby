# Triage interface and scene polish

Scope: the `triage` branch frontend. No mission logic, model decisions, server contracts, main, or fly/connectome changes.

## Presentation

- Restrained graphite, sage and amber command interface; persistent desktop decision sidebar; incident, radio and assistant panels below the map.
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

Also checked: 768 × 1024 and 390 × 844 with no horizontal overflow; orbit/follow/top-down; keyboard selection; live telemetry and queue controls through the replay test; both real canvas charts; no browser JavaScript errors. Six scene resets held steady at 135 geometries and 43 textures. Switching to Evaluation left the map frame counter unchanged.

No new runtime dependencies, downloaded art, or changes to asset licenses.
