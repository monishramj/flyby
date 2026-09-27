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

## GATE T7 — demo seed

`uv run python -m tools.demo_check --find-seed` → **`DEMO_SEED = 7`**

| Condition | Seed 7 |
| --- | --- |
| at least one lead routes to a human | 3 leads |
| intel re-ranks the queue within 2 sim-minutes | first re-rank at t+99.4 s |
| at least 3 dispatches | 3 dispatches |

## Headline evaluation numbers

`uv run python -m batch.run_eval` → `results/summary.json`

| Arm | Time to dispatch (median) | vs manual @120 s/image | vs manual @10 s/image | Subjects found | Final action accuracy |
| --- | --- | --- | --- | --- | --- |
| rule | 125.0 s | 4090 s → 32.7× | 240 s → 1.9× | 62/141 | 0.689 |
| laya | 80.2 s | 4090 s → 51.0× | 240 s → 3.0× | 72/141 | 0.813 |

Laya's `ignore` auto-closes only on a low detector band; auto-closed leads are re-decided when intel changes their context. Laya routes 44.5% of leads to the simulated human, who then picks the §4.4 optimal action 90% of
the time, so part of the laya arm's edge is the simulated operator, not Laya. First-decision
accuracy (before any human) is 0.44 for laya vs 0.42 for the rule.

**Human load (sub-problem 2).** A manual reviewer handles every flag. Of 209 flags:

| Arm | Needed judgment | One-click approval | No human | Real people closed with no human look |
| --- | --- | --- | --- | --- |
| rule | 32 | 62 | 115 | 27 |
| laya | 111 | 60 | 38 | 7 |

The rule hands a human far fewer flags but silently closes 27 real people; Laya closes 7 but
sends 53% of flags for judgment, because its probabilities are flat. Present this as the
trade-off it is.

`under_structure` subjects are reported separately (median 394.1 s, laya arm): overhead
review cannot see them at all, so they are excluded from the primary comparison.
