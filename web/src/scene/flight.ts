// One live close-in inspection flight with the fly reflex in the loop, drawn into a host
// element. This is the integration point for the mission UI: on `inspect.request`, call
// runInspection(host, request) and send the resolved outcome back as `inspect.result`.
// Live mode never waits on the reflex: each 20 ms tick uses the newest reply.
import * as THREE from 'three';
import { DT, FRAME_R, HOVER_S, Inspection, MODE, ReflexLink, SCENARIOS, encodeFrame, makeSpec, type Command, type Scenario } from './inspect';

export interface InspectRequest {
  lead_id: string;
  scenario?: Scenario;   // default: chosen from lead_id
  seed?: number;         // default: derived from lead_id
  person?: boolean;      // draw a person at the target; omit when unknown
  fovDeg?: number;
  reflexOn?: boolean;
  maxWallS?: number;     // stop the flight after this many seconds (mission timer safety)
}

export interface InspectOutcome {
  lead_id: string;
  reached: boolean;      // drone got within GOAL_RADIUS of the target
  collided: boolean;
  found: boolean | null; // reached && person; null when the request did not say
  t: number; frames: number; min_clearance_m: number; late_replies: number;
  reflex_ok: boolean;    // false if the reflex was unreachable (flown without it)
}

const TARGET_UNDER_ROOF_Z = -2.5;
const CSS = `
.flyby-insp{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:10px;width:100%;height:100%;min-height:320px;font:13px/1.4 system-ui,sans-serif;color:#e8eee7}
.flyby-insp canvas.view{width:100%;height:100%;min-height:300px;display:block;border-radius:8px;background:#0b100d}
.flyby-insp aside{display:grid;gap:8px;align-content:start}
.flyby-insp canvas.fpv{width:100%;aspect-ratio:1;image-rendering:pixelated;border-radius:6px;background:#000}
.flyby-insp .cap{font-size:11px;color:#9fb09c;margin:0}
.flyby-insp .state{font-weight:700;padding:5px 8px;border-radius:6px;background:#19231b;text-transform:uppercase;letter-spacing:.04em}
.flyby-insp .state.act{background:#e0a33c;color:#1b1307}.flyby-insp .state.bad{background:#ef6a5b;color:#fff}.flyby-insp .state.good{background:#6cc48a;color:#0d1b12}
.flyby-insp .row{display:flex;justify-content:space-between;border-bottom:1px solid #344337;padding:2px 0;font-variant-numeric:tabular-nums}
.flyby-insp .row span{color:#9fb09c}
@media (max-width:640px){.flyby-insp{grid-template-columns:1fr}}`;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

let reflexLink: ReflexLink | null = null;
let episodeCounter = Math.floor(Math.random() * 1e6) * 100;

async function reflex(): Promise<ReflexLink | null> {
  if (reflexLink) return reflexLink;
  try {
    const link = new ReflexLink();
    await link.open();
    reflexLink = link;
  } catch {
    reflexLink = null;
  }
  return reflexLink;
}

export async function runInspection(host: HTMLElement, req: InspectRequest): Promise<InspectOutcome> {
  if (!document.getElementById('flyby-insp-css')) {
    const style = document.createElement('style'); style.id = 'flyby-insp-css'; style.textContent = CSS;
    document.head.appendChild(style);
  }
  host.innerHTML = `<div class="flyby-insp"><canvas class="view"></canvas><aside>
    <canvas class="fpv" width="220" height="220"></canvas>
    <p class="cap">Drone camera → fly eye (96 × 96)</p><div class="hud"></div></aside></div>`;
  const view = host.querySelector<HTMLCanvasElement>('canvas.view')!;
  const fpvCanvas = host.querySelector<HTMLCanvasElement>('canvas.fpv')!;
  const hud = host.querySelector<HTMLDivElement>('.hud')!;
  const fpvCtx = fpvCanvas.getContext('2d')!;
  const fpvImage = new ImageData(FRAME_R, FRAME_R);
  const off = document.createElement('canvas'); off.width = off.height = FRAME_R;

  const seed = req.seed ?? hashSeed(req.lead_id);
  const scenario = req.scenario ?? SCENARIOS[seed % SCENARIOS.length];
  const spec = makeSpec(seed, scenario, req.fovDeg ?? 90,
                        { goalZ: TARGET_UNDER_ROOF_Z, person: req.person ?? false });
  const insp = new Inspection(spec);
  (insp.drone.getObjectByName('body') as THREE.Mesh).visible = true;
  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
  const chase = new THREE.PerspectiveCamera(55, 1, 0.05, 100);
  const link = await reflex();
  const reflexOn = req.reflexOn ?? true;
  const episode = ++episodeCounter;
  const maxWall = (req.maxWallS ?? 18) * 1000;
  let command: Command | null = null, stale = 0;

  const resize = () => {
    const w = view.clientWidth || 640, h = view.clientHeight || 360;
    renderer.setSize(w, h, false); chase.aspect = w / h; chase.updateProjectionMatrix();
  };
  resize();

  const drawFpv = (pixels: Uint8Array) => {
    for (let i = 0; i < pixels.length; i++) { const j = i * 4; fpvImage.data[j] = fpvImage.data[j + 1] = fpvImage.data[j + 2] = pixels[i]; fpvImage.data[j + 3] = 255; }
    off.getContext('2d')!.putImageData(fpvImage, 0, 0);
    fpvCtx.imageSmoothingEnabled = false; fpvCtx.drawImage(off, 0, 0, fpvCanvas.width, fpvCanvas.height);
  };
  const drawHud = () => {
    const c = command;
    const state = insp.collided ? 'collided' : insp.arrived ? 'reached target' : !link ? 'no reflex' : insp.t < HOVER_S ? 'hover' : (c?.cmd ?? '—').replace('_', ' ');
    const cls = insp.collided ? 'bad' : insp.arrived ? 'good' : c?.cmd && c.cmd !== 'none' ? 'act' : '';
    hud.innerHTML = `<div class="state ${cls}">${state}</div>
      <div class="row"><span>t</span><b>${insp.t.toFixed(1)} s</b></div>
      <div class="row"><span>speed</span><b>${insp.speed.toFixed(2)} m/s</b></div>
      <div class="row"><span>target</span><b>${insp.goal().dist.toFixed(1)} m</b></div>
      <div class="row"><span>looming S</span><b>${c?.S == null ? '—' : c.S.toFixed(2)}</b></div>`;
  };

  return new Promise<InspectOutcome>((resolve) => {
    const started = performance.now();
    let last = started, acc = 0;
    const tick = (now: number) => {
      acc += Math.min(100, now - last); last = now;
      let finished = insp.done() || now - started > maxWall;
      while (!finished && acc >= DT * 1000) {
        acc -= DT * 1000;
        const reply = link?.latest;
        if (reply && typeof reply.k === 'number') {
          if (reply.k !== insp.k && insp.k > 0) stale += 1; // reply to the frame sent last tick
          command = reply as Command;
        }
        insp.step(command, false);
        const pixels = insp.frame(renderer);
        drawFpv(pixels);
        const g = insp.goal();
        link?.request(encodeFrame(episode, insp.k, reflexOn, MODE.live, g.bearing, g.dist, pixels));
        finished = insp.done();
      }
      const fwd = new THREE.Vector3(Math.sin(insp.yaw), 0, -Math.cos(insp.yaw));
      chase.position.set(insp.x - fwd.x * 3.2, 2.6, insp.z - fwd.z * 3.2);
      chase.lookAt(insp.x + fwd.x * 2, 1.0, insp.z + fwd.z * 2);
      renderer.setRenderTarget(null);
      renderer.render(insp.scene, chase);
      drawHud();
      if (!finished) { requestAnimationFrame(tick); return; }
      const r = insp.result();
      resolve({
        lead_id: req.lead_id, reached: r.arrived, collided: r.collided,
        found: req.person === undefined ? null : r.arrived && req.person,
        t: r.t, frames: r.frames, min_clearance_m: r.min_clearance_m, late_replies: stale, reflex_ok: link !== null,
      });
    };
    requestAnimationFrame(tick);
  });
}
