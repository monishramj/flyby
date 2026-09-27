# fly-brain attribution

Source: https://github.com/Lulzx/fly-brain, commit
`08cf8666bd3cb405c803f95821ebe06d22b3e5ab` (2026-09-22). Copied 2026-09-26 for
the FlyBy 3D connectome view (README Step 7.4). Only the loaders/decoders and the
data files needed to draw skeletons and map flyvis nodes to neurons were copied.
fly-brain's LIF brain, WASM simulator, MuJoCo body, arena, browser inference and
all other workers were not copied.

## Licenses

- fly-brain code: MIT, Copyright (c) 2026 lulzx. See `LICENSE` (copied verbatim).
- Neuron skeletons, soma table and cell-type data derive from the male CNS v1.0
  connectome (Janelia FlyEM and Google), CC-BY 4.0.
- `vision/flyvis.bin`/`flyvis.json` export the flyvis `flow/0000/000` model
  (Lappalainen et al., Nature 2024), MIT.

## Code in this folder

| File | Upstream path | Status |
| --- | --- | --- |
| `codec/rc.js` | `src/codec/rc.js` | verbatim |
| `codec/skel.js` | `src/codec/skel.js` | verbatim |
| `codec/neurons.js` | `src/codec/neurons.js` | verbatim |
| `codec/decode.worker.js` | `src/codec/decode.worker.js` | modified: graph codec import and entry removed |
| `data.js` | `src/data.js` | modified: serves from `/fly-brain/`, file-hash table written in (upstream injects it from its vite config), no meta.json or graph loading |
| `data.d.ts` | none | FlyBy type declarations |
| `LICENSE` | `LICENSE` | verbatim |

Line endings normalized to LF (upstream stores LF).

## Data in web/public/fly-brain/ (byte-identical to upstream)

| File | Upstream path | Bytes | sha256 |
| --- | --- | --- | --- |
| `skeletons.flys` | `public/data/skeletons.flys` | 11,588,816 | `3e5a411218ed9b6bb979e92b91d9c3eac13a12cf099e7c138d1daec71a9f61d7` |
| `neurons.flyn` | `public/data/neurons.flyn` | 1,006,198 | `91630046af02826299834179bb07726d1ed9b7dd1426e90315c011e42011f6e7` |
| `vision/flyvis_map.json` | `public/vision/flyvis_map.json` | 1,051,795 | `c0de881d3d57307e96efa3cdf7826efc3fb41f22d952b94c042de56e07576c01` |
| `vision/flyvis.bin` | `public/vision/flyvis.bin` | 12,882,225 | `5ddc6fda8f207ce60d372ca6a11eed727ee3179de83c47f5c2eea15317b59315` |
| `vision/flyvis.json` | `public/vision/flyvis.json` | 1,499 | `80c58522dc782bc4378557ee64b2e0e7a1d09f6be451bc5aea8dbe6621360c75` |

`flyvis.json` holds the type names that `flyvis.bin`'s type ids index; it is needed
to read the node order. `flyvis.bin` also contains the model's weights (most of its
size); FlyBy reads only its per-node type/u/v, in `tools/check_flybrain_map.py`.
The browser does not load `flyvis.bin`.

The flyvis→neuron pairs were built upstream by `scripts/prep_flyvis_map.py`
(same cell type and retinotopic column, retinotopy propagated through the
connectome). The mapping is approximate.
