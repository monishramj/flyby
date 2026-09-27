// Standalone development page for the 3D connectome view (README Step 7.4). It replays a
// RECORDING (tools/record_connectome_sample.py), not the live viz stream (Step 7.1).
import { Connectome3D, FLYVIS_NODES } from './flyviz/connectome3d';

interface SampleMeta {
  kind: string; note: string; stimulus: string; hz: number; frames: number; nodes: number;
  t_s: number[]; disc_radius: number[]; contact_t_s: number; model: string; device: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => { $('status').textContent = s; };

/** IEEE 754 half → float, via a 65,536-entry table. */
function halfTable(): Float32Array {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
}

async function main() {
  const t0 = performance.now();
  const base = `${import.meta.env.BASE_URL}recordings/connectome_disc`;
  const [meta, raw, view] = await Promise.all([
    fetch(`${base}.json`).then((r) => r.json() as Promise<SampleMeta>),
    fetch(`${base}.f16`).then((r) => r.arrayBuffer()),
    Connectome3D.create($('stage'), { onStatus: status }),
  ]);
  if (meta.nodes !== FLYVIS_NODES || raw.byteLength !== meta.frames * meta.nodes * 2) throw new Error('recording size mismatch');
  const half = new Uint16Array(raw), table = halfTable();
  const frames = Array.from({ length: meta.frames }, (_, f) => {
    const out = new Float32Array(meta.nodes);
    for (let i = 0; i < meta.nodes; i++) out[i] = table[half[f * meta.nodes + i]];
    return out;
  });
  const ready = performance.now() - t0;
  const s = view.stats;
  $('info').textContent = `${meta.note} Stimulus: ${meta.stimulus}. Model ${meta.model} on ${meta.device}, ` +
    `${meta.frames} frames at ${meta.hz} Hz. Load: view ${(s.loadMs / 1000).toFixed(2)} s, page ${(ready / 1000).toFixed(2)} s. ` +
    `${s.mappedNeurons.toLocaleString()} mapped neurons, ${s.skeletonVertices.toLocaleString()} skeleton vertices.`;
  (window as unknown as { connectomeLoad: object }).connectomeLoad = { viewMs: s.loadMs, pageMs: ready, stats: s };
  status('');

  let f = 0, playing = true;
  const show = () => {
    view.setActivity(frames[f]);
    const t = meta.t_s[f];
    $('clock').textContent = `t = ${t >= 0 ? '+' : ''}${t.toFixed(1)} s ${t < 0 ? '(still hold)' : '(approach)'} · ` +
      `disc radius ${(meta.disc_radius[f] * 100).toFixed(0)}% of half-frame · contact at +${meta.contact_t_s.toFixed(1)} s · frame ${f + 1}/${meta.frames}`;
  };
  show();
  setInterval(() => { if (playing) { f = (f + 1) % meta.frames; show(); } }, 1000 / meta.hz);
  $<HTMLButtonElement>('play').addEventListener('click', (e) => {
    playing = !playing;
    (e.target as HTMLButtonElement).textContent = playing ? 'Pause' : 'Play';
  });
}

main().catch((e) => { status(`error: ${e.message}`); console.error(e); });
