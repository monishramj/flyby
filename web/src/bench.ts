// Seeded bench runs against the reflex, in lockstep (one reply per frame).
// URL params: mode=record|closed, n=seeds per scenario, seed0, fov, scenarios=a,b,
// reflex=on|off|both (closed only), ws=<reflex url>. Outputs are written by the
// reflex server: bench/frames/<episode>.npz (record) or bench/closed_loop.jsonl (closed).
import * as THREE from 'three';
import { Inspection, ReflexLink, SCENARIOS, MODE, encodeFrame, makeSpec, type Scenario } from './scene/inspect';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') === 'closed' ? 'closed' : 'record';
const n = Number(q.get('n') ?? 12);
const seed0 = Number(q.get('seed0') ?? 0);
const fov = Number(q.get('fov') ?? 120);
const scenarios = (q.get('scenarios')?.split(',') ?? [...SCENARIOS]) as Scenario[];
const reflexModes = mode === 'record' ? [true] : ({ on: [true], off: [false] } as Record<string, boolean[]>)[q.get('reflex') ?? ''] ?? [false, true];
const log = document.querySelector<HTMLPreElement>('#log')!;
const say = (s: string) => { log.textContent += s + '\n'; document.title = s; };

function dispose(insp: Inspection) {
  insp.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) {
      (mat as THREE.MeshLambertMaterial).map?.dispose();
      mat.dispose();
    }
  });
  insp.target.dispose();
}

async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(1, 1);
  const link = new ReflexLink();
  await link.open(q.get('ws') ?? undefined);
  let episode = (mode === 'record' ? 1_000_000 : 2_000_000) + seed0 * 1000;
  let count = 0;
  for (const scenario of scenarios) for (let seed = seed0; seed < seed0 + n; seed++) for (const reflexOn of reflexModes) {
    episode += 1;
    const spec = makeSpec(seed, scenario, fov);
    const insp = new Inspection(spec);
    const begin = await link.request({ type: 'episode.begin', episode, params: { ...spec, mode, reflex_on: reflexOn } });
    if (begin.error) throw new Error(begin.error);
    const modeByte = mode === 'record' ? MODE.bench_record : MODE.bench_closed;
    while (!insp.done()) {
      const g = insp.goal();
      const reply = await link.request(encodeFrame(episode, insp.k, reflexOn, modeByte, g.bearing, g.dist, insp.frame(renderer)));
      if (reply.error) throw new Error(`episode ${episode} k=${insp.k}: ${reply.error}`);
      insp.step(reply, mode === 'record');
    }
    const result = { ...insp.result(), scenario, seed };
    const end = await link.request({ type: 'episode.end', episode, result });
    if (end.error) throw new Error(end.error);
    count += 1;
    say(`${count} ${scenario} seed=${seed} reflex=${reflexOn ? 'on' : 'off'} collided=${result.collided} arrived=${result.arrived} t=${result.t}`);
    dispose(insp);
  }
  link.close();
  say(`BENCH DONE ${count}`);
}

run().catch((e) => say(`BENCH ERROR ${e.message}`));
