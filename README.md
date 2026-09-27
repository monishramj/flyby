# FlyBy Triage

**Drone search-and-rescue triage: turn a stream of drone detections into a ranked, confidence-scored queue that an incident commander can act on in one click.**

HackGT 13 · Georgia Tech · Sept 25–27, 2026. Submissions are due **Sunday 8:00 AM** to **both** Devpost and expo.hexlabs.org.

**Build target: about 6 agent-hours.** This README is self-contained. Anything not listed here is out of scope unless the "Agent's choice" notes allow it.

---

## Abstract

**Who it's for:** the incident commander on a disaster search. They sit at a ground-station laptop while drone detections arrive faster than anyone can verify them, and they decide where crews go.

**The problem:** drones collect more imagery than people can review during the hours when survivors are still alive. Automated detectors don't fix this on their own: they flag debris and rocks as people, so verifying flags becomes the new bottleneck. Even confirmed leads can stall on the way to a crew when comms are down.

**What this builds:**

- **Simulated search.** A drone sweeps a flooded neighborhood, and a detector noise model produces leads with known ground truth.
- **Laya decisions.** For each lead, Laya (an open-weights, Jev-compatible decision model running locally) returns an action, an urgency, and P(person), each with a probability. Leads below a confidence threshold go to a human.
- **Grok intel.** Grok turns messy radio and text intel into a structured incident picture. Code merges it, and it feeds the context Laya decides on. When new intel changes a pending lead's context, that lead is re-decided, so the queue re-ranks.
- **Crew orders.** Laya decides *what*; when a dispatch or inspection enters the queue, Grok writes *how*: an order (approach, hazards to avoid and from which direction, what to verify) from the incident picture, with every direction and number computed by code. Grok never changes the action. A human approves every dispatch with one click, and the order is already written, so dispatch makes no network call. (The Ask Ground Control chat is disabled in the UI; its backend remains.)

**How we prove it worked** (all in simulation, with declared assumptions):

1. **Faster:** time from a subject's first capture to dispatch, vs. a simulated manual reviewer.
2. **Trustworthy:** whether Laya's P(person) is calibrated. We measure this with a reliability diagram and ECE against raw detector confidence. It's a result to report, not an assumption.
3. **Resilient:** the decision loop keeps working with Wi-Fi off.

## Features (in scope)

- Seeded mission sim: area, sectors, landmarks, subjects, decoys, sweep, captures, detector noise, and ground-truth labels
- Laya triage with a rule-based fallback and routing to a human
- **Re-decision** of pending leads when new intel changes their context
- Grok intel parsing into a schema, merged deterministically into an in-memory incident picture
- Grok crew orders, written while a lead waits for approval (numbers inserted by code)
- Ground-control UI: 3D map beside one Work column (queue with approve, override and "Why?"; reviewable auto-closed bin); incident and intel in a closed Context drawer
- Human-load metric: of every flag, how many needed judgment, one click, or no human
- MongoDB Atlas logging, with a local JSONL fallback
- Batch evaluation and a results tab

**Deferred (build only if everything above is done):** a 3D view of the mission, and extra charts.

**Out of scope:** real drones, autonomous navigation, multi-drone, policy comparisons beyond Laya vs. the rule, and any onboard drone behavior. Close-in inspection is modeled as a timed step (see the lifecycle below). An optional external hook exists for it, but nothing here depends on it.

## Tech stack

**Status key:**

- **doc** means taken from the library's docs or repo during planning, not yet run by us.
- **smoke** means verified by the named step before anything depends on it.

| Piece | Use | Status |
| --- | --- | --- |
| Python 3.12 + `uv`, FastAPI, uvicorn, WebSockets | Server `:8000` | doc |
| **Laya** (Convai Innovations, Apache-2.0, \~421M params) | Typed decisions (`choice` / `score` / `noul`) with per-option probabilities in one forward pass; Jev-compatible `system_one` shape | **doc:** API shape, \~1.7 GB weights, \~2 GB RAM, \~140 ms per 3-question call reported for the Node/ONNX port on an Apple-silicon CPU, 512-token state cap. **smoke (T0.2):** Python runtime, latency, and a quick accuracy sanity check |
| **Grok** via `xai-sdk` | Structured outputs (Pydantic) and function calling | **doc:** both supported. **smoke (T0.3):** model id, credit code `SPACEXAI_HACK_GT_20260925` |
| MongoDB Atlas + PyMongo (async client) | Persistence, chat stats | **smoke (T0.4):** reachable from venue Wi-Fi |
| Vite + TypeScript (vanilla) + `chart.js` | UI | doc |
| numpy, pandas, pyarrow, matplotlib, pytest, httpx | Metrics and tests | doc |

**Hardware:** one Apple-silicon Mac with 16 GB+ RAM. **Builders:** AI coding agents, step by step. **HUMAN** marks a person's call.

---

## 1. Architecture

```
BROWSER (web/)                       SERVER (server/)
2D map · queue · intel feed    ◀──▶  Mission loop (sim clock): scenario, sweep, noise
decision log · Ask chat ·    ws/http Incident picture (in memory; live copy)
results                               ▲ Grok intel parse (async) + deterministic merge
                                     State builder → decide(): Laya → rule on error
                                     Re-decide pending leads on context change
                                     Lead lifecycle · approvals · Grok crew orders
                                     Ask Ground Control: Grok + 4 read-only tools
                                     Mongo writer (async queue → Atlas | JSONL)
```

### Hard rules

1. **Fast decision path.** Going from a lead to a decision never waits on Grok, never reads Mongo, and never calls the network. It reads the incident picture from memory only.
2. **Mongo is write-behind.** All writes go through a queue, and nothing awaits them. The one read is the `get_decision_stats` chat tool, which is off the decision path.
3. **Grok never decides.** Grok proposes schema-checked incident updates, and code merges them. Grok writes brief text, but code inserts every number. Grok's chat tools are read-only.
4. **One config.** Every constant lives in `server/config.py`.
5. **Deterministic.** The same `(seed, config)` gives the same run, apart from latency values and any timeouts they cause.

### Lead lifecycle

```
captured → decided ─┬─ auto (max prob ≥ TAU_ROUTE):
                    │    ignore, low camera score, in the open, ≥ TAU_CLOSE → auto_closed (confirm or reopen)
                    │    ignore, anything else       → awaiting_human (it could be a person)
                    │    reimage_zoom           → reimaging → recapture (pass+1) → decided
                    │    dispatch / inspect     → awaiting_approval
                    └─ routed (max prob < TAU_ROUTE, fallback, or pass > MAX_PASSES) → awaiting_human

awaiting_approval / awaiting_human ──approve / override──▶ dispatched | reimaging | inspecting | ignored

inspecting ──drone flies there, INSPECT_HOVER_S──▶ person found → awaiting_approval (action = dispatch_ground_team)
                                  nothing found → resolved_empty

While a lead is awaiting_approval or awaiting_human: if an incident update changes its
built state, it is re-decided (new decision appended to its history; queue re-sorts).
```

**Lifecycle notes:**

- Dispatch and inspection always need a human click. Nothing is closed silently: `auto_closed` leads stay listed, can be reopened, and are re-decided when new intel changes their context.
- A lead can be re-imaged at most once. At pass `MAX_PASSES` (= 2), a `reimage_zoom` decision routes the lead to a human instead of re-imaging again.
- Leads that are dispatched, ignored, reimaging, or inspecting are never re-decided.
- **Optional external hook:** when an inspection starts, the server emits `inspect.request {lead_id}`. If an external client answers `inspect.result {lead_id, found, collided}` before the timer runs out, that answer wins. Nothing in this README requires a client to exist.

### Repo layout (minimum; agents may add internal modules)

```
flyby-triage/
  AGENTS.md  README.md  .env.example  pyproject.toml
  server/  config.py app.py protocol.py
           mission/ incident/ triage/ grok/ store/
  web/     index.html src/ (ws, store, map, queue, intel, log, ask, results)
  batch/   run_eval.py metrics.py
  tools/   laya_smoke.py grok_smoke.py atlas_smoke.py laya_check.py demo_check.py
  data/    gazetteer.json intel_templates.json
  results/ logs/ tests/
```

---

## 2. AGENTS.md (paste at the start of every agent session)

```
You are implementing FlyBy Triage. README.md is the source of truth; read the sections
referenced by your step first.

- Implement ONLY the current step. Where README says "Agent's choice", decide sensibly
  and note the decision in your report. Otherwise, do not add features.
- Follow README §1 hard rules and the lead lifecycle exactly.
- Python 3.12 with uv. Add dependencies only if the step names them.
- Never invent API details for Laya or xai-sdk: read the real package/repo source first.
- Finish with the step's tests passing (`uv run pytest <paths>`) or its acceptance check
  shown, with commands and output.
- If README conflicts with how a library actually works, implement the closest
  faithful version and list it under "Deviations".
- Report: files changed, commands + output, decisions made, deviations, open issues.
```

---

## 3. Constants (`server/config.py`; freeze at T7)

| Name | Value | Meaning |
| --- | --- | --- |
| `AREA_M` / `SECTOR_GRID` | 300 / 3 | Square area, origin SW; sectors S1–S9, S1 = SW, row-major west→east, south→north |
| `ALT_M` / `FOV_DEG` | 40 / 60 | Footprint = 2·40·tan 30° ≈ 46.2 m |
| `LANE_SPACING_M` / `CAPTURE_SPACING_M` / `SWEEP_SPEED_MPS` | 40 / 40 / 8 | 8 lanes, \~64 captures, \~5.5 min sim |
| `LIVE_TIME_SCALE` | 4.0 | Live speed-up |
| `N_SUBJECTS` / `N_DECOYS` | 5–8 / 10–15 |  |
| `OBJECT_SIZE_M` | subject 1.7, person_shaped_junk 1.5, animal 0.8, warm_spot 1.0, debris 2.0 | For `box_px` |
| `NOISE` | T1.2 table | Detection probability and confidence |
| `SMALL_BOX_PX` | 20 |  |
| `MAX_PASSES` | 2 |  |
| `TRANSIT_SPEED_MPS` / `ZOOM_HOVER_S` / `REIMAGE_BOX_MULT` / `REIMAGE_CONF_SHIFT` | 12 / 10 / 3.0 / +0.20 subjects, −0.10 decoys | A reimage is a real drone visit; the sweep pauses |
| `INSPECT_HOVER_S` | 40 | Close-in inspection is a drone visit too |
| `TAU_ROUTE` | 0.60 | Tuned in T2.4 |
| `LAYA_TIMEOUT_MS` | 500 | Reset to ≈3× measured p95 |
| `RHO` | 0.9 | Share of intel messages pointing at a real subject |
| `INTEL_COUNT` | 12–15 |  |
| `GROK_PARSE_TIMEOUT_S` / `GROK_ORDER_TIMEOUT_S` / `GROK_ASK_TIMEOUT_S` | 10 / 20 / 20 | Crew orders measured at 6–11 s |
| `ASK_MAX_TOOL_ROUNDS` | 4 |  |
| `SIM_HUMAN_ROUTED_S` / `SIM_HUMAN_APPROVE_S` / `HANDOFF_S` | 20 / 5 / 60 |  |
| `SIM_HUMAN_ACC` | 0.9 | Batch human picks the optimal action with this probability; otherwise a random different action |
| `REVIEW_S` | 120 and 10 | Manual reviewer seconds per image. The 1–3 min per image and 10 s figures are from CRASAR (Murphy & Manzini, 2025) |

---

## 4. Data contracts

### 4.1 Laya state

```json
{
  "lead": {"detector_conf": 0.62, "detector_band": "medium", "box_px": 34, "size_band": "medium",
           "altitude_m": 40, "sector": "S3", "near_structure": true, "passes": 1},
  "context": {"dist_to_last_known_point_m": 55, "near_last_known_point": true,
              "sector_priority": "critical", "hazards_nearby": ["downed_line"],
              "reported_subjects_in_sector": 3, "confirmed_subjects_in_sector": 1},
  "mission": {"coverage_pct": 42, "open_leads": 5}
}
```

**Bands:**

- `detector_band`: low \< 0.45 ≤ medium \< 0.75 ≤ high
- `size_band`: small \< 20 px ≤ medium \< 60 px ≤ large
- `near_last_known_point`: \< 100 m
- `hazards_nearby`: within 50 m

**Rules:**

- Omit unknown fields; never send null.
- Every `context` field comes from the incident picture, except `confirmed_subjects_in_sector`, which is the count of dispatched leads in that sector.
- Keep the key order fixed.

### 4.2 Laya questions (one call)

| Key | Type | Instructions | Criteria |
| --- | --- | --- | --- |
| `action` | choice | "What should incident command do with this drone lead?" | `dispatch_ground_team`: "likely a real person who is clearly visible and reachable; send a crew" `reimage_zoom`: "possibly a person but the image is small or partly hidden; take another zoomed pass" `close_in_inspect`: "possibly a person inside or under a structure the overhead camera cannot see into" `ignore`: "likely debris, an animal, a warm spot, or a false alarm" |
| `urgency` | score | "How urgent is this lead?" | `["low","moderate","high","critical"]` → 0–3 |
| `is_person` | noul | "Is this lead a real person?" | none |

### 4.3 Decision

`Decision { action, probs{4}, urgency|None, p_person|None, latency_ms, used_fallback, routed_to_human, source: "laya"|"rule", version }`

`async decide(state, *, policy="laya"|"rule") -> Decision`. Each lead keeps a list of decisions (its history); the newest one is current.

### 4.4 Ground truth (`mission/truth.py`)

The optimal action for a lead depends on the object's truth and the pass number:

| Object | Pass 1 | Pass 2 (after zoom) |
| --- | --- | --- |
| Decoy | `ignore` | `ignore` |
| Subject, `under_structure` | `close_in_inspect` | `close_in_inspect` |
| Subject, `partial`, or `box_px < 20` | `reimage_zoom` | `dispatch_ground_team` |
| Subject, other | `dispatch_ground_team` | `dispatch_ground_team` |

On pass 2 the zoom resolves both partial visibility and small size.

### 4.5 Grok schemas

**Enums:**

- `Sector`: S1–S9
- `Landmark`: the keys of `data/gazetteer.json`
- `Urgency`: `low`, `moderate`, `high`, `critical`
- `Hazard`: `downed_line`, `rising_water`, `collapse_risk`, `fire`, `gas`

**`Report` fields:**

- `sector?`
- `landmark?`
- `subject_count?` (0–20)
- `urgency`
- `hazards[]`
- `source` (`firsthand`, `secondhand`, or `unverified`)
- `is_retraction`

**`IntelParse`:** `{ reports[], unparseable }`

**`BriefText` fields:**

- `headline` (≤ 80 characters)
- `what_drone_saw` (≤ 240)
- `access_notes` (≤ 240)
- `confidence_statement` (≤ 160)

### 4.6 Incident picture and merge rules

`{ run_id, reports[], sector_priority{S→urgency}, reported_subjects{S→int}, hazards[{type,x,y}], last_known_point{landmark,x,y,t}|null }`

**Merge rules:**

- A sector's priority is the highest urgency among its non-retracted reports. A report that names only a landmark counts toward that landmark's sector.
- A sector's reported-subject count is the maximum `subject_count` among those same reports.
- Hazards are the union of all reported hazards, placed at the report's landmark or, failing that, the sector's center.
- The last-known point is the most recent `firsthand` report. If there is none, it's the most recent report that names a landmark.
- A retraction removes the most recent earlier report that matches its sector or landmark.

### 4.7 Mongo collections (every document carries `run_id`)

| Collection | Contents |
| --- | --- |
| `runs` | seed, kind (live/batch), policy, config, started_at |
| `leads` | t_capture, pos, sector, pass, truth, state, decision history, baseline_rule, status history, human, dispatch |
| `intel` | t, raw, oracle_parse, grok_parse, latency, ok |
| `incidents` | latest picture (upserted by `run_id`) |
| `qa` | question, tool_calls, answer, latency |

### 4.8 Protocol

**WebSocket `/ws/mission`, server → web:**

| Message | Payload |
| --- | --- |
| `mission.snapshot` | Scene for rendering |
| `mission.state` | `{t, drone, coverage_pct, coverage_cells}`, 10 Hz |
| `lead.new` | `{lead_id, x, y, sector, pass}` |
| `lead.decided` | `{lead_id, decision, status}` (also sent on re-decision) |
| `lead.status` | `{lead_id, status}` |
| `intel.new` | `{intel_id, t, raw}` |
| `intel.parsed` | `{intel_id, parse, ok}` |
| `incident.update` | Latest picture |
| `dispatch.created` | `{lead_id, brief, pin}` |
| `inspect.request` | `{lead_id}` (optional hook) |

**WebSocket `/ws/mission`, web → server:**

| Message | Payload |
| --- | --- |
| `mission.control` | `{cmd, seed?}` where `cmd` is `start`, `pause`, or `reset` |
| `lead.approve` | `{lead_id}` |
| `lead.override` | `{lead_id, action}` |
| `inspect.result` | `{lead_id, found, collided}` (optional hook) |

**HTTP:**

- `POST /api/ask {question}` → `{answer, tool_calls[]}`
- `GET /api/results/{name}` → files in `results/`

---

## 5. Build plan (\~6 agent-hours)

Each step has a **Context** (when needed), **Build**, **Tests/Acceptance**, and **Prompt**. Gates are fail-fast checkpoints. If a gate fails, stop and make the HUMAN call listed at that gate.

| Phase | Budget |
| --- | --- |
| T0 Setup + smoke tests | 0.75 h |
| T1 Mission core | 0.75 h |
| T2 Decisions | 1.0 h |
| T3 Live server | 0.75 h |
| T4 UI | 1.0 h |
| T5 Grok | 1.25 h |
| T6 Evaluation | 0.5 h |
| T7 Demo | 0.25 h |

**If behind, cut in this order:**

1. The deferred 3D view
2. Grok briefs (fall back to templates)
3. Extra results charts (keep only time-to-dispatch and the reliability diagram)

**Never cut:** the decision loop, re-decision on intel, Ask Ground Control, or the time-to-dispatch number.

### T0: Setup and smoke tests

#### T0.1: Scaffold

**Build:**

- The repo layout and `AGENTS.md`.
- `pyproject.toml` with fastapi, uvicorn\[standard\], pydantic, pydantic-settings, numpy, pandas, pyarrow, matplotlib, pymongo, python-dotenv, httpx, pytest, pytest-asyncio. Register the pytest markers `slow` and `network`.
- `server/config.py` with every §3 constant. Secrets (`XAI_API_KEY`, `XAI_MODEL`, `MONGODB_URI`) come from `.env`.
- `web/` scaffolded with Vite vanilla-ts plus `chart.js`.

**Tests:** a config import test passes, and `npm run dev` serves.

**Prompt:**

```
T0.1. Scaffold per README §1 layout and §2; pyproject with only the listed deps and the
slow/network markers; server/config.py with every §3 constant (secrets from .env);
.env.example; web/ via Vite vanilla-ts + chart.js. Add a config import test.
```

#### T0.2: Laya smoke + early accuracy check (fail fast)

**Context.** Laya is the decision engine, and its quality on SAR-style states is unknown. Find out in the first hour. There are two runtime paths:

- (a) the Hugging Face reference `convaiinnovations/laya` (`rl_agent_api.py`, `RLAgent.system_one`) on PyTorch, CPU or MPS
- (b) `onnxruntime` on the published ONNX bundle

**Build:**

- `server/triage/laya_runtime.py`: `load()` and `system_one(state, questions)`, which returns normalized answers plus `latency_ms`.
- `tools/laya_smoke.py`:
  - 50 warm calls, reporting p50/p95
  - **20 hand-written §4.1 states covering all four §4.4 outcomes**, with their expected actions; print Laya's accuracy and each answer

**Tests** (marked `slow`): the answer keys match the questions, the action probabilities sum to 1 ± 1e-3, the score is in 0–3, and noul is in 0–1.

**GATE T0.2 (HUMAN):**

- If Laya scores ≥ 50% on the 20 states (chance is 25%), proceed.
- Otherwise, try up to 3 rewordings of the §4.2 criteria. If it's still below 50%, set the live `policy="rule"`, keep Laya logging, and continue. Nothing downstream changes.
- Record the runtime and p95, and set `LAYA_TIMEOUT_MS`.

**Prompt:**

```
T0.2 (README Tech stack, §4.1–4.4). Download and read rl_agent_api.py, rl_common.py,
rl_agent_config.json from Hugging Face convaiinnovations/laya; learn the real
RLAgent.system_one signature. Implement server/triage/laya_runtime.py; fall back to
onnxruntime with the published ONNX bundle behind the same interface if needed. Write
tools/laya_smoke.py with latency timing and 20 hand-labeled states spanning every §4.4
outcome; print accuracy. Quote the real signature; report device, p50/p95, accuracy.
```

#### T0.3: Grok smoke

**Build:**

- `server/grok/client.py` (async):
  - `parse(system, user, schema, timeout)` returns a Pydantic instance.
  - `chat_with_tools(messages, tools, tool_impls, max_rounds, timeout)` returns `(answer, trace)`.
  - The model comes from `XAI_MODEL`.
- `tools/grok_smoke.py`: one parse and one tool round trip, with latency.

**Tests:** marked `network`.

**HUMAN:** pick a fast model id in the SpaceXAI Console.

**Prompt:**

```
T0.3 (README §1 rule 3). Add xai-sdk; read its source to confirm Pydantic structured
outputs and client-side function calling. Implement server/grok/client.py and
tools/grok_smoke.py. Report exact SDK calls and latencies.
```

#### T0.4: Mongo writer

**Build:**

- `server/store/writer.py`:
  - `start()`, `put()` (non-blocking), `put_many()`, and `stop()` (drains the queue).
  - A single background task writes through PyMongo's async client and upserts `incidents` by `run_id`.
  - Any failure appends to `logs/<collection>.jsonl`.
- `tools/atlas_smoke.py`.

**Tests:**

- With a bad URI, `put` returns in under 5 ms and writes JSONL.
- With a real URI (marked `network`), documents arrive in Atlas.

**Prompt:**

```
T0.4 (README §1 rule 2, §4.7). Implement server/store/writer.py and
tools/atlas_smoke.py per T0.4 with PyMongo's async client (confirm the installed API).
put() never awaits I/O.
```

### T1: Mission core (headless)

#### T1.1: Clock and scenario

**Build:**

- **`mission/clock.py`:** `SimClock` with a scaled real-time mode, a fast mode, `call_at`, and `now`.
- **`data/gazetteer.json`:** 10–12 landmarks spread across all sectors.
- **`mission/scenario.py`:** `generate(seed, cfg)` produces:
  - houses, water, and trees
  - at least one structure that people can be under (e.g., a carport)
  - subjects `{id, x, y, visibility: visible|partial|under_structure}`
  - decoys `{id, x, y, type}`
  - `sector_of`, `nearest_landmark`, and `snapshot()`

**Agent's choice:** scene layout details and landmark names.

**Tests:**

- same seed → same scenario
- counts within the configured ranges
- everything inside the area
- sector convention correct
- the snapshot is JSON-serializable

**Prompt:**

```
T1.1. Implement mission/clock.py, data/gazetteer.json, mission/scenario.py per T1.1
with numpy Generator seeded randomness, plus tests.
```

#### T1.2: Sweep, detector noise, truth

**Build:**

- **`mission/sweep.py`:**
  - 8 lanes, 40 m apart, flown at 40 m altitude and 8 m/s
  - `position_at(t)`
  - `captures()` every 40 m, each with its footprint
  - `coverage(t)` on a 5 m grid
- **`mission/noise.py`:** `detect(capture)`. Each object inside the footprint gets an independent draw from the table below.
  - Confidence is `clip(N(μ, 0.15), 0, 1)`.
  - `box_px = size_m / footprint_m × 640`.
  - `near_structure` comes from the scenario.
  - Footprints overlap, so an object missed in one capture gets a fresh draw in each later capture that contains it. Each object produces at most one lead per pass.
  - `recapture()` applies the reimage constants.
- **`mission/truth.py`:** §4.4.

| Truth | P(detect) | μ conf |
| --- | --- | --- |
| subject: visible / partial / under_structure | 0.90 / 0.60 / 0.30 | 0.75 / 0.55 / 0.40 |
| decoy: person_shaped_junk / animal / warm_spot / debris | 0.50 / 0.40 / 0.30 / 0.15 | 0.45 |

These numbers are declared simulation assumptions, not measured detector performance. State that in the pitch.

**Tests:**

- footprint ≈ 46.19 m
- 60–70 captures
- sweep duration 300–360 s
- coverage ≥ 99%
- per-capture detection rates within ±0.03 of the table over 2,000 draws
- no object yields two leads in one pass
- every §4.4 cell is covered

**Prompt:**

```
T1.2 (README §3, §4.4, T1.2 table). Implement mission/sweep.py, noise.py, truth.py per
T1.2 using config constants only, plus tests.
```

#### T1.3: Intel script

**Build:**

- `incident/schemas.py`: the §4.5 models.
- `data/intel_templates.json`: about 15 messy radio/text templates, including 1 retraction and 1 vague message. Each carries metadata that fully determines its `IntelParse`.
- `mission/intel_script.py`: `generate(scenario, rng)` produces `INTEL_COUNT` messages spread across the sweep. A share `RHO` of them target a real subject's landmark or sector. Each message carries an `oracle_parse` built from its template metadata.

**Agent's choice:** the template wording (realistic, messy, incident-command style).

**Tests:** deterministic output; every `oracle_parse` validates.

**Prompt:**

```
T1.3 (README §4.5). Implement incident/schemas.py, data/intel_templates.json,
mission/intel_script.py per T1.3, plus tests.
```

### T2: Decisions

#### T2.1: Incident picture

**Build:**

- `incident/merge.py`: `apply(picture, parse, intel_id, t, gazetteer)`, a pure function implementing the §4.6 rules.
- `incident/store.py`: `snapshot()` returns an immutable copy; also `apply()` and an `on_update` hook.

**Tests:**

- priority is the maximum urgency
- a retraction removes the right report
- a firsthand report outranks a newer secondhand one for the last-known point
- a landmark-only report maps to its sector
- a snapshot doesn't change after later applies

**Prompt:**

```
T2.1 (README §4.6). Implement incident/merge.py and incident/store.py with tests.
```

#### T2.2: State, rule, decide()

**Build:**

- **`triage/state.py`:** `build_state(...)` per §4.1.
- **`triage/fallback.py`:** `rule(state)`:
  - confidence ≥ 0.75 → dispatch
  - confidence ≥ 0.45 → `close_in_inspect` if `near_structure`, else `reimage_zoom`
  - otherwise `ignore`
  - probabilities are one-hot
- **`triage/decide.py`:** leads are decided **one at a time in FIFO order** on a single-worker thread pool.
  - The `LAYA_TIMEOUT_MS` clock starts only when a lead's inference begins, so time spent queued doesn't count.
  - On error or timeout, use `rule` and set `used_fallback` and `routed_to_human`.
  - Route to a human when the top probability is below `TAU_ROUTE`, or when `passes > MAX_PASSES`, or when a pass-`MAX_PASSES` lead's decision is `reimage_zoom`.

**Tests:**

- golden state files
- every rule branch
- with a fake runtime: timeout → fallback, exception → fallback, low probability → routed
- 5 leads submitted at once, each taking 0.4 × timeout: none fall back

**Prompt:**

```
T2.2 (README §4.1–4.4, §1 rule 1). Implement triage/state.py, fallback.py, decide.py
per T2.2 with tests using a fake Laya runtime.
```

#### T2.3: Re-decision on context change

**Context.** New intel has to re-rank leads that are already in the queue. That only happens if their decision is recomputed.

**Build:** a function `on_incident_update(picture)` that, for every lead in `awaiting_approval` or `awaiting_human`:

1. rebuilds its state
2. compares the new state with the state its last decision used
3. if they differ, runs `decide()` again (queued FIFO like any lead), appends the result to the lead's decision history, and emits `lead.decided`
4. if a re-decision changes the action, moves the lead to the right status per the lifecycle

**Agent's choice:** whether to debounce bursts of intel.

**Tests:**

- an intel message raising a sector's priority re-decides a pending lead in that sector and leaves other sectors alone
- dispatched and ignored leads are never re-decided

**Prompt:**

```
T2.3 (README §1 lifecycle re-decision note). Implement on_incident_update per T2.3 with
tests.
```

#### T2.4: Laya check and routing threshold

**Build:** `tools/laya_check.py`:

- Runs the mission headless on seeds 100–104, with oracle intel replayed up to each capture time.
- Runs `laya` and `rule` on every lead.
- Prints:
  - action accuracy per policy, against §4.4 truth
  - ECE (10 equal bins) for Laya's P(person) vs. the detector's confidence, where ECE = Σ_b (n_b/N)·|acc_b − conf_b|
  - latency p50/p95
  - auto-handled accuracy vs. routing rate, for `TAU_ROUTE` from 0.4 to 0.8

**HUMAN:** set `TAU_ROUTE` to the lowest value where auto-handled accuracy is ≥ 90%. If no value gets there, use the value where about 30% of leads are routed to a human. Record whether Laya's P(person) came out better or worse calibrated than detector confidence, and phrase the pitch to match.

**Prompt:**

```
T2.4. Implement tools/laya_check.py per T2.4. Print tables only; do not change defaults.
```

### T3: Live server

#### T3.1: Mission loop and WebSocket

**Build:**

- **`server/protocol.py`:** the §4.8 message models.
- **`mission/loop.py`:** `MissionRun(seed, cfg, policy, parse_mode="oracle"|"grok", sim_human=False)`. It owns the clock, scenario, captures, the lifecycle from §1, re-decision, the incident store, and the intel schedule. It emits events. Timing depends on mode:
  - **Live:** decisions are queued, so captures never wait on them.
  - **Fast (batch):** the clock doesn't advance past a lead until its decision returns. The decision is stamped `t_capture + latency_ms / 1000`.
  - **Inspections:** the drone flies to the lead and resolves after `INSPECT_HOVER_S` using truth. If `inspect.result` arrives first and the run is live, it wins.
  - **`sim_human=True`:** routed leads get an action after `SIM_HUMAN_ROUTED_S`, and approvals happen after `SIM_HUMAN_APPROVE_S`. The simulated human picks the §4.4 optimal action with probability `SIM_HUMAN_ACC`; otherwise it picks a random different action.
- **`server/app.py`:** at startup, loads Laya and starts the writer. `/ws/mission` streams events plus `mission.state` at 10 Hz.

**Tests:**

- a fast run with a fake runtime processes every capture
- lifecycle transitions are valid
- a reimage leads to a pass-2 lead
- a pass-2 reimage decision routes to a human
- an inspection that finds a person leads to `awaiting_approval` for dispatch
- event order is deterministic
- a WebSocket integration test

**Prompt:**

```
T3.1 (README §1 lifecycle, §4.8). Implement server/protocol.py, mission/loop.py,
server/app.py per T3.1 with tests using a fake Laya runtime. MissionRun is reused by
batch evaluation.
```

#### T3.2: Approvals, template briefs, persistence

**Build:**

- Handle `lead.approve` and `lead.override`.
- On dispatch: `template_brief(lead, picture)`, then emit `dispatch.created` with the brief and a pin.
- Writer wiring:
  - `runs` at start
  - `leads` upserted on every status change or decision
  - `intel` on arrival
  - `incidents` on every update

**Tests:**

- the brief's coordinates and P(person) come from code
- an override sets `final_action`
- a writer whose `put` sleeps 1 s leaves decision latency unchanged

**Prompt:**

```
T3.2 (README §1 rules 1–2, §4.7). Implement T3.2 with tests including the slow-writer
test.
```

### T4: UI

#### T4.1: Client core, map, queue, feed, log

**Build:**

- `ws.ts` with typed messages matching `protocol.py`, and an observable store.
- Controls: seed, start, pause, reset, and Demo.
- **2D map** (canvas):
  - sectors and landmarks
  - the swept path and a coverage heatmap
  - the drone
  - lead pins colored by action or status
  - hazards and the last-known point
- **Queue:** routed leads first, then by urgency descending, then by P(person). Each card shows:
  - a lead visual
  - the action and a 4-way probability bar
  - urgency and P(person)
  - a "needs human" badge
  - a "re-ranked" marker when a re-decision changed the action or urgency
  - approve and override controls
  - the brief in a modal
- **Intel feed:** raw message plus parsed chips, or "parsing…".
- **Decision log:** includes re-decisions.

**Agent's choice:** layout, styling, and the lead visual (e.g., a simple icon or crop).

**Acceptance:** the whole loop works by hand, and a new intel message visibly re-ranks the queue.

**Prompt:**

```
T4.1 (README §4.8, §1 lifecycle). Build the UI per T4.1 in vanilla TS. All data comes
from the server; no client-side fabrication.
```

**GATE T4 (fail fast):** the triage loop runs live end to end (oracle intel, template briefs), re-ranking works, and records land in Mongo or JSONL.

### T5: Grok as part of the system

#### T5.1: Intel → incident picture

**Build:**

- `grok/parse.py`: `parse_intel(raw, gazetteer)` returns an `IntelParse`. The system prompt covers the incident-command context, the allowed sectors and landmarks, `unparseable`, and `is_retraction`.
- The `parse_mode="grok"` path in `MissionRun`:
  1. emit `intel.new`
  2. parse in the background with a timeout
  3. on success: apply to the store, emit `intel.parsed` and `incident.update`, then trigger re-decision (T2.3)
  4. on failure: emit `intel.parsed{ok:false}` and leave the picture unchanged

**Agent's choice:** prompt wording, as long as it's versioned (`PROMPT_VERSION`).

**Tests** (mocked Grok):

- a timeout leaves the picture unchanged
- a success applies the update and triggers re-decision
- a lead decided while a parse is pending uses the earlier snapshot

**Prompt:**

```
T5.1 (README §1 rules 1 and 3, §4.5–4.6, T2.3). Implement grok/parse.py and the grok
parse mode per T5.1 with mocked-client tests.
```

#### T5.2: Grok briefs

**Build:**

- `grok/briefs.py`: `write_brief(lead, picture)` returns a `BriefText` built from categorical facts only, with no numbers in the text.
- Code assembles the final brief: id, coordinates, nearest landmark, P(person), urgency, time, and the Grok text.
- Any digits in the Grok text are stripped and flagged.
- On timeout, fall back to the template brief.

**Tests:** numbers come only from code; injected digits are stripped; a timeout produces the template.

**Prompt:**

```
T5.2 (README §1 rule 3). Implement grok/briefs.py and wire it into dispatch per T5.2.
```

#### T5.3: Ask Ground Control

**Build:** `grok/tools.py` with 4 read-only tools:

| Tool | Returns |
| --- | --- |
| `get_mission_status()` | time, coverage %, drone position, lead counts by status |
| `list_leads(status?, sector?, limit=10)` | id, sector, nearest landmark, action, status, P(person), urgency |
| `get_incident_picture()` | the current picture |
| `get_decision_stats()` | Mongo aggregation for this run: counts by action and source, fallback rate, routed rate, re-decision count, Laya latency p50/p95 |

`grok/ask.py` runs `chat_with_tools` for at most `ASK_MAX_TOOL_ROUNDS` rounds, with a timeout. The system prompt tells Grok to:

- answer only from tool results
- cite lead ids
- say when data is missing
- never claim an action was taken

`POST /api/ask` exposes it, and every exchange is logged to `qa`.

**UI:** a chat panel with a collapsible tool trace per answer. Clicking a lead id highlights that lead.

**Tests** (mocked Grok):

- the trace is recorded
- the round cap holds
- tools don't mutate state (snapshot hash is unchanged)
- when Atlas is down, `get_decision_stats` returns "unavailable" instead of crashing

**Prompt:**

```
T5.3 (README §1 rules 2–3, T5.3 table). Implement grok/tools.py, grok/ask.py,
POST /api/ask, qa logging, and the chat panel per T5.3 with tests.
```

**GATE T5:** in a live run with Grok parsing:

- parsed chips appear
- intel re-ranks the queue
- Grok briefs appear
- "what's unresolved in S3?" is answered with a tool trace

### T6: Evaluation

#### T6.1: Batch run and metrics

**Build:**

- `batch/run_eval.py`: runs `MissionRun` in fast mode for seeds 0–19 with `sim_human=True` and `parse_mode="oracle"` (no Grok calls), for two arms: `policy ∈ {laya, rule}`. Writes `results/raw.parquet` and Mongo.
- `batch/metrics.py` computes the following.

**Zero point:** for each subject, `t0` is the time of the first capture whose footprint contains it. All times below are measured from `t0`.

**Manual reviewer baseline:**

- Reviewer finish time for capture i is `f_i = max(t_i, f_{i−1}) + REVIEW_S`, for `REVIEW_S` ∈ {120, 10}.
- The reviewer finds a `visible` or `partial` subject with P = 1 at its first containing capture, so `T_human = f_i − t0 + HANDOFF_S`.
- P = 1 is deliberately generous to the human.

**FlyBy:** `T = t_dispatch − t0 + HANDOFF_S`.

**Primary comparison:** only `visible` and `partial` subjects, since overhead review can't see the others. Report `under_structure` subjects separately, as found only through inspection.

**Also report:**

- median and IQR per arm
- subjects found / placed
- action accuracy
- dispatch precision and recall
- routing rate
- re-decision count
- Laya reliability diagram and ECE vs. detector confidence

**Declared assumptions (print them in the output JSON):** the noise model, `SIM_HUMAN_ACC`, human P = 1, `HANDOFF_S`, and oracle intel.

**Tests:** a hand-computed 3-capture baseline; ECE on a toy input; a one-seed run with a fake runtime.

**Prompt:**

```
T6.1 (README T6.1 definitions). Implement batch/run_eval.py and batch/metrics.py with
the listed tests; document the results JSON schema at the top of metrics.py.
```

#### T6.2: Results tab

**Build:** a Results tab reading `/api/results/*` that shows:

- time-to-dispatch vs. manual review at 120 s and 10 s
- the reliability diagram with ECE
- the declared assumptions

No numbers are hardcoded.

**Prompt:**

```
T6.2. Build the Results tab per T6.2 from results JSON only.
```

### T7: Demo

**Build:**

- **Demo button:** loads a fixed seed that meets all of these:
  - at least one lead routes to a human
  - an intel message re-ranks the queue in the first 2 sim-minutes
  - at least 3 dispatches happen

  `tools/demo_check.py --find-seed` scans for such a seed using oracle intel.
- **`tools/demo_check.py`:** verifies Laya loads, Grok parses, Atlas or JSONL works, and the results files exist.
- **Offline test** (Wi-Fi off):
  - decisions keep flowing
  - briefs fall back to templates
  - the intel feed shows "parse unavailable"
  - Ask shows "offline"
  - writes go to JSONL

**HUMAN:** freeze the constants, record a backup video, and submit to Devpost first, then to expo.hexlabs.org with the Devpost link.

**Prompt:**

```
T7. Implement the Demo preset and tools/demo_check.py per T7, then verify offline
behavior with Grok and Atlas unreachable; fix anything that blocks or crashes.
```

---

## 6. Run

```
uv sync && (cd web && npm install)
cp .env.example .env                       # add XAI_API_KEY, and MONGODB_URI if you have one
uv run python -m tools.setup_laya          # once: downloads the local checkpoint
```

**Demo (one process).** The server also serves the built UI, so a demo needs one port:

```
(cd web && npm run build)
uv run uvicorn server.app:app --port 8000  # open http://127.0.0.1:8000
```

**Development (two processes).** Vite proxies `/api` and `/ws` to the server:

```
uv run uvicorn server.app:app --port 8000
cd web && npm run dev                      # open http://127.0.0.1:5173
```

**Checks.**

```
uv run pytest -m "not slow and not network"   # full suite, no model and no network
uv run python -m tools.demo_check             # Laya, Grok, persistence, results, demo seed
uv run python -m tools.demo_check --find-seed # rescan seeds if constants change
uv run python -m batch.run_eval               # seeds 0-19, both arms -> results/summary.json
uv run python -m tools.laya_check             # accuracy, calibration, TAU_ROUTE sweep
uv run python -m tools.grok_smoke             # live xAI parse + tool round trip
uv run python -m tools.atlas_smoke            # write-behind proof; reports Atlas or JSONL
```

Gate outcomes and the frozen constants they justify are recorded in [docs/GATES.md](docs/GATES.md).
The live policy is Laya (rule is the fallback and the baseline arm); see docs/GATES.md.

## 7. Demo (\~1:15)

1. Click **Demo** (seed 7). Leads fill the queue with an action, a 4-way probability bar, urgency, and P(person).
2. An intel message arrives at about t+99 s. Grok's chips appear, the map updates, and pending leads in that sector are re-decided and re-ranked with a **re-ranked** marker.
3. A pass-2 lead shows **needs human**. Approve or override a dispatch: the brief modal opens and a pin drops on the map.
4. Ask: "What's still unresolved near Elm?" The answer shows its tool trace; lead ids in the answer are clickable.
5. Results tab: time-to-dispatch vs manual review at 120 s and 10 s, the reliability diagram with ECE, and the declared assumptions.
5. Results: time-to-dispatch vs. manual review, and the calibration plot, with assumptions shown.