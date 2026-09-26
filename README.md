# FlyBy

Local repository for our hackathon project. **Steps 0.1, 0.4 and 6.1 are implemented:
the fly-eye smoke test passes and the reflex frame socket works. The live reflex and mission pipeline are pending.**

- **[Start here: fly-connectome agent handoff](docs/fly-connectome/README.md)**
- [Build status and next checkpoint](docs/fly-connectome/STATUS.md)
- [Team split and integration agreement](docs/TEAM.md)
- [Local setup](docs/SETUP.md)

The original supplied build specification follows below. Its Run section is
the target workflow; use docs/SETUP.md for commands supported by this scaffold.

---
FlyBy
Drone search-and-rescue triage with a fly-brain reflex you can watch think.

HackGT 13 · Georgia Tech · Sept 25–27, 2026. Everything must be submitted by Sunday 8:00 AM to both Devpost and expo.hexlabs.org.

Scope target: about 10 hours of agent build time. Anything not listed in this file is out of scope.

Abstract
FlyBy is a ground-control system for search-and-rescue drones, built around two features.

1. Triage.

A simulated drone sweeps a flooded neighborhood, and a detector flags possible people.
For each lead, Laya (a local decision model) returns three things with calibrated probabilities:
an action
an urgency
P(person)
Laya reads the lead together with a live incident picture. Grok keeps that picture current from messy radio and text messages.
A human approves every dispatch. Grok writes the crew brief, and the commander can ask ground control questions in plain English.
2. A fly-brain reflex, fully visualized.

When the drone flies in close to inspect a collapsed structure, obstacle avoidance runs on a connectome-constrained model of the fruit-fly visual system (flyvis). Its motion cells detect a looming object and brake or swerve the drone on their own.
The data-visualization centerpiece shows that process live, in four views:
the fly's photoreceptors
its motion-detecting neurons
the looming signal
activity flowing through the visual circuit, projected onto real fly neurons in 3D
Two numbers back the demo:

time-to-dispatch vs. manual footage review
the reflex's warning time and collisions, with the reflex on vs. off
Features (in scope)
Mission sim. A seeded flooded block with sectors, landmarks, people, and decoys. A lawnmower sweep, a detector noise model, and ground-truth labels. The mission runs headless in Python and renders in Three.js.
Laya triage. One local call per lead: action (dispatch_ground_team, reimage_zoom, close_in_inspect, ignore), urgency, and P(person). Low-confidence leads go to a human, and a rule-based fallback covers errors.
Grok incident picture. Grok parses intel messages into a strict schema, and code merges the results into the picture that feeds Laya.
Grok briefs. Written when a dispatch is approved. Code inserts every number.
Ask Ground Control. A Grok chat with 4 read-only tools, with every tool call shown on screen.
Ground control UI. A 3D view, a 2D map, a ranked lead queue with approve and override, an intel feed with Grok's parsed chips, a decision log, and the chat.
Fly reflex. A separate "onboard" process: 50 Hz camera frames go into the flyvis fly eye, T4/T5 motion cells feed a looming score, and the output is brake or swerve.
Fly data visualization.
Eye view of the 721 hexagonal columns, with three layers: Receptors (photoreceptors), Motion (T4/T5 direction cells), and Looming.
Circuit view: the fly's visual pathway as a live graph, from receptors through the motion cells, the looming score, and the brake decision.
3D connectome view: the same activity lighting up matching real neurons from the fly connectome, via the vendored fly-brain viewer.
A live looming trace with the brake threshold.
Results tab.
Time-to-dispatch vs. manual review.
A Laya calibration plot.
Reflex warning time.
Collisions with the reflex on vs. off.
MongoDB Atlas logging (runs, leads, intel, incident picture, chat), with a local-file fallback.
Out of scope (do not build):

optical flow
policy comparisons beyond Laya vs. the rule
intel-reliability sweeps
Grok parse-accuracy evals
a YOLO panel
low-light benchmark conditions
extra Grok tools
real hardware
autonomous navigation
multi-drone support
Tech stack
The Status column records when each piece was confirmed:

ctx: confirmed in our research
smoke: confirmed by that step's smoke test before anything depends on it
Piece	Use	Status
Python 3.12 + uv, FastAPI, uvicorn, WebSockets	Mission server :8000, reflex server :8001	ctx
Laya (Convai Innovations, Apache-2.0, ~421M params)	Typed decisions (choice / score / noul) with calibrated probabilities in one forward pass; Jev-compatible system_one shape	ctx: API shape; ~1.7 GB weights, ~2 GB RAM; ~140 ms per 3-question call on an Apple-silicon CPU (Node/ONNX port); 512-token state cap. smoke (0.2): Python runtime path and latency
Grok via xai-sdk	Intel parsing (Pydantic structured outputs), briefs, Ask Ground Control (function calling)	ctx: structured outputs and tools supported. smoke (0.3): model id, credit code SPACEXAI_HACK_GT_20260925
flyvis (Lappalainen et al., Nature 2024, MIT) + PyTorch	Fly eye: 45,669 cells, 65 cell types, 721-column hex eye, dt = 1/50 s, photoreceptors R1–R8, T4a–d/T5a–d motion cells	ctx: pip install flyvis, pretrained flow/0000/000. smoke (0.4): frame size, T4/T5 directions, ms/frame
fly-brain (github.com/Lulzx/fly-brain, MIT; male CNS v1.0 data CC-BY 4.0)	3D connectome view: Three.js neuron skeletons plus a precomputed flyvis-node → real-neuron map	ctx: data committed in public/ (skeletons.flys 11.6 MB, neurons.flyn 1 MB, vision/flyvis_map.json 1 MB with 30,946 left-eye [neuron_idx, flyvis_node_idx] pairs, vision/flyvis.bin with per-node type/u/v); activity drawn from a per-neuron texture. smoke (7.4): node order matches ours
MongoDB Atlas + PyMongo (async)	Persistence and chat stats	smoke (0.5): reachable from venue Wi-Fi
Vite + TypeScript (vanilla), three, chart.js	UI and visualizations	ctx
numpy, pandas, matplotlib, pytest	Metrics and tests	ctx
Hardware: one Apple-silicon Mac with 16 GB+ RAM runs everything. Builders: AI coding agents, one step at a time, using the prompts below. Humans do the steps marked HUMAN.

1. Architecture
┌──────────────────────────────── BROWSER (web/) ────────────────────────────────┐
│ 3D scene · 2D map · lead queue · intel feed · decision log · Ask chat · results │
│ Inspect mode: drone camera → grayscale frames @ 50 Hz ─────────────┐            │
│ Fly viz: eye view · circuit view · 3D connectome · looming trace ◀─┤ (viz 10 Hz)│
└──────────┬──────────────────────────┬──────────────────────────────┼───────────┘
           │ ws :8000/ws/mission      │ http :8000/api/*             │ ws :8001/ws/reflex
┌──────────▼──────────────────────────▼───────────────┐   ┌──────────▼───────────────────┐
│ GROUND STATION  server/                             │   │ "ONBOARD"  reflex/           │
│ Mission loop (sim clock): scenario, sweep, noise    │   │ Separate process.            │
│ Incident picture — in memory (live copy)            │   │ Imports nothing from server/ │
│   ▲ Grok intel parse (async) + deterministic merge  │   │ No DB. No outbound network.  │
│ State builder → decide(): Laya → rule on error      │   │ flyvis eye → looming readout │
│ Lead lifecycle · approvals · Grok briefs            │   │ → brake / swerve             │
│ Ask Ground Control: Grok + 4 read-only tools        │   │ Streams viz vector to UI     │
│ Mongo writer (async queue → Atlas, JSONL on fail)   │   └──────────────────────────────┘
└─────────────────────────────────────────────────────┘
Hard rules
Reflex isolation. reflex/ never imports server/, never opens a DB, and never makes outbound network calls. A test enforces this.
Fast decision path. The path from lead to decision never waits on Grok, never reads Mongo, and never calls the network. It reads the incident picture from memory only.
Mongo is write-behind. Writes go through a queue and nothing waits on them. The only read is the get_decision_stats chat tool, which is off the decision path.
Grok never decides. Grok proposes schema-checked updates that code merges. It writes brief text, but code inserts every number. Its chat tools are read-only.
One config. Every constant lives in server/config.py or reflex/config.py.
Deterministic. The same (seed, config) produces the same run, apart from latency values (and any timeouts they cause).
Lead lifecycle
captured → decided ─┬─ auto (max prob ≥ TAU_ROUTE):
                    │    ignore            → ignored
                    │    reimage_zoom      → reimaging → new capture (pass+1) → decided …
                    │    dispatch / inspect → awaiting_approval
                    └─ routed (max prob < TAU_ROUTE, or fallback) → awaiting_human
awaiting_* ──approve / override──▶ dispatched | reimaging | inspecting | ignored
inspecting ──(demo lead: live fly-reflex scene; others: timer)──▶ resolved
Dispatch and close-in inspection always need a human click.

Repo layout
flyby/
  AGENTS.md  README.md  .env.example  pyproject.toml
  server/
    config.py  app.py  protocol.py
    mission/   clock.py scenario.py sweep.py noise.py truth.py intel_script.py loop.py
    incident/  schemas.py store.py merge.py
    triage/    state.py laya_runtime.py fallback.py decide.py
    grok/      client.py parse.py briefs.py templates.py tools.py ask.py
    store/     writer.py
  reflex/      config.py server.py frames.py hexeye.py looming.py controller.py viz.py
  web/
    index.html  bench.html
    src/  main.ts ws.ts store.ts
          scene/  (world, map, inspect)
          ui/     (queue, intel, log, ask, results)
          flyviz/ (eye, circuit, connectome3d, trace)
    vendor/fly-brain/  (vendored loaders + LICENSE + ATTRIBUTION.md)
    public/fly-brain/  (skeletons.flys, neurons.flyn, flyvis_map.json, flyvis.bin)
  batch/       run_tier1.py metrics_tier1.py
  bench/       eval_reflex.py
  tools/       laya_smoke.py grok_smoke.py flyvis_smoke.py atlas_smoke.py laya_check.py demo_check.py
  data/        gazetteer.json intel_templates.json flyvis_layout.json
  results/     logs/     tests/
2. AGENTS.md (paste at the start of every agent session)
You are implementing FlyBy, a hackathon SAR drone triage system with a fly-brain
reflex and fly-brain data visualization. README.md is the source of truth; read the
sections referenced in each task before writing anything.

Rules:
- Implement ONLY the current step. No extra features, options, or abstractions.
  If something is not in README, it is out of scope.
- Follow README §1 hard rules (reflex isolation; decision path never waits on Grok,
  Mongo, or network; Mongo is write-behind; Grok never decides and never writes
  numbers into briefs; all constants in config.py).
- Python 3.12 with uv. Add only dependencies the step names.
- Never invent API details for Laya, xai-sdk, flyvis, or fly-brain. Read installed
  package source / repo files to confirm signatures and formats first.
- Finish with the step's tests passing (`uv run pytest <paths>`) or its acceptance
  check shown. Show commands and output.
- If README conflicts with how a library actually works, implement the closest
  faithful version and list it under "Deviations".
- Final report: files changed, commands + output, deviations, open issues. Short.
3. Constants
These are the initial values. Freeze them in Step 9.1.

Name	Value	Meaning
AREA_M	300	Square area (m), origin at SW corner
SECTOR_GRID	3	Sectors S1–S9, S1 = SW, row-major west→east, south→north
ALT_M / FOV_DEG	40 / 60	Footprint = 2·40·tan 30° ≈ 46.2 m
LANE_SPACING_M / CAPTURE_SPACING_M	40 / 40	8 lanes, ~64 captures per sweep
SWEEP_SPEED_MPS	8	Sweep takes ~5.5 min of sim time
LIVE_TIME_SCALE	4.0	Live sim speed-up
N_SUBJECTS / N_DECOYS	5–8 / 10–15	Per run
NOISE	Step 1.2 table	Detection probability and confidence
SMALL_BOX_PX	20	Below this, a subject should be re-imaged
OBJECT_SIZE_M	subject 1.7, person_shaped_junk 1.5, animal 0.8, warm_spot 1.0, debris 2.0	Used for box_px
T_REIMAGE_S / REIMAGE_BOX_MULT / REIMAGE_CONF_SHIFT	60 / 3.0 / +0.20 subjects, −0.10 decoys	Zoom recapture
T_INSPECT_S	90	Timer for non-demo inspections
TAU_ROUTE	0.60	Below this, route to a human (set in Step 2.3)
LAYA_TIMEOUT_MS	500	Reset to ≈3× measured p95
RHO	0.9	Share of intel messages pointing at a real subject
INTEL_COUNT	12–15	Messages per run
GROK_PARSE_TIMEOUT_S / GROK_BRIEF_TIMEOUT_S / GROK_ASK_TIMEOUT_S	10 / 8 / 20
ASK_MAX_TOOL_ROUNDS	4
SIM_HUMAN_ROUTED_S / SIM_HUMAN_APPROVE_S / HANDOFF_S	20 / 5 / 60	Batch simulated human and crew handoff
REVIEW_S	120 and 10	Manual reviewer seconds per image (standard, generous)
reflex/config.py
FRAME_HZ	50	dt = 0.02 s
FRAME_R	Step 0.4	Square grayscale frame size
SUBTYPE_DIR	Step 0.4	Measured T4/T5 a/b/c/d → left/right/up/down
DRONE_RADIUS_M / INSPECT_SPEED_MPS	0.25 / 1–3
A_BRAKE_MPS2 / SWERVE_MPS / BRAKE_LATCH_S	4.0 / 1.0 / 0.5	Stop time at 3 m/s = 0.75 s
EMA_ALPHA / WARMUP_S	0.3 / 0.5
THETA	bench/thresholds.json	Brake threshold (Step 8.2)
VIZ_HZ	10	Viz stream rate (live only)
4. Data contracts
4.1 Laya state
{
  "lead": {"detector_conf": 0.62, "detector_band": "medium", "box_px": 34, "size_band": "medium",
           "altitude_m": 40, "sector": "S3", "near_structure": true, "passes": 1},
  "context": {"dist_to_last_known_point_m": 55, "near_last_known_point": true,
              "sector_priority": "critical", "hazards_nearby": ["downed_line"],
              "reported_subjects_in_sector": 3, "confirmed_subjects_in_sector": 1},
  "mission": {"coverage_pct": 42, "open_leads": 5}
}
Bands:

detector_band: low < 0.45 ≤ medium < 0.75 ≤ high
size_band: small < 20 px ≤ medium < 60 px ≤ large
near_last_known_point: < 100 m
Omit unknown fields; never send null. Every context field comes from the incident picture, except confirmed_subjects_in_sector, which is the count of dispatched leads in that sector (mission state).

4.2 Laya questions (one call)
Key	Type	Instructions	Criteria
action	choice	"What should incident command do with this drone lead?"	dispatch_ground_team: "likely a real person who is clearly visible and reachable; send a crew"
reimage_zoom: "possibly a person but the image is small or partly hidden; take another zoomed pass"
close_in_inspect: "possibly a person inside or under a structure the overhead camera cannot see into"
ignore: "likely debris, an animal, a warm spot, or a false alarm"
urgency	score	"How urgent is this lead?"	["low","moderate","high","critical"] → 0–3
is_person	noul	"Is this lead a real person?"	none
4.3 Decision
Decision { action, probs{4}, urgency|None, p_person|None, latency_ms, used_fallback, routed_to_human, source: "laya"|"rule" }

decide(state, *, policy="laya"|"rule") -> Decision (async)

4.4 Grok schemas
Enums:

Sector: S1–S9
Landmark: the keys of data/gazetteer.json
Urgency: low | moderate | high | critical
Hazard: downed_line | rising_water | collapse_risk | fire | gas
Report:

sector?
landmark?
subject_count? (0–20)
urgency
hazards[]
source (firsthand | secondhand | unverified)
is_retraction
IntelParse: { reports[], unparseable }

BriefText:

headline (≤ 80 chars)
what_drone_saw (≤ 240)
access_notes (≤ 240)
confidence_statement (≤ 160)
4.5 Incident picture (in memory; mirrored to Mongo)
{ run_id, reports[], sector_priority{S→urgency}, reported_subjects{S→int}, hazards[{type,x,y}], last_known_point{landmark,x,y,t}|null }

Merge rules:

A sector's priority is the highest urgency among its non-retracted reports. A report that names only a landmark counts toward that landmark's sector.
Reported subjects per sector is the maximum subject_count among those reports.
Hazards are the union of all reported hazards, placed at the landmark or at the sector's center.
The last-known point comes from the most recent firsthand report; if there is none, from the most recent report that names a landmark.
A retraction removes the most recent earlier report that matches its sector or landmark.
4.6 Mongo collections (all carry run_id)
Collection	Contents
runs	seed, kind (live/batch), policy, config, started_at
leads	t_capture, pos, sector, pass, truth{is_subject, visibility, optimal_action}, state, decision, baseline_rule, status history, human{verdict, final_action, t}, dispatch{t, brief}
intel	t, raw, oracle_parse (from template), grok_parse, latency, ok
incidents	latest picture (upsert by run_id)
qa	question, tool_calls[{name, args}], answer, latency
4.7 Protocol
Mission WebSocket /ws/mission, server → web:

Message	Payload
mission.snapshot	Full scene for rendering
mission.state	{t, drone, coverage_pct, coverage_cells}, 10 Hz
lead.new	{lead_id, x, y, sector, pass}
lead.decided	{lead_id, decision, status}
lead.status	{lead_id, status}
intel.new	{intel_id, t, raw}
intel.parsed	{intel_id, parse, ok}
incident.update	Latest picture
dispatch.created	{lead_id, brief, pin}
inspect.request	{lead_id}
Mission WebSocket, web → server:

Message	Payload
mission.control	{cmd, seed?} where cmd is start, pause, or reset
lead.approve	{lead_id}
lead.override	{lead_id, action}
inspect.result	{lead_id, collided}
HTTP:

POST /api/ask {question} → {answer, tool_calls[]}
GET /api/results/{name} → files in results/
Reflex WebSocket /ws/reflex:

web → reflex, binary frame:
header: episode u32, k u32, reflex_on u8, mode u8 {0 live, 1 bench_record, 2 bench_closed}, pad u16
body: FRAME_R² grayscale bytes
reflex → web, JSON command: {k, cmd: none|brake|brake_swerve_left|brake_swerve_right, S, dLR, ms}
reflex → web, eye.layout JSON: sent once on connect. It is the content of data/flyvis_layout.json:
types[65]
node_type[N], u[N], v[N], node_col[N] (N = 45,669)
col_u[721], col_v[721], col_x[721], col_y[721]
receptor_types
t4t5_types
subtype_dir
type_edges[{src, dst, weight, sign}]
S_theta
reflex → web, viz binary: live mode only, at VIZ_HZ.
header: exactly 16 bytes, little-endian: k u32, S f32, dLR f32, cmd u8, pad 3 bytes
body at byte offset 16: N × float16 (little-endian) deviation from rest for every flyvis node, which is activity minus the node's mean over the last 0.2 s of gray warm-up (≈ 91 KB). The browser decodes it with a Uint16Array view and a manual half-to-float conversion; do not rely on Float16Array.
The browser derives every visualization from this one vector plus the layout.
web → reflex, JSON episode.begin {episode, params} / episode.end {episode, result} bracket every bench episode. In bench_closed mode the reflex appends each episode.end result to bench/closed_loop.jsonl (a local file; still no DB).
4.8 Looming readout (reflex, fly-only)
Regional energies. Take rectified (relu) T4 + T5 activity for the named subtype, averaged over that region's columns. Regions use each column's image position: L = col_x < 0, R = col_x > 0, U = col_y > 0, D = col_y < 0 (never raw u/v). "Preferring left" etc. refers to the image-direction mapping measured in Step 0.4.

Region	Outward	Inward
L	subtype preferring left	preferring right
R	preferring right	preferring left
U	preferring up	preferring down
D	preferring down	preferring up
Scores:

q_i = outward_i − inward_i
S   = EMA_α(Σ q_i)          looming score
dLR = EMA_α(q_L − q_R)      > 0 means more looming on the left → swerve right
Controller:

If S > θ, brake (latched for at least BRAKE_LATCH_S).
If additionally |dLR| > 0.5·θ, swerve away from the side with more looming.
5. Build plan (~10 agent-hours)
Each step has Context, Build, Tests/Acceptance, and a Prompt. Steps build on earlier ones.

Parallel lanes (run separate agent sessions once their inputs exist):

Lane	Phases	Can start after
A: ground station	1 → 2 → 3 → 5	Phase 0
B: web	4	Step 3.1 exists
C: fly	6 → 7	Phase 0 and Step 4.2's scene module
Phase	Budget
0 Setup + smoke tests	0.75 h
1 Mission core	0.75 h
2 Decisions	0.75 h
3 Live server	0.75 h
4 Ground control UI	1.25 h
5 Grok system	1.25 h
6 Fly reflex	1.5 h
7 Fly data visualization	1.5 h
8 Numbers	0.75 h
9 Demo + submit	0.5 h
If behind, cut in this order:

7.4 (3D connectome)
The closed-loop half of 8.2
Swerve (keep brake only)
5.2 Grok briefs (keep templates)
Never cut:

the triage loop
Ask Ground Control
the fly reflex brake
the eye and circuit views
the time-to-dispatch number
Phase 0: Setup and smoke tests
Step 0.1: Scaffold and config
Build:

The repo layout from §1, and AGENTS.md from §2.
pyproject.toml with: fastapi, uvicorn[standard], pydantic, pydantic-settings, numpy, pandas, pyarrow, matplotlib, pymongo, python-dotenv, httpx, pytest, pytest-asyncio. Register the pytest markers slow and network in [tool.pytest.ini_options].
server/config.py and reflex/config.py with the §3 constants. Secrets (XAI_API_KEY, XAI_MODEL, MONGODB_URI) come from .env.
A set_threads(n) helper called by each process (server 4, reflex 4).
web/ created with Vite vanilla-ts plus three and chart.js.
Tests: tests/test_config.py imports both configs. npm run dev serves a page.

Prompt:

Step 0.1 (README §1 repo layout, §2, §3). Scaffold the repo exactly per the layout,
create AGENTS.md from §2, pyproject.toml (uv, Python 3.12) with only the listed deps and
the `slow`/`network` pytest markers registered,
server/config.py and reflex/config.py with every §3 constant (secrets from .env),
.env.example, set_threads(n) helper, and web/ via Vite vanilla-ts with three and
chart.js. Add tests/test_config.py. Acceptance: `uv run pytest` passes and
`cd web && npm run dev` serves.
Step 0.2: Laya smoke
Context. Laya is the decision engine, so confirm it runs from Python on this Mac before anything depends on it. There are two paths:

(a) the Hugging Face reference convaiinnovations/laya (rl_agent_api.py, RLAgent.system_one) on PyTorch, CPU or MPS
(b) onnxruntime on the published ONNX bundle
Use whichever works first.

Build:

server/triage/laya_runtime.py: LayaRuntime.load() and system_one(state, questions), returning {answers: {key: {choice, probabilities} | {score} | {noul}}, latency_ms}.
tools/laya_smoke.py: 3 states from §4.1, the §4.2 questions, 50 warm calls, and a p50/p95 printout.
Tests: tests/triage/test_laya_runtime.py (marked slow) checks:

the keys match the questions
the action probabilities sum to 1 (±1e-3)
the score is between 0 and 3
noul is between 0 and 1
HUMAN: record the runtime and p95, and set LAYA_TIMEOUT_MS ≈ 3× p95.

Prompt:

Step 0.2 (README Tech stack Laya row, §4.1, §4.2). Download and read rl_agent_api.py,
rl_common.py, rl_agent_config.json from Hugging Face convaiinnovations/laya to learn
the real RLAgent.system_one signature and output. Implement server/triage/
laya_runtime.py (LayaRuntime.load(device), system_one(state, questions) → normalized
dict per Step 0.2). If the PyTorch path fails on this Mac, use onnxruntime with the
published ONNX bundle behind the same interface. Write tools/laya_smoke.py and the
slow test. Quote the real signature in your report; report device and p50/p95.
Step 0.3: Grok smoke
Build:

server/grok/client.py (async):
parse(system, user, schema, timeout) returns a Pydantic instance.
chat_with_tools(messages, tools, tool_impls, max_rounds, timeout) returns (answer, tool_trace).
The model name comes from XAI_MODEL.
tools/grok_smoke.py: one parse and one tool round trip, with latency.
Tests: tests/grok/test_client.py (marked network).

HUMAN: pick a fast model id in the SpaceXAI Console.

Prompt:

Step 0.3 (README §1 rule 4). Add xai-sdk. Read the installed xai_sdk source to confirm
structured outputs with Pydantic and client-side function calling. Implement
server/grok/client.py per Step 0.3 and tools/grok_smoke.py. Network-marked tests.
Report the exact SDK calls used and latencies.
Step 0.4: flyvis smoke + layout export
Context. This step fixes the frame size, measures which way each T4/T5 subtype points, and exports the layout that every fly visualization is built from.

Build: tools/flyvis_smoke.py:

Load the pretrained flow/0000/000. Find how frames map onto the 721-hexal eye (BoxEye or equivalent) and which frame sizes it accepts. Pick FRAME_R (target ~96).
Show 0.5 s of gray, then 1 s of drifting gratings in each of 4 image directions. Print each T4a–d/T5a–d subtype's mean rectified response per direction and its preferred direction, in image terms (left/right/up/down as seen in the camera frame).
Orientation check: show a bright spot in the image's top-right quadrant. The R1–R6 columns that respond most must have col_x > 0 and col_y > 0. If not, fix col_x/col_y (flip or rotate) before exporting.
Time ms per step.
Export data/flyvis_layout.json:
types (65)
per node: node_type, u, v, and node_col (index of the node's eye column, 0–720), in flyvis's native node order
per column (721): col_u, col_v, and col_x, col_y: the column's position in the camera image (normalized to [−1, 1], x right, y up), taken from the same sampling that maps frames onto the eye. This is the only mapping between eye columns and the image; every region split and every eye drawing uses it.
receptor_types (R1–R8)
t4t5_types
subtype_dir
type_edges (summed synapse weight and sign between cell types, from the flyvis connectome)
HUMAN: copy FRAME_R and SUBTYPE_DIR into reflex/config.py.

Prompt:

Step 0.4 (README Tech stack flyvis row, §4.7 eye.layout). Install flyvis. Read its
source/docs to learn: loading "flow/0000/000", rendering a cartesian frame onto the
721-hexal input, accepted sizes, stepping at dt=1/50 s with persistent state, reading
activity for all 45,669 nodes and for T4a-d/T5a-d, and reading node types, (u,v)
coordinates, and edges with signs. Find the image-plane position the frame sampler
uses for each of the 721 columns and export it as col_x/col_y (normalized, x right,
y up). Write tools/flyvis_smoke.py per Step 0.4 including the grating direction test
in image terms (measure; do not assume the mapping), the top-right spot orientation
check, ms/step, and export data/flyvis_layout.json in flyvis's native node order.
Report FRAME_R, the direction table, the orientation check result, ms/step.
Step 0.5: Mongo writer
Build:

server/store/writer.py:
start(), put(collection, doc) (non-blocking), put_many, and stop() (drains the queue).
One background task inserts or upserts documents through PyMongo's async client. incidents are upserted by run_id.
Any failure appends to logs/<collection>.jsonl.
tools/atlas_smoke.py.
Tests:

With a bad URI, put returns in under 5 ms and documents land in JSONL.
With a real URI (marked network), documents land in Atlas.
Prompt:

Step 0.5 (README §1 rule 3, §4.6). Implement server/store/writer.py and
tools/atlas_smoke.py per Step 0.5 using PyMongo's async client (confirm the API in the
installed version). put() never awaits I/O. Tests per Step 0.5.
GATE 0: Laya answers and its p95 is measured. Grok parses and calls tools. flyvis_layout.json exists and the T4/T5 directions are measured. The writer works.

Phase 1: Mission core (headless Python)
Step 1.1: Clock and scenario
Build:

mission/clock.py: SimClock with a scaled real-time mode and a fast mode, plus call_at(t, fn) and now().

data/gazetteer.json: 10–12 landmarks across all sectors, including carport_lot.

mission/scenario.py: generate(seed, cfg) produces:

houses, water, trees, and the carport zone
subjects {id, x, y, visibility: visible|partial|under_structure}
decoys {id, x, y, type: person_shaped_junk|animal|warm_spot|debris}
sector_of(x, y) and snapshot()
Seeds where a subject sits under the carport must exist (at least 50% of seeds).

Tests:

same seed → same scenario
counts within the configured ranges
everything inside the area
sector convention correct
the snapshot converts to JSON
Prompt:

Step 1.1 (README §3, Step 1.1). Implement mission/clock.py, data/gazetteer.json,
mission/scenario.py per Step 1.1 with numpy Generator seeded randomness. Tests in
tests/mission/test_scenario.py.
Step 1.2: Sweep, detector noise, truth
Build:

mission/sweep.py:
the lawnmower path (8 lanes, 40 m apart, 40 m altitude)
position_at(t) at 8 m/s
captures() every 40 m along-track, each with its footprint
coverage(t) on a 5 m grid
mission/noise.py:
detect(capture) samples each object inside the footprint from the table below.
Confidence is clip(N(μ, 0.15), 0, 1).
box_px = size_m / footprint_m × 640, with sizes from config OBJECT_SIZE_M: subject 1.7 (≈ 23.6 px at 40 m), person_shaped_junk 1.5, animal 0.8, warm_spot 1.0, debris 2.0.
near_structure comes from the scenario.
Captures overlap (46.2 m footprint, 40 m spacing), so an object missed in one capture gets an independent detection draw in each later capture that contains it. Each object produces at most one lead per pass: once detected, later captures in the same pass skip it.
recapture() applies the reimage constants.
mission/truth.py: optimal_action maps each lead to what should happen:
decoy → ignore
under_structure → close_in_inspect
partial or box_px < 20 → reimage_zoom
everything else → dispatch_ground_team
Truth	P(detect)	μ conf
subject visible / partial / under_structure	0.90 / 0.60 / 0.30	0.75 / 0.55 / 0.40
decoy person_shaped_junk / animal / warm_spot / debris	0.50 / 0.40 / 0.30 / 0.15	0.45
Tests:

footprint ≈ 46.19 m
60–70 captures
sweep duration 300–360 s
final coverage ≥ 99%
per-capture detection rates within ±0.03 of the table over 2,000 draws
no object yields two leads in one pass
every optimal_action branch covered
Prompt:

Step 1.2 (README §3, Step 1.2 table). Implement mission/sweep.py, mission/noise.py,
mission/truth.py per Step 1.2 using config constants only. Tests per Step 1.2.
Step 1.3: Intel script
Context. Intel messages are what Grok structures. Every message also carries an oracle parse built from its template. That lets the pipeline run before Grok is wired in, and batch runs use it so they spend no Grok credit.

Build:

incident/schemas.py: the §4.4 models.
data/intel_templates.json: about 15 messy radio/text templates with slots and metadata, including 1 retraction and 1 vague message.
mission/intel_script.py: generate(scenario, rng) produces INTEL_COUNT messages spread across the sweep. A share RHO of them target a real subject's landmark or sector. Each message has oracle_parse.
Tests: deterministic per seed; every oracle_parse validates.

Prompt:

Step 1.3 (README §4.4, Step 1.3). Implement incident/schemas.py, data/
intel_templates.json (realistic, messy incident-command style), and
mission/intel_script.py per Step 1.3. Tests per Step 1.3.
Phase 2: Decisions
Step 2.1: Incident picture
Build:

incident/merge.py: apply(picture, parse, intel_id, t, gazetteer), a pure function following the §4.5 rules.
incident/store.py: IncidentStore with snapshot() (an immutable copy), apply(), and an on_update hook.
Tests:

priority is the maximum urgency
a retraction removes the right report
a firsthand report takes priority over a newer secondhand one for the last-known point
a landmark-only report maps to its sector
a snapshot doesn't change when the store changes later
Prompt:

Step 2.1 (README §4.5). Implement incident/merge.py and incident/store.py per Step
2.1. Tests per Step 2.1.
Step 2.2: State, fallback rule, decide()
Build:

triage/state.py: build_state(detection, pass_n, incident_snapshot, mission_status) returns the §4.1 JSON, with fixed key order and no nulls. hazards_nearby means within 50 m.
triage/fallback.py: rule(state):
confidence ≥ 0.75 → dispatch
confidence ≥ 0.45 → close_in_inspect if near_structure, otherwise reimage_zoom
anything lower → ignore
probabilities are one-hot, with source rule
triage/decide.py:
QUESTIONS from §4.2.
decide(state, policy): Laya runs in a single-worker thread pool. Leads are decided one at a time, in arrival order, and the LAYA_TIMEOUT_MS clock starts only when a lead's inference actually begins, so time spent waiting behind other leads never causes a fallback.
On an error or timeout, fall back to rule with used_fallback and routed_to_human set.
Otherwise, route to a human when the top probability is below TAU_ROUTE.
Tests:

golden state files for no incident and a full incident
every rule branch
with a fake runtime: timeout → fallback, exception → fallback, low probability → routed
5 leads submitted at once to a fake runtime taking 0.4 × LAYA_TIMEOUT_MS each: none fall back
Prompt:

Step 2.2 (README §4.1–4.3, §1 rule 2). Implement triage/state.py, triage/fallback.py,
triage/decide.py per Step 2.2. Tests per Step 2.2 with a fake Laya runtime.
Step 2.3: Laya check and routing threshold (HUMAN decision)
Build: tools/laya_check.py:

Generates about 60 labeled leads from seeds 100–104, using oracle intel replayed up to each capture time.
Runs laya and rule on each.
Prints action accuracy for each policy, ECE (10 bins) for Laya's P(person) vs. the detector's confidence, latency p50/p95, and auto-handled accuracy vs. routing rate for TAU_ROUTE from 0.4 to 0.8.
HUMAN:

Set TAU_ROUTE: the lowest value where auto-handled accuracy is at least 90%, or the value that routes about 30% of leads, whichever comes first.
If Laya's accuracy is below the rule's, you may adjust the §4.2 wording (at most 3 tries). If it is still worse, run live with policy="rule" and keep logging Laya. Nothing downstream changes.
Prompt:

Step 2.3. Implement tools/laya_check.py per Step 2.3 (ECE = Σ_b (n_b/N)|acc_b − conf_b|,
10 equal bins). Print the tables; do not change defaults.
Phase 3: Live server
Step 3.1: Mission loop and WebSocket
Build:

server/protocol.py: the §4.7 message models.
mission/loop.py: MissionRun(seed, cfg, policy, parse_mode="oracle"|"grok", sim_human=False). It owns the clock, scenario, captures, the lead lifecycle (§1), the IncidentStore, and the intel schedule. It emits events.
Live mode: each lead's decision is queued (FIFO, Step 2.2), so captures never wait on it.
Fast mode (batch): the clock does not advance past a lead until its decision returns, and the decision is timestamped t_capture + latency_ms / 1000. This keeps sim-time order and dispatch times correct.
Reimage schedules a recapture.
Non-demo inspections resolve on a timer.
With sim_human=True, routed leads get the optimal action after SIM_HUMAN_ROUTED_S, and approvals happen after SIM_HUMAN_APPROVE_S.
server/app.py: at startup, load Laya and start the writer. /ws/mission handles controls and streams events plus mission.state at 10 Hz.
Tests:

a fast-mode run with a fake runtime processes every capture
lifecycle transitions are valid
reimage creates a pass-2 lead
the incident picture updates
event order is the same for the same seed
a WebSocket integration test
Prompt:

Step 3.1 (README §1 lead lifecycle, §4.7). Implement server/protocol.py,
mission/loop.py, server/app.py per Step 3.1. MissionRun is the same object batch uses
later. Tests per Step 3.1 with a fake Laya runtime.
Step 3.2: Approvals, template briefs, persistence, inspect hook
Build:

lead.approve and lead.override follow the lifecycle.
On dispatch: grok/templates.py template_brief(lead, picture), then dispatch.created and a pin.
Writer wiring: runs at start; leads upserted on every status change; intel on arrival; incidents on every update.
If the approved close_in_inspect lead is the carport subject and the run is live (sim_human=False), emit inspect.request and wait for inspect.result. In batch runs every inspection, including the carport, resolves on the T_INSPECT_S timer.
Tests:

approve → brief whose coordinates and P(person) come from code
override changes final_action
with a writer whose put sleeps 1 s, decision latency is unchanged
a sim_human=True run whose seed has a carport subject finishes without waiting on the browser
Prompt:

Step 3.2 (README §1 rules 2–3, §4.6). Implement Step 3.2. Tests per Step 3.2,
including the slow-writer non-blocking test.
Phase 4: Ground control UI
Step 4.1: Client core and layout
Build:

ws.ts: typed messages matching protocol.py, with reconnect.
store.ts: one observable store.
Layout:
3D view on the left
2D map at top right
queue on the right
bottom tabs: Intel, Log, Ask, Fly, Results
Controls: seed, start, pause, reset, Demo.
Acceptance: Start streams live state.

Prompt:

Step 4.1 (README §4.7). Build ws.ts, store.ts, layout and controls per Step 4.1 in
vanilla TS. All displayed data comes from the server.
Step 4.2: 3D scene and 2D map
Build:

scene/world.ts: renders the snapshot as a low-poly scene: ground, a semi-transparent water plane, box houses, cone trees, capsule subjects, varied decoys, and the carport. The drone follows mission.state. renderThumbnail(x, y) returns an offscreen top-down crop.
Carport module: exported for Step 6.2.
scene/map.ts: a canvas map showing:
sectors and landmarks
the swept path and a coverage heatmap
the drone
lead pins colored by action or status
hazards and the last-known point
Acceptance: at 4× the sweep completes on screen, and leads show thumbnails.

Prompt:

Step 4.2. Implement scene/world.ts (with an exported Carport module and
renderThumbnail) and scene/map.ts per Step 4.2.
Step 4.3: Queue, intel feed, decision log
Build:

Queue: sorted with routed leads first, then urgency (highest first), then P(person). Each card shows:

thumbnail
action
a probability bar across the 4 actions
urgency
P(person)
a "needs human" badge
approve and override controls
The brief opens in a modal.

Intel feed: each raw message with its parsed chips, or "parsing…".

Decision log: time, lead, action, top probability, latency, fallback, routed.

Acceptance: the full loop works by hand: leads, then decisions, then approve, then a pin and a brief.

Prompt:

Step 4.3. Implement queue, intel feed, and decision log per Step 4.3.
GATE 1: the triage loop runs live end to end (oracle intel, template briefs) and records land in Mongo or JSONL.

Phase 5: Grok as a system
Step 5.1: Intel → incident picture
Build:

grok/parse.py: parse_intel(raw, gazetteer) returns an IntelParse. The system prompt explains the incident-command context, lists the allowed sectors and landmarks with plain descriptions, requires the schema, and requires unparseable for non-actionable messages and is_retraction for corrections.
MissionRun(parse_mode="grok"): on_intel emits intel.new, then parses in the background with a timeout.
On success: store apply, then intel.parsed and incident.update.
On failure: intel.parsed{ok:false}, and the picture stays unchanged.
Tests (mocked Grok):

a timeout leaves the picture unchanged
a success applies the update
a lead decided while a parse is still pending uses the earlier snapshot
Prompt:

Step 5.1 (README §1 rules 2 and 4, §4.4–4.5). Implement grok/parse.py and the grok
parse mode in MissionRun per Step 5.1. Tests with a mocked client.
Step 5.2: Grok briefs
Build:

grok/briefs.py: write_brief(lead, picture) returns a BriefText. The prompt gives categorical facts only and forbids numbers.
Code assembles the final brief: lead id, coordinates, nearest landmark, P(person), urgency, time, thumbnail, plus Grok's text.
Any digit in Grok's text is stripped and flagged.
On timeout, use the template brief.
Tests: assembled numbers come from code; injected digits are stripped; timeout falls back to the template.

Prompt:

Step 5.2 (README §1 rule 4). Implement grok/briefs.py and wire into dispatch per
Step 5.2. Tests per Step 5.2.
Step 5.3: Ask Ground Control
Build:

grok/tools.py, 4 read-only tools:
Tool	Returns
get_mission_status()	Time, coverage %, drone position, lead counts by status
list_leads(status?, sector?, limit=10)	Compact rows: id, sector, nearest landmark, action, status, P(person), urgency
get_incident_picture()	Current picture
get_decision_stats()	Mongo aggregation for this run: counts by action and source, fallback rate, routed rate, Laya latency p50/p95
grok/ask.py: ask(question) uses chat_with_tools (up to ASK_MAX_TOOL_ROUNDS rounds, with a timeout). The system prompt says:
answer only from tool results
cite lead ids
say when data is missing
never claim an action was taken
POST /api/ask, with every exchange logged to qa.
UI: an Ask tab with a chat, a collapsible tool trace per answer, and lead ids that highlight on the map and queue when clicked.
Tests (mocked Grok):

the tool loop records a trace
the round cap holds
tools don't change mission state (snapshot hash before and after)
Prompt:

Step 5.3 (README §1 rules 3–4, Step 5.3 tool table). Implement grok/tools.py,
grok/ask.py, POST /api/ask, qa logging, and the Ask tab per Step 5.3. Tests per
Step 5.3.
GATE 2: in a live run with Grok parsing, parsed chips appear, the queue re-ranks after intel, Grok briefs appear on dispatch, and "what's unresolved in S3?" is answered with a visible tool trace.

Phase 6: Fly reflex
Step 6.1: Reflex process and protocol
Build:

reflex/server.py: FastAPI on :8001 with /ws/reflex, implementing the §4.7 frame and command protocol. It keeps per-episode state and supports three modes:
live: returns commands
bench_record: stores frames and episode metadata to bench/frames/<episode>.npz, and returns none
bench_closed: returns commands
reflex_on=0 always returns none.
reflex/frames.py: decoding and validation.
Tests:

An isolation test statically scans reflex/ and fails on any import of server, pymongo, xai_sdk, httpx, or requests.
A protocol round-trip test.
Prompt:

Step 6.1 (README §1 rule 1, §4.7 reflex protocol). Implement reflex/server.py and
reflex/frames.py per Step 6.1 with the isolation test.
Step 6.2: Carport inspection scene and frames
Build: scene/inspect.ts:

Carport: 4 posts (0.1 m), a sagging beam (~2.2 m), and one falling-debris event.
Kinematics: forward flight at inspection speed, braking deceleration, swerve, and brake latch.
Collisions: the drone is a 0.25 m sphere tested against cylinders and boxes.
Frames: an FPV camera renders to a FRAME_R² target, converts to grayscale bytes, and sends at 50 Hz.
In live mode it doesn't wait longer than one frame for a reply.
In bench mode it steps in lockstep with replies.
Episode metadata: collides_truth and t_contact are computed from the straight-line path.
Live flow: inspect.request opens the scene with the reflex on and sends inspect.result at the end.
web/bench.html: runs a seeded list of episodes in bench_record or bench_closed mode.
Acceptance: frames arrive at about 50 Hz, and with the reflex off the drone hits a post it's aimed at.

Prompt:

Step 6.2 (README §3 reflex constants, §4.7). Implement scene/inspect.ts and
web/bench.html per Step 6.2.
Step 6.3: Fly eye
Build: reflex/hexeye.py:

FlyEye.reset(): new network state, then WARMUP_S of gray. The mean activity of each node over the last 0.2 s is stored as the rest vector.
step(frame): maps the frame onto the hex eye, steps the network once, and returns:
the §4.8 regional energies from rectified T4/T5 activity using SUBTYPE_DIR
the full node-activity vector
deviation(): activity minus rest.
Log ms/step.
Tests (marked slow), on synthetic stimuli at FRAME_R:

expanding disc → outward > inward in all 4 regions
contracting disc → the reverse
rightward texture → R-outward and L-inward dominate
5 s of gray → values stay finite and near rest
Prompt:

Step 6.3 (README §4.8, Step 0.4 results). Implement reflex/hexeye.py per Step 6.3
using the approach verified in tools/flyvis_smoke.py. Tests per Step 6.3. Report
ms/step p50/p95.
Step 6.4: Looming readout and avoidance
Build:

reflex/looming.py: Readout(alpha) computes S and dLR.
reflex/controller.py: the §4.8 rules.
Wire FlyEye → Readout → Controller into server.py. θ comes from bench/thresholds.json if that file exists, otherwise from a hand-set default.
Tests:

left-dominant expansion → dLR > 0 → swerve right
the latch holds for at least BRAKE_LATCH_S
reflex_on=0 never brakes
on the expanding-disc stimulus, brake fires before the disc fills the frame (marked slow)
Acceptance (live): the drone brakes before the post in the carport.

Prompt:

Step 6.4 (README §4.8). Implement reflex/looming.py and reflex/controller.py and wire
them into reflex/server.py per Step 6.4. Tests per Step 6.4.
GATE 3: in a live carport inspection, the fly reflex brakes and the drone survives.

Phase 7: Fly data visualization
This is the data-visualization centerpiece. Every view is computed in the browser from one layout (eye.layout) plus one live vector (viz: every flyvis node's deviation from rest, 10 Hz).

Step 7.1: Viz stream
Build:

reflex/viz.py: on connect, send eye.layout (from data/flyvis_layout.json, plus the current θ). In live mode, send the viz binary at VIZ_HZ: header plus N float16 deviations.
web/src/flyviz/stream.ts: decodes both and exposes layout, latest, and a ring buffer of the last 10 s of S and dLR.
Tests:

Python: encode a viz message and decode it with a small reference decoder written from the documented byte layout (16-byte header, float16 body at offset 16); values and length N must match
rate limit holds at VIZ_HZ
Acceptance: during inspection, the browser logs 10 viz messages per second of length 45,669.

Prompt:

Step 7.1 (README §4.7 eye.layout and viz). Implement reflex/viz.py and
web/src/flyviz/stream.ts per Step 7.1. Tests per Step 7.1.
Step 7.2: Eye view and looming trace
Context. This view shows what the fly's eye receives and how its motion cells respond, column by column.

Build: flyviz/eye.ts, a canvas of 721 hexagons, each drawn at its column's image position (col_x, col_y), with three layers switchable by tabs:

Receptors: mean deviation of R1–R6 per column, grouped by node_col (what the photoreceptors see).
Motion: per column, hue = the preferred direction (from SUBTYPE_DIR) of the strongest T4/T5 subtype, and brightness = its rectified value. Include a direction color-wheel legend.
Looming: per column, (outward − inward) using the column's own position: horizontal part from the L/R rule by the sign of col_x, vertical part from the U/D rule by the sign of col_y, summed; diverging color map.
flyviz/trace.ts adds:

a live Chart.js plot of S with a θ line and a dLR subplot
markers where brakes and swerves happened
The Fly tab and the inspect overlay show the eye view and the trace side by side, next to the FPV image.

Acceptance:

Receptors mirror the FPV image.
Motion shows radially outward hues as the beam approaches.
Looming lights up before S crosses θ.
Prompt:

Step 7.2. Implement flyviz/eye.ts (three layers) and flyviz/trace.ts per Step 7.2
using only stream.ts data. Place each hexagon at its column's (col_x, col_y) from the
layout (not raw u,v), so the eye view is oriented like the camera image.
Step 7.3: Circuit view
Context. This view shows the fly's visual pathway working live, from receptors to the brake.

Build: flyviz/circuit.ts, an SVG graph of cell types in fixed columns:

Photoreceptors R1–R8
Lamina L1–L5 and related types
Medulla inputs: the ON path (Mi1, Tm3, Mi4, Mi9) and the OFF path (Tm1, Tm2, Tm4, Tm9)
T4a–d and T5a–d
Two extra nodes that are not flyvis cells: Looming S and Brake
Other flyvis types sit in a dimmed "other medulla/lobula" group, so all 65 are present.

Edges come from type_edges:

show only the strongest 3 inputs per type, so the graph stays readable
thickness = weight
color = excitatory or inhibitory sign
T4/T5 feed the Looming node, which feeds Brake, drawn as dashed "our readout" edges
Nodes:

brightness = the type's mean |deviation| (live)
the Brake node flashes on brake
Acceptance: the approach visibly lights up the path from receptors to T4/T5, then Looming, then Brake.

Prompt:

Step 7.3. Implement flyviz/circuit.ts per Step 7.3 from layout.type_edges and live
deviations. Label our readout nodes clearly as not part of flyvis.
Step 7.4: 3D connectome view (vendored fly-brain)
Context. This view projects our fly-eye model's live activity onto the matching real neurons of the male fly connectome.

fly-brain already maps flyvis nodes to real optic-lobe neurons by cell type and eye column (30,946 left-eye pairs).
The mapping is approximate: about 410 of 721 columns are used.
Label it: "flyvis activity projected onto matching connectome neurons."
Build:

Copy fly-brain's loaders (src/data.js and its decode worker/codecs) into web/vendor/fly-brain/, keeping the MIT license. Copy skeletons.flys, neurons.flyn, vision/flyvis_map.json, and vision/flyvis.bin into web/public/fly-brain/. Add ATTRIBUTION.md covering fly-brain (MIT, Lulzx), male CNS v1.0 (Janelia FlyEM + Google, CC-BY 4.0), and flyvis (MIT).
Node-order check: decode flyvis.bin's per-node type/u/v and compare with our flyvis_layout.json. If they differ, build a remap keyed by (type name, u, v).
flyviz/connectome3d.ts renders, in its own Three.js renderer inside the Fly tab:
the mapped left-eye neurons as skeletons, with brightness from our deviation vector via the pairs and the remap, using a per-neuron activity texture like fly-brain's viewer
all other neurons as dim somas or hidden
orbit controls and a legend
Show the label and attribution in the view.
Tests:

a script (tools/check_flybrain_map.py or a vitest) asserts either identical node order or a complete remap with more than 95% of pairs resolved
the renderer loads in under 5 s on the demo Mac (manual)
Acceptance: during the approach, the optic lobe's T4/T5 neurons visibly brighten.

Prompt:

Step 7.4 (README Tech stack fly-brain row). Clone github.com/Lulzx/fly-brain and read
src/data.js, the decode worker it uses, src/main.js (activity texture approach), and
public/vision/flyvis.json + flyvis_map.json ('eyes'.'L'.'pairs' = [neuron_index,
flyvis_node_index]). Vendor only the loaders and the four data files listed in Step
7.4 with licenses and ATTRIBUTION.md. Implement the node-order check/remap and
flyviz/connectome3d.ts per Step 7.4. Do not vendor fly-brain's LIF brain, WASM,
MuJoCo, arena, or workers other than the data decoder.
GATE 4: during the carport approach, all four views respond live: eye, trace, circuit, and 3D.

Phase 8: Numbers
Step 8.1: Triage batch and metrics
Build: batch/run_tier1.py runs MissionRun headless for seeds 0–19 with sim_human=True and parse_mode="oracle" (intel parsed from templates, so no Grok calls). It runs two arms, policy ∈ {laya, rule}, writing to Mongo and results/tier1_raw.parquet.

batch/metrics_tier1.py computes:

Common zero point: for every subject, t0 = the time of the first capture whose footprint contains it. Both numbers below are measured from t0.
Manual baseline: reviewer finish time f_i = max(t_i, f_{i−1}) + REVIEW_S (captures reviewed in order), for REVIEW_S = 120 and 10. A visible or partial subject is found when the reviewer finishes its first containing capture i; under_structure subjects are never found by review. T_human = f_i − t0 + HANDOFF_S.
FlyBy time-to-dispatch: T = t_dispatch − t0 + HANDOFF_S. Report median and IQR per arm vs. both baselines, plus how many subjects each approach found.
Per arm: subjects dispatched / placed, action accuracy, dispatch precision and recall.
Laya calibration: reliability diagram and ECE for P(person) vs. detector confidence.
Output: results/tier1_metrics.json and PNGs.
Tests:

the baseline recurrence on a hand-computed 3-capture example, checking that both numbers use t0
ECE on a toy input
a fake-runtime run of one seed
Prompt:

Step 8.1. Implement batch/run_tier1.py and batch/metrics_tier1.py per Step 8.1 with
the listed tests. Document the results JSON schema at the top of the file.
Step 8.2: Reflex benchmark
Build:

Open loop: bench.html records 60 straight approach episodes in clean conditions:
post, beam, and debris obstacles
speed 1–3 m/s
offsets chosen so about half would collide:
post: lateral offset 0–0.6 m (collides if under 0.30 m)
beam: vertical offset of the flight height from the beam, 0–0.6 m (collides if under the drone radius plus half the beam depth)
debris: fall-start time offset, chosen so about half the drops cross the flight path at contact time
bench/eval_reflex.py runs the fly eye and readout offline on the saved frames and sweeps θ:
false-brake rate = share of non-colliding episodes where S crosses θ
warning time = t_contact minus the first crossing, on colliding episodes
choose θ where the false-brake rate is about 5%, and write bench/thresholds.json
report mean and 5th-percentile warning time, plus the share with warning ≥ v/A_BRAKE + 0.04
Closed loop: 30 episodes × reflex off/on, same seeds, run in bench.html bench_closed mode. Results come from bench/closed_loop.jsonl (§4.7); report collisions per 30 for each.
Write results/reflex.json and PNGs.
Tests: warning time and false-brake rate on synthetic S traces with known crossings; at 3 m/s the required warning is 0.79 s.

Prompt:

Step 8.2. Implement bench/eval_reflex.py and run the open- and closed-loop episodes
per Step 8.2. Tests on synthetic traces.
Step 8.3: Results tab
Build: the Results tab reads /api/results/* and shows:

time-to-dispatch vs. manual review (120 s and 10 s)
the Laya reliability diagram and ECE
reflex warning time vs. false-brake rate, with the chosen θ marked
collisions with the reflex off vs. on
fly eye ms/frame
attribution text
No numbers are hardcoded.

Prompt:

Step 8.3. Build the Results tab per Step 8.3 from results/*.json only.
Phase 9: Demo and submission
Step 9.1: Demo preset, check, freeze
Build:

A Demo button loads a fixed seed where all of these hold:

a carport subject is detected
at least one lead routes to a human
an intel message re-ranks the queue in the first 2 minutes
at least 3 dispatches occur
Pick the seed with a short scan in tools/demo_check.py --find-seed.

tools/demo_check.py: Laya loads, Grok parses, Atlas or JSONL works, the reflex is up, and the results files exist.

Offline test (Wi-Fi off): triage keeps deciding, briefs use templates, the intel feed shows "parse unavailable", Ask shows "offline", and writes go to JSONL.

HUMAN: freeze the constants and record a backup demo video.

Prompt:

Step 9.1. Implement the Demo preset and tools/demo_check.py per Step 9.1, then verify
offline behavior with Grok and Atlas unreachable. Fix anything that blocks or crashes.
Step 9.2: Submit (HUMAN)
Submit on Devpost first. Then submit on expo.hexlabs.org with the Devpost link. Both must be in before Sunday 8:00 AM.

6. Run
uv sync && (cd web && npm install)
cp .env.example .env                        # XAI_API_KEY, XAI_MODEL, MONGODB_URI
uv run uvicorn server.app:app --port 8000
uv run python -m reflex.server --port 8001
cd web && npm run dev
uv run pytest -m "not slow and not network"
7. Live demo (~1:45)
Click Demo. The sweep runs, and leads fill the queue with Laya's action, confidence, urgency, and P(person).
An intel message arrives. Grok's parsed chips appear, the map updates, and the queue re-ranks.
A low-confidence lead shows needs human. Approve a dispatch: the Grok brief appears and a pin drops.
Ask: "What's still unresolved near Elm?" The answer appears with its tool trace.
Approve the carport inspection, then open the Fly tab:
receptors mirror the camera
motion cells light up outward
the circuit glows from receptors to the brake
the 3D connectome's optic lobe brightens
S crosses θ, and the drone brakes and survives
Results: time-to-dispatch vs. manual review, calibration, reflex warning time, and collisions with the reflex on vs. off.
