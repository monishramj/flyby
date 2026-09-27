# Gate decisions and frozen constants

Every number here came from a tool in this repo. Re-run the command to reproduce it.

## GATE T0.2 — Laya accuracy (passed after fixing the state format)

**Root cause of the earlier failure.** Laya is a ModernBERT text classifier. The state was sent
as raw JSON (`{"detector_band": "high", "box_px": 40, ...}`); Laya cannot read number thresholds
or key names and answered `close_in_inspect` for 18 of 20 cases with P(person) ≈ 0.01. Rewording
only the criteria never fixed this. The state is now rendered as short plain-language sentences
(`server/triage/laya_runtime.render`) and the criteria use the same words.

`uv run python -m tools.laya_smoke --device cpu` → `results/laya_smoke_cpu.json`

| State format / criteria | Action accuracy, 20 hand cases |
| --- | --- |
| JSON, README criteria (before) | 0.25 |
| Prose, README criteria | 0.10 |
| Prose, plain-language criteria (final) | **0.75** |

Gate passed (≥ 0.50): **`LIVE_POLICY=laya`**. The criteria were tuned on 198 first-pass leads
from seeds 100–111 (action accuracy 0.54 vs the rule's 0.50 there).

**Latency.** In-mission p95 ≈ 175 ms on CPU. `LAYA_TIMEOUT_MS = 1500` is kept (≈ 3× the
loaded p95 with queue effects); fallback rate is 0.00.

## GATE T2.4 — routing threshold

`uv run python -m tools.laya_check --seeds 100 … 107` → `results/laya_check.json` (79 leads)

| TAU_ROUTE | routed share | auto accuracy |
| --- | --- | --- |
| 0.40 | 0.04 | 0.461 |
| 0.45 | 0.14 | 0.471 |
| **0.50** | **0.39** | **0.542** |
| 0.55 | 0.65 | 0.464 |
| 0.60 | 0.89 | 0.556 |

No threshold reaches 0.90 auto accuracy (Laya's probabilities stay flat, top action ≈ 0.4–0.5),
so `TAU_ROUTE` is **frozen at 0.50**, the value nearest 30% routed. Laya action accuracy on these
leads is 0.443 vs the rule's 0.405 (small sample).

## Calibration result (reported, not assumed)

From `batch/run_eval.py` over seeds 0–19 (209 leads):

| Signal | ECE (10 equal bins) |
| --- | --- |
| Laya P(person) | 0.2477 |
| Raw detector confidence | 0.1138 |

**Laya's P(person) is still worse calibrated than raw detector confidence** and discriminates
weakly (AUC ≈ 0.59 on first-pass leads, vs 0.81 for the detector). Do not present it as a
calibration win. Laya's contribution is the action recommendation, urgency and routing.

## Fine-tuning Laya (tried, not shipped)

`uv run python -m tools.laya_finetune` retrains only Laya's `scorer` (about 1M of its 421M
parameters) on 971 simulated decision states (seeds 1000–1059), labelled from the simulator's
truth, and tests on 220 states from seeds 100–111. Urgency is distilled toward stock Laya so it does
not drift.

| Scorer | Action accuracy | Routed to a human |
| --- | --- | --- |
| stock | 0.486 | 0.53 |
| fine-tuned, 60 epochs | 0.491 | 0.48 |

Heavier training and class weighting (exploratory sweeps, three training seeds each) reached
accuracy 0.53–0.62, but only by auto-closing more real people: every setting sat on the same
curve of fewer leads for the human versus more people missed, with wide seed-to-seed variance.

**Why:** the information is not in what Laya reads. In the simulator a person under a roof
scores *lower* on the camera than debris does (`NOISE`: 0.40 vs 0.45), and the state only
carries the camera score band, image size, and whether the lead is by a structure:

| Camera | Where | Share that are real people |
| --- | --- | --- |
| low | open | 13% |
| low | by a building or roof | 61% |
| medium | open / structure | 47% / 76% |
| high | any | 96–97% |

Stock Laya already sends low-score leads by a building to close-in inspection, so the people it
auto-closes are low-score people in the open, who read exactly like debris. The real lever is how
sure Laya must be before it may auto-close (stock Laya, same 220 states): at 50%, 53% of leads
reach a human and 9 of 87 people are auto-closed; at 60%, 70% reach a human and 1 is auto-closed.
That is a product decision, not a model fix, so `TAU_ROUTE` is unchanged.

## GATE T7 — demo seed

`uv run python -m tools.demo_check --find-seed` → **`DEMO_SEED = 7`**

| Condition | Seed 7 |
| --- | --- |
| at least one lead routes to a human | 3 leads |
| intel re-ranks the queue within 2 sim-minutes | first re-rank at t+99.4 s |
| at least 3 dispatches | 3 dispatches |

## The drone reroutes for follow-ups

A reimage or close-in inspection is a real visit by the one drone: it leaves the sweep, flies to the
lead at `TRANSIT_SPEED_MPS = 12`, hovers (`ZOOM_HOVER_S = 10` for a zoom, `INSPECT_HOVER_S = 40` to
look under cover), flies back and resumes. The sweep pauses, so later captures and the end of the
search move back by the visit's length, and subjects' zero points use the actual capture time. Queued
visits go to the likeliest person first. This replaced fixed 60 s / 90 s timers; with real flight
times, follow-ups resolve sooner (Laya under-structure time to dispatch about 450 s → 270 s; the rule,
which re-images often, 125 s → 76 s median).

## Headline evaluation numbers

`uv run python -m batch.run_eval` → `results/summary.json`

| Arm | Time to dispatch (median) | vs manual @120 s/image | vs manual @10 s/image | Subjects found | Final action accuracy |
| --- | --- | --- | --- | --- | --- |
| rule | 76.3 s | 4090 s → 53.6× | 240 s → 3.2× | 70/141 | 0.679 |
| laya | 80.2 s | 4090 s → 51.0× | 240 s → 3.0× | 77/141 | 0.813 |

Laya's `ignore` auto-closes only on a low detector band; auto-closed leads are re-decided when intel changes their context. Laya routes 44.5% of leads to the simulated human, who then picks the §4.4 optimal action 90% of
the time, so part of the laya arm's edge is the simulated operator, not Laya. First-decision
accuracy (before any human) is 0.44 for laya vs 0.42 for the rule.

**Human load (sub-problem 2).** A manual reviewer handles every flag. Of 209 flags, after the
"no one gets lost" gate (below):

| Arm | Needed judgment | One-click approval | No human | Real people closed with no human look |
| --- | --- | --- | --- | --- |
| rule | 65 | 62 | 82 | 10 |
| laya | 146 | 55 | 8 | 2 |

**No one gets lost.** An `ignore` may auto-close only on a low camera score, in the open, with Laya
at least `TAU_CLOSE = 0.60` sure; anything else goes to a human. The queue ranks by
`PERSON_CHANCE` (the measured table in the fine-tuning section), so likely people come first
whether or not Laya was confident. Auto-closed leads are never final: the commander confirms them
in one batch or reopens any. Versus the 0.50 bar: Laya's people closed unseen 7 → 2, subjects
found 72 → 77, median time to dispatch 80 → 83 s, flags needing judgment 111 → 144. The two that
remain are low-score people in the open, who read exactly like debris; in the live app they still
sit in the Auto-closed tab awaiting confirmation (the batch's simulated human never confirms).

`under_structure` subjects are reported separately (median 394.1 s, laya arm): overhead
review cannot see them at all, so they are excluded from the primary comparison.
