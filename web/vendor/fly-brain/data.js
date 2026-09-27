// Loads the packed connectome files (src/codec) from /data. Each file is fetched and decoded in its own
// worker, so the viewer can show somas while the connectivity and skeletons are still arriving.
//
// FlyBy modification of fly-brain src/data.js (see ATTRIBUTION.md): files are served from
// web/public/fly-brain/ instead of fly-brain's /data, the content-hash table that fly-brain's
// vite.config.js injected (__DATA_FILES__) is written out below, meta.json and the synaptic graph are
// not loaded, and loadNeurons returns the decoded neuron table only.
const BASE = `${import.meta.env.BASE_URL}fly-brain/`;
// { name: { v: first 16 hex of the file's sha256, size: bytes } }; tests/test_flybrain_map.py checks these.
const FILES = {
  'neurons.flyn': { v: '91630046af028262', size: 1006198 },
  'skeletons.flys': { v: '3e5a411218ed9b6b', size: 11588816 },
};

function decodeInWorker(name, kind, onStatus, label) {
  const f = FILES[name], url = new URL(`${BASE}${name}?v=${f.v}`, location.href).href;
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./codec/decode.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = ({ data: m }) => {
      if (m.progress) onStatus?.(`${label} ${(m.progress[0] / 1e6).toFixed(1)} / ${(m.progress[1] / 1e6).toFixed(1)} MB`);
      else if (m.decoding) onStatus?.(`decoding ${label}`);
      else { w.terminate(); m.error ? reject(new Error(m.error)) : resolve(m.result); }
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
    w.postMessage({ url, kind, size: f.size });
  });
}

/** per-neuron table (body ids, classes, somas): { N, bodyIds, soma (voxels, NaN if missing), cls, nt, superclass, side } */
export const loadNeurons = (onStatus) => decodeInWorker('neurons.flyn', 'neurons', onStatus, 'neurons');

/** skeleton line geometry: { V, pos (µm), seg (vertex pairs), vOff (per neuron), bbox (µm) } */
export const loadSkeletons = (onStatus) => decodeInWorker('skeletons.flys', 'skel', onStatus, 'skeletons');
