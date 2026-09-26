# Fly/connectome: start here

This is the handoff folder for **our fly-connectome branch**, `fly/connectome`.
Another agent can continue from this folder without access to the original chat.
**Push only to `fly/connectome`; the user explicitly prohibited further main changes.**

| Read in order | Purpose |
| --- | --- |
| [Master plan](MASTER_PLAN.md) | Scope, context, decisions, ownership, build order, interfaces, hardware and acceptance checks |
| [Current status](STATUS.md) | What works, what is unimplemented, validation, blockers and next task |
| [Agent rules](../../AGENTS.md) | Required engineering boundaries |
| [Original full specification](../../README.md) | User-supplied project README and detailed step prompts |
| [Team agreement](../TEAM.md) | Our files versus Monish's ground-station lane |
| [Setup](../SETUP.md) | Reproducible local commands, including this Windows workspace |

**Next checkpoint:** README Step 0.4 — install/inspect flyvis, load the real
pretrained model, measure directions and orientation, export the layout, and
report latency. The starter does not yet perform model inference.

## Paste this into the next agent

```text
Continue FlyBy in the monishramj/flyby repository on branch fly/connectome.
Start with docs/fly-connectome/README.md, MASTER_PLAN.md and STATUS.md in that
folder, then root AGENTS.md and the relevant root README sections.
Preserve existing changes. Own only the fly model/reflex/visualization lane;
Monish owns Grok, Laya and the ground station. Complete the next unfinished
checkpoint with real validation. Do not fabricate model data, mappings or
performance. Update docs/fly-connectome/STATUS.md with what changed, checks,
results, blockers and the exact next action before handing off.
```

## Keep the handoff useful

Update STATUS.md after each checkpoint. Update MASTER_PLAN.md only when the
scope, ordering or a decision changes. Keep source code in the existing project
directories; this folder is for agent context and progress, not a second copy
of the implementation. Treat all paths in the plan/status as repository-relative
unless explicitly stated otherwise.
