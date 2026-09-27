// One live close-in inspection flight with the fly reflex in the loop, drawn into a host
// element. This is the integration point for the mission UI: on `inspect.request`, call
// runInspection(host, request) and send the resolved outcome back as `inspect.result`.
// Lockstep: each frame waits for the reflex's reply before the drone moves, and the
// simulation never runs ahead of real time. On a slow machine the flight runs slower
// than real time, but every command is on time (never a stale reply).
import * as THREE from 'three';
import { FRAME_R, HOVER_S, Inspection, MODE, ReflexLink, SCENARIOS, encodeFrame, makeSpec, type Command, type ReflexSideChannel, type Scenario, type Waypoint, type WaypointStatus } from './inspect';

export interface InspectRequest {
  lead_id: string;
  scenario?: Scenario;   // default: chosen from lead_id
  seed?: number;         // default: derived from lead_id
  person?: boolean;      // draw a person at the target; omit when unknown
  fovDeg?: number;
  reflexOn?: boolean;
  maxWallS?: number;     // stop the flight after this many wall-clock seconds (mission timer safety)
  waypoints?: Waypoint[]; // scene coordinates (x right, z forward is negative); last = target
}

export interface InspectOutcome {
  lead_id: string;
  reached: boolean;      // drone got within GOAL_RADIUS of the target
  collided: boolean;
  found: boolean | null; // reached && person; null when the request did not say
  t: number; frames: number; min_clearance_m: number; late_replies: number;
  realtime_factor: number; // simulated s per wall-clock s (< 1: the reflex is slower than 50 Hz)
  reflex_ok: boolean;    // false if the reflex was unreachable (flown without it)
  waypoints: { id: string; status: WaypointStatus }[]; // pending = not attempted before the flight ended
}

const TARGET_UNDER_ROOF_Z = -2.5;
const ENTRY_Z = 1.5; // in front of the carport's front beam
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
let sideChannel: ReflexSideChannel | null = null;

/** Receive the reflex's eye.layout and live viz packets (e.g. a flyviz VizStream). */
export function attachReflexStream(side: ReflexSideChannel | null) {
  sideChannel = side;
}

async function reflex(): Promise<ReflexLink | null> {
  if (reflexLink) return reflexLink;
  try {
    const link = new ReflexLink({ handle: (data) => sideChannel?.handle(data) ?? false });
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
  // Default route: through the middle of the carport opening, then under the roof.
  const waypoints = req.waypoints ?? [
    { id: 'entry', x: 0, z: ENTRY_Z },
    { id: 'target', x: 0, z: TARGET_UNDER_ROOF_Z },
  ];
  const spec = makeSpec(seed, scenario, req.fovDeg ?? 90,
                        { goalZ: waypoints[waypoints.length - 1].z, person: req.person ?? false, waypoints });
  const insp = new Inspection(spec);
  (insp.drone.getObjectByName('body') as THREE.Mesh).visible = true;
  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
  const chase = new THREE.PerspectiveCamera(55, 1, 0.05, 100);
  const link = await reflex();
  const reflexOn = req.reflexOn ?? true;
  const episode = ++episodeCounter;
  const maxWall = (req.maxWallS ?? 40) * 1000;
  let command: Command | null = null;

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
      <div class="row"><span>waypoint</span><b>${Math.min(insp.wp + 1, spec.waypoints.length)} / ${spec.waypoints.length} · ${insp.goal().dist.toFixed(1)} m</b></div>
      <div class="row"><span>looming S</span><b>${c?.S == null ? '—' : c.S.toFixed(2)}</b></div>`;
  };

  const nextPaint = () => new Promise<number>((r) => requestAnimationFrame(r));
  const started = performance.now();
  while (!insp.done() && performance.now() - started < maxWall) {
    const pixels = insp.frame(renderer);
    drawFpv(pixels);
    if (link) {
      const g = insp.goal();
      const reply = await link.request(encodeFrame(episode, insp.k, reflexOn, MODE.live, g.bearing, g.dist, pixels));
      command = typeof reply.k === 'number' ? (reply as Command) : null;
    }
    insp.step(command, false);
    // Never run ahead of real time; draw the chase view once per screen refresh.
    if (insp.t * 1000 > performance.now() - started || !link) {
      const fwd = new THREE.Vector3(Math.sin(insp.yaw), 0, -Math.cos(insp.yaw));
      chase.position.set(insp.x - fwd.x * 3.2, 2.6, insp.z - fwd.z * 3.2);
      chase.lookAt(insp.x + fwd.x * 2, 1.0, insp.z + fwd.z * 2);
      renderer.setRenderTarget(null);
      renderer.render(insp.scene, chase);
      drawHud();
      while (insp.t * 1000 > performance.now() - started) await nextPaint();
    }
  }
  drawHud();
  const r = insp.result();
  const wallS = (performance.now() - started) / 1000;
  return {
    lead_id: req.lead_id, reached: r.arrived, collided: r.collided,
    found: req.person === undefined ? null : r.arrived && req.person,
    t: r.t, frames: r.frames, min_clearance_m: r.min_clearance_m,
    late_replies: 0, reflex_ok: link !== null, waypoints: r.waypoints,
    realtime_factor: +(r.t / Math.max(wallS, 1e-3)).toFixed(2),
  };
}
