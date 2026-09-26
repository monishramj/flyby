# Gate decisions and frozen constants

Every number here came from a tool in this repo. Re-run the command to reproduce it.

## GATE T0.2 — Laya accuracy (failed, fallback taken)

`uv run python -m tools.laya_smoke --device cpu` → `results/laya_smoke_cpu.json`

| Criteria variant | Action accuracy on the 20 hand cases | What Laya answered |
| --- | --- | --- |
| 0 (README §4.2 wording) | 0.25 | `close_in_inspect` ×18, `ignore` ×2 |
| 1 (band-explicit reword) | 0.25 | `ignore` ×20 |
| 2 (state-field reword) | 0.25 | `ignore` ×20 |
| 3 (outcome reword) | 0.25 | `ignore` ×20 |

Chance is 0.25. All three permitted rewordings were tried and none reached 0.50, so the
gate's fallback applies: **`LIVE_POLICY=rule`**. Laya still loads, and its decisions and
P(person) are recorded by `tools/laya_check.py` and the `laya` arm of `batch/run_eval.py`.

Laya's maximum action probability never exceeded 0.60 on any mission lead, so under
`policy="laya"` every lead routes to a human — confirmed by the T2.4 sweep below.

**Latency.** In-mission p95 is 494 ms on CPU (higher than the 348 ms smoke figure, because
mission states carry more context). `LAYA_TIMEOUT_MS = 1500` ≈ 3 × p95. The previous value
of 500 ms made 14 of 23 leads fall back on timeout; at 1500 ms the fallback rate is 0.00.

## GATE T2.4 — routing threshold

`uv run python -m tools.laya_check` → `results/laya_check.json`

| TAU_ROUTE | auto-handled share | auto accuracy |
| --- | --- | --- |
| 0.40 – 0.80 | 0.00 | n/a |

No threshold reaches 0.90 auto-handled accuracy, and no threshold routes only ~30%,
because Laya's top probability stays below 0.40. `TAU_ROUTE` is therefore **frozen at the
README default 0.60**; it governs the `laya` arm only. Under `policy="rule"` the
probabilities are one-hot, so leads reach a human through the pass-`MAX_PASSES` reimage
rule and through fallbacks rather than through the probability gate.

## Calibration result (reported, not assumed)

From `batch/run_eval.py` over seeds 0–19 (209 leads):

| Signal | ECE (10 equal bins) |
| --- | --- |
| Laya P(person) | 0.4548 |
| Raw detector confidence | 0.1297 |

**Laya's P(person) is worse calibrated than raw detector confidence.** Laya returns
P(person) ≈ 0.006 for every lead, including clearly visible people. The pitch must say
this plainly: the calibration claim is a measured result that came out negative, which is
why the live policy is the deterministic rule.

## GATE T7 — demo seed

`uv run python -m tools.demo_check --find-seed` → **`DEMO_SEED = 7`**

| Condition | Seed 7 |
| --- | --- |
| at least one lead routes to a human | 3 leads |
| intel re-ranks the queue within 2 sim-minutes | first re-rank at t+99.4 s |
| at least 3 dispatches | 3 dispatches |

## Headline evaluation numbers

`uv run python -m batch.run_eval` → `results/summary.json`

| Arm | Time to dispatch (median) | vs manual @120 s/image | vs manual @10 s/image | Subjects found |
| --- | --- | --- | --- | --- |
| rule | 125.0 s | 4090 s → 32.7× | 240 s → 1.9× | 62/141 |
| laya | 100.8 s | 4090 s → 40.6× | 240 s → 2.4× | 81/141 |

The `laya` arm looks faster only because Laya routes every lead to the simulated human,
who then picks the §4.4 optimal action 90% of the time. It measures the simulated
operator, not Laya. Quote the **rule** arm.

`under_structure` subjects are reported separately (median 256.8 s, rule arm): overhead
review cannot see them at all, so they are excluded from the primary comparison.

## Open items

- `MONGODB_URI` is empty in `.env`, so all persistence goes to `logs/*.jsonl`. Set the URI
  to log to Atlas; nothing else changes. `uv run python -m tools.atlas_smoke` reports which
  target is live.
