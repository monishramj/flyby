# Integrating the fly reflex with triage

Reviewed bases: triage `68033b6`, fly `53fed3c`, plus the lockstep rendering fix
`d80fb80`. The rehearsal remains local on `rehearsal/triage-fly`; never push that
branch or merge/push into main or triage from this task.

## Review artifact

`rehearsal-triage.patch` is a **single git-format patch of the resolved snapshot**,
parented to triage `68033b6`. It includes the fly assets, every merge resolution,
and the updated mission prototype. It is not just the last commit: ordinary
`git format-patch` skips merge commits and would lose their resolutions.
See the adjacent patch metadata for the exact source commit and tree check.
Apply it only to a new review branch at that base, using `git am <patch-path>`.
Do not apply it blindly over a newer checkout. Nothing from the mission prototype
is installed into server/ or the ground-station UI on fly/connectome.

## Browser and result contract

The mission emits `inspect.request` **on arrival at the lead**, after transit.
The patched UI opens one panel, mounts the live connectome once, and calls:

```ts
const outcome = await runInspection(panel, { lead_id, person, maxWallS: 27 });
// Display outcome.waypoints: [{id, status}], and outcome.realtime_factor.
const { reached, collided, found } = outcome;
send({ type: 'inspect.result', payload: { lead_id, reached, collided, found } });
```

Send only those four payload fields: server payloads reject extra fields, so
sending the whole outcome (frames, timing, waypoints, etc.) is invalid.
The panel accepts `maxWallS` in its mount options or the request; default 27 s.
It no longer derives an 8.5 s limit from the mission's old timer. Its watchdog
allows another 0.5 s for setup/result delivery. Busy requests keep the mission timer;
results after a reset or disconnect are discarded. One browser controls the flight.

The patch changes `InspectResult` to `reached: bool = True`,
`found: bool | None = None`, and `collided: bool`. Legacy clients remain accepted.
A collision **always** returns to `awaiting_human`, even if reached is true or
omitted. A not-reached result also returns to `awaiting_human`. Only a completed,
collision-free visit can resolve empty or offer dispatch. When found is null on
such a visit, simulation truth supplies the answer. This is not visual recognition.
The per-visit token guard prevents an older fallback timer from resolving a retry.

## Monish must finish the mission deadline before using the longer flight

These locations refer to triage `68033b6`; find the named functions if lines move.

| File / location | Required integration |
| --- | --- |
| `server/mission/loop.py:233–234`, `_start_visit` | Keep request emission on arrival. For a browser-owned visit, wait for inspect.result instead of calling the truth fallback at done_t. Add a hard cap around 30 wall seconds; a claimed visit timing out must become awaiting_human. A claim/ownership handshake is still needed to distinguish a flown lead from a timer-only lead. |
| `server/config.py:46`, `INSPECT_HOVER_S` | The current value is 40 sim seconds, only 10 wall seconds at scale 4. A temporary demo alternative is `INSPECT_HOVER_S=120` (30 wall seconds at scale 4). Set this before starting the mission. Do not run a 27-second browser flight with the default 10-second fallback. |
| `server/protocol.py:26`, `InspectResult` | Apply the patch's optional reached/found fields; retain the explicit reached flag in all new clients. |
| `server/app.py:90`, inspect.result handling | Forward reached to the mission result handler, as in the patch. |
| `server/mission/loop.py:449`, `_resolve_inspection` | Apply the patch's collision/not-reached human-review branch and retry token guard. |
| `web/src/inspection.ts`, request handler (new in patch) | Pass a maxWallS below the mission cap; display each waypoint status. Do not reintroduce the 8.5-second cap. |

The deadline handshake is **not implemented** by this patch. The environment
setting above is the bounded demo option. Request context is also still pending:
triage sends lead_id only, so person is undefined, the scene does not draw that
person, and found is null. Add a simulation-only person/structure field if desired.
The reflex must still see only rendered camera frames, never truth labels.

## Actual merge conflicts and resolutions

The first merge had 12 conflicted paths; merging the later waypoint/eye/efference
commits was clean. 'Triage' and 'fly' below identify sides, not Git ours/theirs.

| File | Triage side | Fly side | Chosen resolution and reason |
| --- | --- | --- | --- |
| `AGENTS.md` | Triage T0–T7 rules | Fly rules | Keep triage rules, append local rehearsal boundaries and fly handoff link. |
| `README.md` | Current triage specification | Original fly specification | Keep triage and add a short fly handoff link. |
| `bench/__init__.py` | Deleted | Fly package marker | Keep fly so bench assets remain a package. |
| `docs/SETUP.md` | Deleted | Old scaffold/fly setup | Restore and rewrite for the three-process combined setup. |
| `docs/TEAM.md` | Deleted | Original team agreement | Restore with current branch ownership and local-only review rules. |
| `reflex/__init__.py` | Deleted | Fly package marker | Keep fly service package. |
| `reflex/config.py` | Deleted | Working fly settings | Keep fly; required by the separate service. |
| `reflex/server.py` | Deleted | Working reflex WebSocket service | Keep fly; preserves CPU isolation. |
| `tests/test_config.py` | Updated triage config tests | Deleted/renamed to reflex-specific tests | Keep triage's version; keep separate reflex tests. |
| `tests/test_reflex_isolation.py` | Deleted original scaffold test | Renamed isolation test | Keep fly's static isolation test. |
| `uv.lock` | Triage dependencies | Fly optional dependencies | Regenerate from cleanly merged pyproject.toml. |
| `web/vite.config.ts` | Mission proxies | Mission + reflex proxies and page entries | Keep fly's combined configuration. |

Other fixes after the clean merge: add @types/node for triage's type-check of
vite.config.ts; restore ignore rules for fly runtime artifacts. Let triage's
runtime.py deletion stand: the reflex uses reflex/threads.py.

The wrap-up restores the **original main scaffold tests on fly/connectome**.
They are not the current triage tests: when merging the wrap-up later, preserve
triage's test_config.py and let Monish reconcile test_scaffold.py's old /health
expectation with triage's /api/health. Do not replace triage tests with scaffold tests.

## What changed in the demo instructions

Use one merged checkout and Vite as the browser origin; it proxies mission :8000
and reflex :8001. A standalone mission static server does not proxy the reflex.
inspect.html, connectome.html and flyviz.html are all production build entries.
The scene now follows entry → target in lockstep and exposes per-waypoint outcomes.
The default scene wall cap is 40 s; inspect.html passes 30 s and the rehearsal
panel passes 27 s. The old T_INSPECT_S=90 and 18-second-flight descriptions are stale.
Earlier local end-to-end timings in STATUS refer to the pre-waypoint revision and
must not be presented as timings for this updated patch.

