# FLYBY: a plain-English guide

## What this is

After a disaster, a search drone photographs a large area, and software flags anything that might be a person. It flags a lot of things that aren't people too, such as debris, animals and warm spots. Someone at a ground station has to decide which of these flags are worth sending a rescue crew to. That person is the **incident commander**.

FLYBY is the commander's screen. It shows the drone searching, ranks every flag by how urgent and how likely it is to be a real person, suggests what to do with each one, and waits for a human to approve. It also reads messy radio messages and turns them into a live picture of the incident.

Everything here is a **simulation**. The drone, the town, the people and the detector are generated from a random *seed*, so the same seed always replays the same mission. That makes the results measurable and repeatable. The detector's accuracy numbers are declared assumptions, not measurements of a real camera.

A few words used throughout:

| Word | Meaning |
|---|---|
| **Lead** | One thing the drone's detector flagged as a possible person. Leads are named `L-…`. |
| **Sector** | The search area is 300 m × 300 m, split into a 3×3 grid, S1 to S9. S1 is the bottom-left (south-west) square and S9 is the top-right (north-east). |
| **Landmark** | A named place, such as "Elm School" or "River Bridge", used to describe where things are. |
| **P(person)** | The estimated chance that a lead really is a person, from 0% to 100%. |
| **Urgency** | How time-critical a lead is: low, moderate, high or critical. |
| **Pass** | How many times the drone has photographed this lead. Pass 2 means it was re-imaged once. |

---

## The top bar

- **FLYBY**: the app name.
- **seed**: which simulated mission to load. The same number always gives the same town, people and detections.
- **Start / Pause**: fly or pause the drone. The mission clock runs faster than real time.
- **Reset**: reload the mission using the seed in the box.
- **Demo**: jump to the pre-chosen demo mission and start it. This mission is picked because it shows every feature: leads that need a human, a re-ranking, and dispatches.
- **Status (right side)**:
  - **live / reconnecting**: whether the screen is connected to the server.
  - **policy**: what makes the suggestions. `rule` is a simple confidence rule. `laya` is a small local AI decision model.
  - **intel**: how radio messages are read. `grok` means an AI parses them. `oracle` means perfect pre-written readings, used for testing.
  - **logs**: where records are saved. `atlas` is a cloud database; `local` is files on this computer.

There are two tabs: **Mission**, the live view, and **Results**, the evaluation numbers.

---

## The 3D view

The top of the Mission tab is a 3D recreation of the search area: a coastal town just after a tsunami.

**The scene**
- **The sea** is to the east, with a beach and palm trees, many bent or snapped by the wave.
- **Floodwater**: a strip along the coast and a few inland pools are still underwater.
- **Mud and debris**: brown sediment and drag marks show where the water went. There's a line of heavier debris where the wave stopped.
- **Houses** closest to the sea are tilted and half-sunk. Cars, boats and shipping containers have been washed inland. Utility poles are down and wreckage is scattered everywhere.
- **Responders**: ambulances, a fire truck and police are parked on dry ground off the west edge.
- **Grid and labels**: faint lines mark the nine sectors. A sector's label turns **orange-red** when radio reports make it critical. Landmark names float above their buildings.

The wreckage is scenery only. The drone's detector doesn't look at it, and it doesn't change any number on screen.

**The drone and its camera**
- The **drone** flies at 40 m in a back-and-forth "lawnmower" pattern that covers the whole area. A faint line shows this planned route.
- The **orange pyramid** under the drone is its camera's view. The **orange square** on the ground is exactly what it is photographing right now, about 46 m across.
- **Green tint** marks ground that has already been photographed. The header shows the same thing as a percentage ("% covered").

**Markers**
- **Pins** are leads, placed where the detector saw something. The pin colour shows the suggested action or current state:

  | Colour | Meaning |
  |---|---|
  | green | dispatch a crew |
  | dark green | a crew has been dispatched |
  | amber | re-image (fly back and zoom in) |
  | blue | close-in inspection |
  | orange | needs a human decision |
  | grey | ignore |

  Click a pin to select that lead. Its card highlights in the queue, and the pin grows and shows its ID. Clicking a card in the queue highlights its pin too.
- **Orange cones** are hazards reported over the radio, such as fire, gas, a downed power line, rising water or collapse risk.
- **A dashed orange ring** marks the *last known point*, where someone was last reported to be.

**Controls (top right)**
- **Orbit**: drag to rotate, scroll to zoom, right-drag to pan. This is the default.
- **Follow drone**: the camera tracks the drone.
- **Top-down**: a map-like view from directly above.
- **show truth**: reveals where the simulated people and decoys *actually* are. People are figures coloured by how visible they are (green: in the open, yellow: partly hidden, red: under a roof). Decoys are grey boxes labelled with what they are. Buildings turn see-through so you can find people under them. It's off by default, because a real commander would never have this. It's there to check how well the system is doing.

---

## The ground-control panels

The bottom of the screen has five panels.

### Incident

A summary of what the radio traffic says is happening. The system builds it automatically from the intel feed.

- **Sector priority**: how urgent each sector is (critical, high, moderate), based on what people have reported.
- **Reported subjects**: how many people are reported in each sector, for example `S4:2` means two people reported in sector 4.
- **Hazards**: every kind of danger reported so far.
- **Last known point**: the landmark where someone was most recently reported.

This picture also feeds into the decisions. A lead in a critical sector, or near a reported hazard, gets treated as more urgent.

### Triage queue

The to-do list of leads waiting for the commander. The most pressing ones are at the top: leads that need a human first, then by urgency, then by P(person). Leads already dispatched stay at the bottom so their briefs can still be opened.

Each card shows:
- **The ID, sector, nearest landmark and pass number.**
- **A small box icon.** Its size shows how big the object looked in the photo; bigger usually means easier to judge.
- **The suggested action**, in large coloured text:
  - **Dispatch crew**: send people there.
  - **Reimage (zoom)**: have the drone photograph it again, closer, before deciding.
  - **Close-in inspect**: take a closer look in person before committing a crew. This is used when someone may be under a roof.
  - **Ignore**: probably not a person.
- **Four bars.** How confident the system is in each of those four actions; the longest bar is the suggestion.
- **P(person), urgency, detector** (how sure the camera's detector was) and **source**: `rule` or `laya`, plus how many milliseconds the decision took.
- **Tags:**
  - **needs human**: the system isn't confident enough to suggest an action on its own, so a person must decide.
  - **re-ranked**: new radio intel changed this lead's context, so it was re-decided and may have moved in the queue.
  - **fallback**: the AI model didn't answer in time, so the simple rule decided instead.
- **Buttons:**
  - **Approve**: accept the suggestion.
  - **Override…**: pick a different action instead.
  - **Brief**: after dispatch, opens the crew briefing.

Nothing is dispatched without a human click. Easy calls (ignore, or re-image the first time) happen automatically. Dispatch and inspection always wait for approval.

**The dispatch brief** opens automatically when a crew is dispatched. It's what the rescue crew receives:
- a headline
- the exact position (metres east and north, sector and nearest landmark)
- P(person), urgency and time
- short notes on what the drone saw, how to get there, and how confident the system is

The wording may be written by an AI, but every number is inserted by code, so the AI can't get a number wrong.

**How a lead moves through the system**
1. The drone photographs something, and a lead appears.
2. The system suggests an action.
3. The suggestion is handled one of three ways:
   - **Ignore**: the lead is closed.
   - **Re-image**: the drone takes a second, closer photo and the lead is decided again. This happens at most once; a second re-image request goes to a human.
   - **Dispatch or inspect**, or the system isn't confident: the lead waits in the queue for a human.
4. An inspection takes a short while. If it finds a person, the lead comes back to be approved for dispatch. If not, it's closed.

### Intel feed

Radio and text messages as they come in: from residents, relays, crews and so on. They're newest first and often messy, like "…static… somebody over there by the thing…".

Under each message, **chips** show what the system understood from it: sector, landmark, number of people, urgency, whether it was first-hand, and any hazards.
- **RETRACTION** means the message cancels an earlier report.
- **no located report** means nothing usable could be pinned to a place.
- **parsing…** means it's still being read.

These readings update the Incident panel. They can also re-rank waiting leads.

### Decision log

A running history of every decision, newest first. Each line shows:
- the mission time
- the lead
- the action chosen
- who decided (`rule` or `laya`)
- urgency and P(person)

**re-decision** marks a lead that was decided again, for example after new intel arrived. This panel is the audit trail: you can see what was suggested and when.

### Ask Ground Control

A chat box for questions about the live mission in plain English, such as "What's still unresolved near Elm?" or "How many leads are waiting in S3?".

The answer comes from an AI (Grok) that can only **look**. It has four read-only tools:
- current mission status
- the list of leads
- the incident picture
- decision statistics

It cannot approve, dispatch or change anything. Each answer has a **tool calls** section showing exactly what the AI looked up, so you can check its work. Lead IDs in answers are clickable and select that lead.

---

## The Results tab

This tab answers "does this actually help?". It comes from running many simulated missions (20 seeds) with a simulated commander, and comparing FLYBY against a person reviewing every drone photo by hand.

There is one card per **policy**. `laya` is the AI decision model; `rule` is the simple confidence rule. Each card shows:

- **Time to dispatch**: typical (median) time from when a person was first photographed to when a crew was sent.
- **vs manual @ 120s / 10s**: the same measure for a human reviewer who takes 120 seconds or 10 seconds per photo. The "× faster" figure is how much quicker FLYBY was.

  The manual reviewer is modelled generously: they never miss a visible person. So this comparison favours the human.
- **Subjects found**: people reached by a crew, out of people placed in the simulation.
- **Under structure**: time to dispatch for people under a roof. They can't be seen from above, so they're only found through close-in inspection. They're reported separately.
- **Action accuracy**: how often the suggested action matched the ideal action.
- **Dispatch precision / recall**:
  - *Precision*: of the crews sent, how many found a person.
  - *Recall*: of the people who could be found, how many got a crew.
- **Routed to human**: how often the system handed the decision to a person. **Fallback** is how often the AI was too slow and the rule stepped in.
- **Re-decisions**: how often new intel caused a lead to be re-decided.
- **Decision latency**: how long a decision takes: typical, and worst-case for 95% of leads.
- **ECE** (calibration error): whether the stated P(person) can be trusted. If the system says "70%", about 70% of those leads should really be people. Lower is better. It's shown next to the raw detector's own confidence for comparison.

Below the cards:
- **Time-to-dispatch chart**: FLYBY vs manual review side by side. It uses a log scale because the gap is large.
- **Reliability chart**: plots stated confidence against how often it was right. A perfectly honest system follows the diagonal.
- **Declared assumptions**: the exact settings the simulation used, including how good the detector is assumed to be. These are assumptions, not measurements, and they're listed so anyone can check them.
