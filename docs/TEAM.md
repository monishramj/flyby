# Working agreement

The supplied final README wins over the older conversation where they differ.

| Area | Owner | Boundary |
| --- | --- | --- |
| Fly model, reflex, visualization, reflex metrics | Our lane | `reflex/`, `web/src/flyviz/`, `bench/`, fly-specific tools/tests/data |
| Ground station, Grok, Laya, database | Monish | `server/`, `batch/`, mission UI and related tests |
| Shared integration | Both | Root dependency files, `web/src/main.ts`, inspection scene, wire contracts |

Start both lanes from scaffold commit `3812336`. Local branches:
`fly/connectome` and `ground/triage`. Coordinate edits to shared files; do not
replace the whole web entry point during integration.

The reflex is a separate process on port 8001. Monish's ground station uses
port 8000. The browser is the bridge: inspection approval opens the scene;
camera frames go directly to the reflex, and inspection results go back to
the mission server. No Python imports across the process boundary.

The authoritative wire formats are README sections 4.7–4.8. Binary frame
headers are 12 bytes; visualization headers are 16 bytes. Standardize frame
header endianness as little-endian when implementing Step 6.1 (the supplied
README states this explicitly only for visualization packets).

Demo target: the teammate's Apple-silicon Mac, exact chip/RAM to confirm.
Development target: Windows, RTX 3050 laptop GPU, 16 GB RAM. Start on CPU;
test acceleration only after the reference smoke test works. Measure both
models together on the demo host before promising 50 Hz. No hardware latency
claim has been verified.

Repository: https://github.com/monishramj/flyby (`origin` configured).
The user accepted the collaborator invitation for `wikzAM` on 2026-09-26 and
write access is confirmed. The shared scaffold is published on main. Our working
branch is `fly/connectome`; `ground/triage` is only a local starting branch for
Monish, who can create his own branch from the latest origin/main.
The user corrected the initial scaffold push to main: it was not requested.
All further work and pushes from this task must stay on `fly/connectome`.
Do not push/merge to remote main. Fetch before integration and never overwrite
Monish's work.
