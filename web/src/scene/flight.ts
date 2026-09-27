// One live close-in inspection flight with the fly reflex in the loop, drawn into a host
// element. This is the integration point for the mission UI: on `inspect.request`, call
// runInspection(host, request) and send the resolved outcome back as `inspect.result`.
// Lockstep: each frame waits for the reflex's reply before the drone moves, and the
// simulation never runs ahead of real time. On a slow machine the flight runs slower
// than real time, but every command is on time (never a stale reply).
import * as THREE from 'three';
import { ChaseView } from './dress';
import { askVision } from './vision';
import { FRAME_R, HOVER_S, Inspection, MODE, ReflexLink, SCENARIOS, defaultRoute, encodeFrame, makeSpec, type Command, type ReflexSideChannel, type Scenario, type Waypoint, type WaypointStatus } from './inspect';

export interface InspectRequest {
  lead_id: string;
  scenario?: Scenario;   // default: chosen from lead_id
  seed?: number;         // default: derived from lead_id
  person?: boolean;      // draw a person at the target; omit when unknown
  fovDeg?: number;
  reflexOn?: boolean;
  maxWallS?: number;     // stop the flight after this many wall-clock seconds (mission timer safety)
  waypoints?: Waypoint[]; // scene coordinates (x right, z forward is negative); last = target
  vision?: boolean;      // at the target, photograph and ask Grok vision (advisory; default true)
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
  vision_requested: boolean; // a photo went to Grok vision; its report never changes this outcome
}

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
.flyby-insp .vision{display:grid;gap:4px;padding:6px;border-radius:8px;background:#141c16;border:1px solid #344337}
.flyby-insp .vision img{width:100%;border-radius:4px;display:block}
.flyby-insp .vision .vt{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9fb09c;margin:0}
.flyby-insp .vision .vr{font-weight:700;margin:0}.flyby-insp .vision .vr.yes{color:#6cc48a}.flyby-insp .vision .vr.no{color:#e0a33c}.flyby-insp .vision .vr.off{color:#9fb09c}
.flyby-insp .vision .vd{font-size:12px;margin:0;color:#e8eee7}.flyby-insp .vision .vm{font-size:10px;margin:0;color:#7f907c}
@media (max-width:640px){.flyby-insp{grid-template-columns:1fr}}`;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

let reflexLink: ReflexLink | null = null;
let visionSettled: Promise<void> = Promise.resolve();
/** Resolves once the last flight's Grok vision report (if any) is shown; panels can wait on it before closing. */
export function whenVisionSettled(): Promise<void> { return visionSettled; }

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Photo at the target → Grok vision → card in the flight aside. Never awaited by the outcome. */
function visionCard(aside: HTMLElement, leadId: string, photo: string) {
  const card = document.createElement('div');
  card.className = 'vision';
  card.innerHTML = `<p class="vt">Drone camera at target → Grok vision</p><img alt="Drone photo at the target" src="${photo}">
    <p class="vr off">checking for a person…</p><p class="vd"></p><p class="vm">advisory only · the flight result and the lead's status do not depend on it</p>`;
  aside.appendChild(card);
  const vr = card.querySelector<HTMLElement>('.vr')!, vd = card.querySelector<HTMLElement>('.vd')!, vm = card.querySelector<HTMLElement>('.vm')!;
  visionSettled = askVision(leadId, photo).then((r) => {
    vr.className = `vr ${r.person_visible ? 'yes' : 'no'}`;
    vr.textContent = `${r.person_visible ? 'Person visible' : 'No person visible'} · ${Math.round(r.confidence * 100)}%`;
    vd.textContent = r.description;
    vm.textContent = `${r.model} · ${(r.ms / 1000).toFixed(1)} s · advisory only: nothing was changed`;
  }).catch((e) => {
    vr.textContent = 'Grok vision unavailable';
    vd.innerHTML = esc(String(e.message ?? e));
    vm.textContent = 'no report; the flight result stands on its own';
  });
}
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
  // Default route: carport = through the middle of the opening, then under the roof;
  // house = front door, living room, doorway, bedroom, target.
  const waypoints = req.waypoints ?? defaultRoute(scenario);
  const spec = makeSpec(seed, scenario, req.fovDeg ?? 90,
                        { goalZ: waypoints[waypoints.length - 1].z, person: req.person ?? false, waypoints });
  const insp = new Inspection(spec);
  (insp.drone.getObjectByName('body') as THREE.Mesh).visible = true;
  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; // viewer-only sun
  const chase = new ChaseView(insp.scene, insp.chaseRig);
  const link = await reflex();
  const reflexOn = req.reflexOn ?? true;
  const episode = ++episodeCounter;
  const maxWall = (req.maxWallS ?? 40) * 1000;
  let command: Command | null = null;

  const resize = () => {
    const w = view.clientWidth || 640, h = view.clientHeight || 360;
    renderer.setSize(w, h, false); chase.camera.aspect = w / h; chase.camera.updateProjectionMatrix();
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
      <div class="row"><span>heading to</span><b>${spec.waypoints[Math.min(insp.wp, spec.waypoints.length - 1)].id}</b></div>
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
    // A slower-than-real-time reflex still needs a visible chase view and HUD.
    // Only the pacing wait depends on whether simulation time is ahead of wall time.
    chase.update({ x: insp.x, z: insp.z, yaw: insp.yaw, speed: insp.speed, t: insp.t, drone: insp.drone,
                   cmd: insp.t < HOVER_S ? undefined : command?.cmd, collided: insp.collided, arrived: insp.arrived });
    chase.render(renderer);
    drawHud();
    while (insp.t * 1000 > performance.now() - started) await nextPaint();
  }
  drawHud();
  const r = insp.result();
  const visionRequested = (req.vision ?? true) && insp.arrived;
  if (visionRequested) visionCard(host.querySelector<HTMLElement>('aside')!, req.lead_id, insp.photo(renderer));
  const wallS = (performance.now() - started) / 1000;
  return {
    lead_id: req.lead_id, reached: r.arrived, collided: r.collided,
    found: req.person === undefined ? null : r.arrived && req.person,
    t: r.t, frames: r.frames, min_clearance_m: r.min_clearance_m,
    late_replies: 0, reflex_ok: link !== null, waypoints: r.waypoints,
    realtime_factor: +(r.t / Math.max(wallS, 1e-3)).toFixed(2),
    vision_requested: visionRequested,
  };
}
