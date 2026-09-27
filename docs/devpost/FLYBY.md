# FlyBy

**Drone search-and-rescue ground control: triage the flood of detections from above, then
fly in close with a fruit-fly visual system watching for obstacles, and see its neurons
light up while it does.**

All numbers below come from `docs/fly-connectome/STATUS.md` and keep its caveats.
Everything runs in simulation.

## Inspiration

After a disaster, drones collect more imagery than people can review while survivors are
still alive. Detectors flag debris and rocks as people, so checking flags becomes the new
bottleneck. And when a lead sits next to a collapsed structure, someone still has to fly
in under roofs and beams to check it.

Fruit flies dodge looming objects with a tiny brain, and its wiring has now been mapped. A connectome-constrained model of that system
(flyvis, Lappalainen et al., 2024) is public. We wanted to know whether it could act as the
eye of a small drone's reflex, and to show honestly what it does and what it misses.

## What it does

FlyBy has two halves joined by one message pair.

1. **Overhead triage (ground control).** A simulated drone sweeps a flooded neighborhood,
   and a detector noise model produces leads with known ground truth. For each lead, Laya,
   a local decision model, returns an action, an urgency and P(person). Grok turns messy
   radio and text intel into a structured incident picture that feeds those decisions; when
   intel changes a lead's context, the lead is re-decided and the queue re-ranks. A human
   approves every dispatch and every close-in inspection. The decision path never waits
   on Grok, the database or the network.
2. **Close-in inspection with a fly reflex.** When a close-in inspection is approved, the
   mission emits `inspect.request`. The browser flies the inspection in a carport scene
   with posts, a sagging beam and a hanging debris panel. Each 96 × 96 camera frame goes to
   a separate "onboard" reflex process running the pretrained flyvis model (45,669 nodes,
   65 cell types, 721 columns). Its T4/T5 motion cells feed a looming readout that brakes
   the drone, turns it 90° away from the looming side, then steers back toward the target.
   The outcome returns as `inspect.result`.
3. **You can watch it think.** Beside the flight, a 3D view lights up real neurons from the
   fly connectome with the reflex's live flyvis activity: 30,946 left-eye neurons mapped to
   flyvis nodes, drawn from their skeletons, with the other neurons of the brain shown as
   dim somas. The drone camera image the fly eye sees and the looming score are on screen
   too.

**What the reflex achieves.** On 100 held-out simulated carport flights (recorded, replayed
through the pretrained eye, scored offline; 90° field of view, 1.5 m/s), it stopped in time
(at least 0.415 s of warning) for **36 of 63 collisions**, with **1 false brake in 37 safe
flights** and **2 early brakes**. By obstacle: debris 20/20, posts 12/20, the sagging beam
4/20. It is not yet reliable avoidance: thin posts and beams sit at the model eye's
resolution limit.

## How we built it

- **Fly eye (`reflex/`).** A Python 3.12 FastAPI/WebSocket process that never imports the
  mission server, a database or the network. It loads the pretrained flyvis checkpoint
  `flow/0000/000` once (we did not train it; we verified its checksum and cell ordering),
  warms it up on gray, and steps it once per 50 Hz frame with persistent state. We measured
  which T4/T5 subtype prefers which direction, and checked image orientation, before
  building on them.
- **Looming readout (ours, not flyvis).** flyvis has no LPLC2 or giant-fiber cells, so
  everything after T4/T5 is an **engineered layer** and is labeled that way: a
  centre-weighted "collision cone" of radial motion, plus LPLC2-style units whose pathway
  weights were fit on 200 training flights. An adaptation stage (subtract a running
  baseline, τ = 0.1 s chosen on training flights only) lets steady responses fade, as
  motion adaptation does in the fly.
- **Controller.** Engineered rules inspired by fly behavior: cruise toward the goal, brake
  on looming, a 90° saccade-like turn away, hold the new heading, then steer back.
- **Inspection scene and bench (TypeScript, Three.js, Vite).** The carport scene renders the
  camera supersampled and area-averaged to 96 × 96. A seeded headless bench records
  flights for fitting and held-out testing.
- **3D connectome view.** We vendored the loaders and data from fly-brain (MIT code; neuron
  data from the male CNS v1.0 connectome by Janelia FlyEM and Google, CC-BY 4.0), checked
  that its flyvis node order is identical to ours (45,669 of 45,669), and wrote a renderer
  that paints per-neuron activity. The mapping of model nodes to neurons is upstream's
  approximate retinotopic assignment.
- **Live stream.** The reflex sends its eye layout once per connection, then up to 10
  activity packets per second of flight (float16 deviations for all 45,669 nodes). The
  browser decodes them and hands them to the 3D view. The flight never waits for the view.
- **Ground control** (built by Monish on the triage lane): Laya for decisions, Grok via
  `xai-sdk` for the incident picture and crew orders, MongoDB Atlas with a local file
  fallback for logging, all behind a write-behind queue.

## Challenges we ran into

- **Our first headline number was wrong.** An earlier readout looked like 29/63 in time.
  Closed-loop captures showed debris flights braking at the end of the hover and staying
  braked: a static scene kept the signal above rest. Scoring only asked "did it brake
  before contact?", so brakes seconds early counted as catches. With early brakes (more
  than 2.5 s before contact) counted as false, that readout caught only 7/63 in time.
  Adaptation fixed the cause, which gives the 36/63 above.
- **Doorways loom too.** Safe flights pass under the beam and roof edge, which really do
  expand in the image. Wide looming units could not tell a doorway from an obstacle.
- **A sagging beam only moves one way in the image.** Only its lower edge moves, near the
  centre of view, so all-sides looming units miss it. The collision cone was added for
  this, and beams are still only 4/20 in time.
- **Resolution.** A 0.1 m post covers fewer than 2 of the eye's facets until the drone is
  within about 1 m. Narrowing the field of view to 60° made things worse than 90°.
- **Real-time on a laptop.** Measured on the Windows development laptop's CPU, the eye step
  alone takes 18.8 ms p50 (23.0 ms p95) against a 20 ms frame budget. In live browser
  flights there the reflex answered about 20–35 frames per second while the page sent 50,
  so replies queue and commands can act seconds late. The offline test above does not have
  this lag. The demo Mac has not been measured.
- **Honest labels.** It is easy to call this "a fly brain flying a drone". It isn't: the
  eye is a pretrained connectome-constrained model; the readout and controller are ours.

## Accomplishments that we're proud of

- A real, pretrained connectome-constrained visual model in a closed control loop, with
  direction preferences, orientation and node ordering verified instead of assumed.
- Activity from the live model projected onto real connectome neurons during the flight,
  with the node order checked end to end (all 30,946 left-eye neuron pairs resolve).
- A held-out test with honest scoring, including publishing our own correction.
- Isolation that holds: the reflex runs as its own process with no database or network
  access, and the flight still runs (without the reflex) if it is down.

## What we learned

- Scoring decides what you think you built. "Braked before contact" is not "braked in time".
- Adaptation, borrowed from the way fly motion responses fade, fixed our worst false
  alarms: a static scene should not keep a looming alarm on.
- Where an edge sits in the image matters more than how big the looming region is: things
  that will hit you move outward near the centre of view.
- Resolution is a hard limit: with the model eye's 721 columns, a thin post or beam shows
  up too late at this speed, whatever the readout.

## What's next

- Wire the mission UI to run the inspection on `inspect.request` and send `inspect.result`
  back automatically (the server side and the flight call both exist; see
  `docs/fly-connectome/INTEGRATION.md`).
- Client-side backpressure (send a frame only when the previous reply arrived) or a faster
  eye, so live commands are not late.
- Measure the eye, the 3D view and Laya together on the demo Mac before promising 50 Hz.
- More eye resolution or a second cue for posts and beams; the larger flyvis eye loads but
  was out of scope.
- The planned eye view and circuit view panels, beside the existing 3D view.

## Built with

Python 3.12 · uv · FastAPI · uvicorn · WebSockets · PyTorch · flyvis (pretrained
`flow/0000/000`, Lappalainen et al., 2024, MIT) · NumPy · TypeScript · Vite · Three.js ·
fly-brain (Lulzx, MIT) · male CNS v1.0 connectome (Janelia FlyEM and Google, CC-BY 4.0) ·
Laya · Grok (`xai-sdk`) · MongoDB Atlas · pytest

Attribution details for the vendored viewer code and data:
`web/vendor/fly-brain/ATTRIBUTION.md`.
