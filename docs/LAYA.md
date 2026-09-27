# Laya runtime provenance

FlyBy uses `laya==0.3.20` with the English root checkpoint from
[`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya), pinned by
`LAYA_REVISION` in `server/config.py`. The acquisition tool stores the reference
`rl_agent_api.py`, `rl_common.py`, model card, configuration, and Apache-2.0 license
beside the ignored weights. Run `uv run python -m tools.setup_laya` once.

The original API is `RLAgent(model_dir, device=None)` and
`RLAgent.system_one(self, state, questions)`. The maintained package preserves
that shape, adds MPS and tokenizer compatibility fixes, and disables compilation.
Serving loads a local directory and makes no network calls during inference.

`choice.probabilities` contains a distribution over action keys. `score.score` is
the fractional expected ordinal score (0–3), not an integer; `noul.noul` is P(true).
Rounded probabilities are normalized. Human routing uses their maximum, not the
SDK's entropy-derived `confidence` or its separate act/escalate output.

The English model has 512 tokens **total**, including question/options (up to
192 tokens). This differs from the plan's description of a 512-token state cap.
Weights occupy roughly 843 MB on disk and 1.7 GB when widened to fp32 in memory.
The model card warns about weak zero-shot decisions, noul label bias, and
overconfidence. No claim of search-and-rescue calibration is made before evaluation.

The state dict is rendered to plain-language sentences before inference (`laya_runtime.render`):
Laya is a text model and scored at chance on raw JSON (see docs/GATES.md).

Run `uv run python -m tools.laya_smoke --device mps` (or `cpu`). The report in
`results/laya_smoke_<device>.json` includes twenty hand-labeled cases, up to three
criteria rewordings after failure, fifty warm latencies, and the recommended
three-times-p95 timeout. The 50% gate and final runtime configuration need the
human call specified by the build plan.
