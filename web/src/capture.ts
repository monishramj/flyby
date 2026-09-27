// Records closed-loop flights for offline playback. Lockstep: each frame waits for
// the reflex reply, so the recording is what the reflex actually did, frame by frame.
// URL: capture.html?flights=post:0:on,post:0:off&fov=90&every=2
// Result: window.__capture = { done, flights: [{ spec, reflex_on, result, frames: [...] }] }
import * as THREE from 'three';
import { HOVER_S, Inspection, MODE, ReflexLink, encodeFrame, makeSpec, type Command, type Scenario } from './scene/inspect';

const q = new URLSearchParams(location.search);
const fov = Number(q.get('fov') ?? 90);
const every = Number(q.get('every') ?? 2);
const W = 480, H = 270;
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
const chase = new THREE.PerspectiveCamera(55, W / H, 0.05, 100);
const toB64 = (a: Uint8Array) => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };

(window as any).__capture = { done: false, flights: [] };

async function run() {
  const link = new ReflexLink();
  await link.open();
  let episode = 3_000_000;
  for (const item of (q.get('flights') ?? 'post:0:on').split(',')) {
    const [scenario, seed, onOff] = item.split(':');
    const reflexOn = onOff !== 'off';
    const spec = makeSpec(Number(seed), scenario as Scenario, fov);
    const insp = new Inspection(spec);
    (insp.drone.getObjectByName('body') as THREE.Mesh).visible = true;
    episode += 1;
    const frames: any[] = [];
    let cmd: Command | null = null;
    while (!insp.done()) {
      const pixels = insp.frame(renderer);
      const g = insp.goal();
      cmd = await link.request(encodeFrame(episode, insp.k, reflexOn, MODE.live, g.bearing, g.dist, pixels));
      if ((cmd as any).error) throw new Error((cmd as any).error);
      if (insp.k % every === 0) {
        const fwd = new THREE.Vector3(Math.sin(insp.yaw), 0, -Math.cos(insp.yaw));
        chase.position.set(insp.x - fwd.x * 3.2, 2.6, insp.z - fwd.z * 3.2);
        chase.lookAt(insp.x + fwd.x * 2, 1.0, insp.z + fwd.z * 2);
        renderer.setRenderTarget(null);
        renderer.render(insp.scene, chase);
        frames.push({
          img: canvas.toDataURL('image/jpeg', 0.7), fpv: toB64(pixels),
          k: insp.k, t: +insp.t.toFixed(2), x: +insp.x.toFixed(3), z: +insp.z.toFixed(3), yaw: +insp.yaw.toFixed(4),
          speed: +insp.speed.toFixed(3), hover: insp.t < HOVER_S,
          cmd: cmd!.cmd, S: cmd!.S, dLR: cmd!.dLR, goal: +g.dist.toFixed(2),
        });
      }
      insp.step(cmd, false);
    }
    (window as any).__capture.flights.push({ spec, reflex_on: reflexOn, result: insp.result(), frames });
    document.title = `captured ${item}`;
  }
  link.close();
  (window as any).__capture.done = true;
}

run().catch((e) => { (window as any).__capture.error = String(e); (window as any).__capture.done = true; });
