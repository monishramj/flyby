# Integrating the fly reflex with the triage demo (`triage` → `main`)

Reviewed against `origin/triage` at `895250c` on 2026-09-27 (read-only; nothing
pushed to `triage` or `main`).

## How the two halves fit

The demo is the overhead search from the `triage` branch: the drone sweeps, Laya
decides, and Grok maintains the picture. When a lead near a structure is approved
for **close-in inspection**, the mission emits `inspect.request`. The browser then
flies that inspection in our carport scene, with the fly reflex in the loop, and
answers with `inspect.result`. Leads not flown in the scene still resolve on the
mission's `T_INSPECT_S` timer.

```
mission (:8000) ──inspect.request {lead_id}──▶ browser ──frames──▶ reflex (:8001)
       ▲                                         │  ◀──commands──
       └──────inspect.result {lead_id, …}────────┘
```

## Our side (done on `fly/connectome`)

- `web/src/scene/flight.ts` exports the one call the mission UI needs:
  ```ts
  import { runInspection } from './scene/flight';
  const outcome = await runInspection(panelElement, { lead_id, person });
  // outcome: { lead_id, reached, collided, found, t, frames, min_clearance_m, late_replies, reflex_ok }
  ```
  It renders the chase view, the drone camera and a small HUD into `panelElement`.
  The flight stops after `maxWallS` (default 18 s) to fit the mission window.
  If the reflex is not running, it still flies (without the reflex) and reports
  `reflex_ok: false`.
- The reflex is reached **through the same origin**. `web/vite.config.ts` proxies
  `/ws/reflex` and `/reflex/*` to :8001, ahead of the triage proxies for `/ws`
  and `/api` to :8000. Our `vite.config.ts` already includes the triage proxies.
- `reflex/` no longer imports the root `runtime.py`, which `triage` deletes;
  it uses `reflex/threads.py`. The isolation test and reflex config tests moved to
  `tests/test_reflex_isolation.py` and `tests/test_reflex_config.py`, which
  `triage` does not touch.
- The reflex stays a separate process: no server imports, no DB, no network.

## Needed on the mission side (proposals for Monish)

1. **Wire the request (`web/src/main.ts`, `web/src/ws.ts`).** On
   `inspect.request`, open a panel, `await runInspection(...)`, then send
   `{type: 'inspect.result', payload: {lead_id, found, collided}}`. Add that
   command to the `Command` type in `ws.ts`. Fly one inspection at a time and
   let the others fall back to the timer.
2. **Result semantics (`server/protocol.py`, `server/mission/loop.py`).**
   Today `found` overrides truth. A crashed or blocked inspection would therefore
   mark a real person's lead empty. Proposal:
   `InspectResult {lead_id, reached: bool, collided: bool, found: bool | None}`.
   If `reached`, use `found`, or truth when `None`. If not reached, return the
   lead to a human (e.g. `awaiting_human`, "inspection incomplete"), not
   `resolved_empty`. Log `collided` in the lead and the metrics.
3. **Request context (`inspect.request`).** Add `{structure: "carport" | "house",
   person: bool}` so the scene can draw the person under the roof. `person`
   comes from simulation truth; the reflex never sees it, only the rendered scene.
4. **Timer.** `T_INSPECT_S = 90` sim-s at `LIVE_TIME_SCALE = 4` is 22.5 s of wall
   time. A flight is capped at 18 s, plus the time to open the panel. Suggest
   pausing the fallback timer while a browser flight is running, or raising it for
   the flown lead.
5. **Scale and look.** The mission's carport is `CARPORT_SIZE_M = (24, 18)`. Our
   inspection carport is 2.8 × 5 m, matching README Step 6.2. Either treat the
   scene as a close-in section of that structure, or align the sizes. After the
   merge we can build our carport from the triage Kenney assets
   (`structure-metal-roof`, `metal-panel`, `planks`, …) so both views match.
6. **One machine.** Laya and flyvis both run on the Mac's CPU. Set thread
   counts for both and measure them together before promising 50 Hz.

## Merge rehearsal (fly/connectome + triage, local only)

Conflicts and how to resolve them:

| File | Resolution |
| --- | --- |
| `README.md`, `AGENTS.md` | Keep triage's; add a short fly-reflex section linking `docs/fly-connectome/` |
| `docs/SETUP.md`, `docs/TEAM.md` (deleted in triage) | Keep ours, updated for the triage commands |
| `reflex/config.py`, `reflex/server.py` (deleted in triage) | **Keep ours** |
| `reflex/__init__.py`, `bench/__init__.py` | Keep ours (now non-empty, so a deletion shows as a conflict instead of a silent delete) |
| `tests/test_config.py` | Take triage's (our reflex tests moved out) |
| `web/vite.config.ts` (both added) | Take ours (it is triage's proxies plus ours) |
| `uv.lock` | Regenerate with `uv lock` after merging `pyproject.toml` (it merged cleanly and keeps the `fly` extra) |
| `web/package.json` | Merged cleanly; keep triage's `jsdom` and ranges |

After merging, run `uv lock`, `uv sync --extra fly`, the full pytest suite and
`npm run build`, then fly one `inspect.request` end to end.
