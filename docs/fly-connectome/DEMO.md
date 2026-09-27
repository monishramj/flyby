# FlyBy demo script (3 minutes)

Overhead triage → approve a close-in inspection → fly it with the fly reflex and the live
3D connectome → result back to ground control.

**What exists today (checked on `fly/connectome` at `5aedf67`):**

- Ground control is the `triage` branch app. Its server emits `inspect.request` when an
  approved inspection starts and accepts `inspect.result`, but its UI does **not** yet run
  the flight (wiring steps: `INTEGRATION.md`). So the handoff below is a tab switch.
- `web/inspect.html` (this branch) runs the flight: chase view, drone camera → fly eye
  (96 × 96), HUD (state, t, speed, target, looming S), and the live 3D connectome view
  beside it. When the flight ends it prints the `inspect.result` it would send.
- `web/connectome.html`: 3D view replaying a **recording** (fallback only).
- `web/flyviz.html` (dev page, `npm run dev` only, not in the build yet; `9b0c7d9`): flies its
  own live flight and shows the fly eye (receptors / T4-T5 motion / looming layers), the S
  trace with θ and command markers, and a circuit graph whose engineered readout box is
  labelled "not flyvis cells" (cone and unit values are not streamed, so they stay unlit).
  Optional second tab if you want to show the eye; `inspect.html` stays the main view.
  Note: `debris` seed 0 there braked repeatedly and timed out at 25 s without collision
  or arrival (2 runs), so rehearse the seed you plan to use.

Numbers you may say are all in `STATUS.md`. Say them with their caveats.

## Pre-demo checklist (15 minutes before)

1. **Two checkouts, one machine.** `triage` (ground control) and `fly/connectome`
   (inspection). Close other heavy apps: browser rendering competes with the eye for CPU.
2. **Ground control** (triage checkout, its README "Run"): build the UI once, then
   `uv run uvicorn server.app:app --port 8000` and open `http://127.0.0.1:8000`.
   Run its `tools.demo_check` if you have time. In rehearsal, press **Demo** and confirm a
   **Close-in inspect** lead reaches the queue; if none does, override a lead near a
   structure to Close-in inspect instead.
3. **Reflex** (fly checkout, once: `uv sync --extra fly` and
   `uv run --extra fly python -m tools.prepare_flyvis`):
   `uv run --extra fly python -m reflex.server`
   (Windows with a CUDA torch build: set `CUDA_VISIBLE_DEVICES=-1` first.)
   Check `http://127.0.0.1:8001/health`: `model_ready: true`, `readout: "learned"`.
4. **Vite** (fly checkout): `cd web && npm run dev`, open `/inspect.html` from the URL it
   prints. Set FOV 90°, **Fly reflex on**, **Person under the roof** on.
5. **Load the page at least 3 s before pressing Fly.** Wait until the 3D caption says
   **READY · press Fly**. If you press Fly while it is still loading, the geometry build
   lands inside the flight and the drone visibly pauses.
6. **One warm-up flight** after every reflex start (the first flight after a start measured
   slower replies). Then reload the page, wait for READY again.
7. **Pick the scenario and seed in rehearsal.** `debris` is the obstacle class the held-out
   test caught every time (20/20). Fly your chosen seed on this machine at least twice and
   only use it if it stopped both times. `clear`, seed 0, is the path STATUS has flown live
   (reached the target, no collision, 4 runs).
8. Keep the inspection tab **visible** when you press Fly (a flight started in a hidden tab
   can end immediately).
9. Have `/connectome.html` open in a background tab, and the backup video ready if one was
   recorded.

## Script

| Time | On screen | Say / do |
| --- | --- | --- |
| **0:00–0:15** | Ground control, idle | "After a disaster, drones collect more imagery than anyone can review, and detectors flag debris as people. FlyBy turns those detections into decisions, then flies in close to check." |
| **0:15–0:55** | Ground control: press **Demo** | Leads fill the queue, each with Laya's action, urgency and P(person). An intel message arrives: Grok's parsed chips appear and pending leads in that sector re-rank. "Laya decides what; Grok keeps the picture current; nothing on the decision path waits on the network." |
| **0:55–1:10** | A lead near a structure with the **Close-in inspect** action | Click **approve**. "Humans approve every dispatch and every close-in inspection. This one is under a carport, so the drone has to fly in under the roof." Switch to the inspection tab. |
| **1:10–1:25** | `inspect.html`, 3D view says READY | "Close in, the drone's camera feeds a model of the fruit-fly visual system: flyvis, pretrained by Lappalainen and colleagues, 45,669 nodes built from the fly's wiring. We did not train it." Press **Fly**. |
| **1:25–2:10** | Flight: HUD goes hover → none → brake → saccade → none; 3D view caption **LIVE · frame k** | Point at the small camera image: "This 96-by-96 image is what the fly eye sees." Point at the 3D view: "These are real neurons from the fly connectome, lit by the model's activity during this flight, updated several times a second." When it brakes: "Its motion cells feed a looming score. That readout, the brake and the 90-degree turn are ours, engineered on top of the model, not fly cells." |
| **2:10–2:25** | Flight ends (**reached target**); `inspect.result` JSON on the left | "The flight returns this `inspect.result`: reached, collided, found. The mission server already accepts it; wiring the UI to send it automatically is the next step." Switch to ground control. |
| **2:25–2:40** | Ground control: the inspected lead resolves | Show the lead leaving **inspecting**. If a person was found it comes back as a dispatch awaiting approval: approve it. "Today ground control resolves the visit on its own timer; this is where the flight's answer plugs in." |
| **2:40–3:00** | Stay on ground control (or a slide with the numbers) | "On 100 held-out simulated carport flights, scored offline, the reflex stopped in time for 36 of 63 collisions, with 1 false brake in 37 safe flights. Debris 20 of 20; posts 12 of 20; the sagging beam 4 of 20. Thin posts and beams are at the model eye's resolution limit, so this is not yet reliable avoidance, and we say so." |

**Do not say:** that the fly "escapes like a real fly", that the Giant Fiber or LPLC2 is
simulated, that the reflex beats other avoidance methods, or any Mac or GPU timing.

**If asked about speed:** on the Windows development laptop's CPU the eye step is 18.8 ms
p50 against a 20 ms frame budget, and in live browser flights the reflex answered about
20–35 frames per second while the page sent 50, so live replies lag. The 36/63 result is
from offline replay, which has no such lag. The demo Mac is unmeasured.

## If something breaks

| Symptom | Do this |
| --- | --- |
| HUD says **no reflex** / "Reflex not reachable" | The flight still flies without the reflex (`reflex_ok: false`). Say so. Restart `python -m reflex.server`, reload the page, wait for READY, fly again. |
| 3D view says **connectome view unavailable** | The flight is unaffected; keep flying. Afterwards switch to `/connectome.html` and say clearly: "This is a **recording**: the same pretrained model watching a synthetic black disc approach head-on." |
| Drone collides or brakes late | Say it: live replies lag on this machine, and posts and beams are the known misses. Give the held-out numbers, not the single flight. Optionally re-fly your rehearsed `debris` seed. |
| Drone pauses mid-flight | The 3D view was still loading when Fly was pressed. Let the flight finish; next time wait for READY. |
| Ground control down | Play the backup video if recorded; otherwise stay on `inspect.html` and describe triage in one sentence. |
| Everything down | Walk through `docs/devpost/FLYBY.md` and the 3D recording on `/connectome.html` if Vite is up. |
