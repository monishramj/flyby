# FlyBy implementation rules

Start with docs/fly-connectome/README.md and its MASTER_PLAN.md for scope,
decisions, dependencies and the resume prompt.
README.md is the full build specification. Read its referenced sections before edits.
Read docs/fly-connectome/STATUS.md and docs/TEAM.md for the current step and ownership.
Update docs/fly-connectome/STATUS.md with validation and next steps at every handoff.

- Implement only the current agreed step. No extra features or abstractions.
- Keep reflex/ independent of server/, databases, and outbound network calls.
- The decision path must never wait on Grok, MongoDB, or the network.
- Mongo writes go through a background queue. Grok never decides or dispatches.
- Python 3.12 with uv; keep constants in server/config.py or reflex/config.py.
- Verify flyvis, fly-brain, Laya and xai-sdk APIs against real source before use.
- Never fabricate model activity, measured directions, timings, or benchmarks.
- Keep checkpoint downloads in setup tools, outside the reflex runtime.
- Preserve upstream licenses and verify node ordering before projecting activity.
- Run the step's tests or acceptance checks. Report changes, validation,
  deviations, and open issues briefly.
- Do not implement Monish's ground-station lane unless explicitly requested.
