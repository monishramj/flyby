// Dev page for the Step 7.2/7.3 panels (web/flyviz.html). It flies one closed-loop carport
// inspection (scene/inspect.ts, used read-only) against the real reflex over /ws/reflex in
// live mode (frame mode 0), in lockstep: each 96×96 frame waits for the reflex's reply, whose
// command steers the drone. The reflex sends eye.layout on connect and a viz packet at most
// 10 times per second of frame time; the eye, trace and circuit panels draw only from those
// packets (stream.ts). The camera frame shown is the exact frame sent to the reflex.
//
// URL: flyviz.html?scenario=debris&seed=0&fov=90&reflex=on&auto=1
import * as THREE from 'three';
import { DT, Inspection, MODE, ReflexLink, SCENARIOS, encodeFrame, makeSpec, type Command, type Scenario } from '../scene/inspect';
import { CircuitView, type ReadoutKind } from './circuit';
import { EyeView } from './eye';
import { VizStream } from './stream';
import { TraceView } from './trace';

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status'), flyBtn = $<HTMLButtonElement>('fly');
const scenarioSel = $<HTMLSelectElement>('scenario'), seedIn = $<HTMLInputElement>('seed'), reflexIn = $<HTMLInputElement>('reflexOn');
for (const s of SCENARIOS) scenarioSel.add(new Option(s, s));
scenarioSel.value = SCENARIOS.includes(q.get('scenario') as Scenario) ? q.get('scenario')! : 'debris';
seedIn.value = q.get('seed') ?? '0';
reflexIn.checked = q.get('reflex') !== 'off';
const fov = Number(q.get('fov') ?? 90);

const stream = new VizStream();
let eye: EyeView | null = null, trace: TraceView | null = null, circuit: CircuitView | null = null;
const measure = {
  vizReceived: 0, vizDropped: 0, layouts: 0, replies: 0, flight: null as null | Record<string, unknown>,
  rafTimes: [] as number[], panelUpdates: [] as number[], // performance.now() of each rAF / panel redraw
  readout: null as ReadoutKind, error: null as string | null,
};
(window as any).__flyviz = { measure, stream, panels: () => ({ eye: eye?.stats, trace: trace?.stats, circuit: circuit?.stats }) };

const link = new ReflexLink({
  handle(data) {
    let consumed: boolean;
    try {
      consumed = stream.handle(data);
    } catch (err) {
      console.warn('reflex viz message dropped:', err);
      measure.vizDropped += 1;
      return typeof data !== 'string';
    }
    if (consumed) {
      if (typeof data === 'string') { measure.layouts += 1; buildPanels(); } else measure.vizReceived += 1;
    }
    return consumed;
  },
});

const readoutKind: Promise<ReadoutKind> = fetch('/reflex/health')
  .then((r) => r.json()).then((h) => (h.readout === 'learned' || h.readout === 'default' ? h.readout : null))
  .catch(() => null);

async function buildPanels() {
  if (eye || !stream.layout) return;
  const layout = stream.layout;
  measure.readout = await readoutKind;
  if (eye) return;
  eye = new EyeView($('eyeHost'), layout, 380);
  trace = new TraceView($('traceHost'), stream);
  circuit = new CircuitView($('circuitHost'), layout, measure.readout);
  $('layoutInfo').textContent = `eye.layout: ${layout.node_type.length.toLocaleString()} nodes, ${layout.types.length} types, ` +
    `${layout.col_x.length} columns, θ = ${layout.S_theta ?? 'none'} · readout: ${measure.readout ?? 'unknown'}`;
  flyBtn.disabled = false;
  if (q.get('auto') === '1') fly();
}

// Panels redraw on animation frames, only when a new viz packet has arrived.
let shown: unknown = null;
function tick(now: number) {
  measure.rafTimes.push(now);
  if (measure.rafTimes.length > 20000) measure.rafTimes.splice(0, 10000);
  const h = stream.header, dev = stream.latest;
  if (h && dev && h !== shown && eye && trace && circuit) {
    shown = h;
    eye.update(dev); trace.update(); circuit.update(dev, h);
    measure.panelUpdates.push(now);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Offscreen renderer for the drone's FPV camera; the frame goes to the reflex and to #fpv.
const glCanvas = document.createElement('canvas');
glCanvas.width = glCanvas.height = 96;
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false });
const fpv = $<HTMLCanvasElement>('fpv'), fpvCtx = fpv.getContext('2d')!;
const fpvImg = fpvCtx.createImageData(96, 96);
function showFrame(px: Uint8Array) {
  for (let i = 0; i < px.length; i++) { const o = i * 4; fpvImg.data[o] = fpvImg.data[o + 1] = fpvImg.data[o + 2] = px[i]; fpvImg.data[o + 3] = 255; }
  fpvCtx.putImageData(fpvImg, 0, 0);
}

let episode = 5_000_000 + Math.floor(Math.random() * 1000) * 1000;
let flying = false;
async function fly() {
  if (flying) return;
  flying = true; flyBtn.disabled = true;
  const scenario = scenarioSel.value as Scenario, seed = Number(seedIn.value) || 0, reflexOn = reflexIn.checked;
  const insp = new Inspection(makeSpec(seed, scenario, fov));
  episode += 1;
  const t0 = performance.now();
  let replies = 0, maxLag = 0;
  measure.flight = { scenario, seed, fov, reflexOn, episode, running: true, t0 };
  try {
    while (!insp.done()) {
      // Real time at most: frame k is not sent before k·DT after the start.
      const wait = t0 + insp.k * DT * 1000 - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      maxLag = Math.max(maxLag, -wait);
      const px = insp.frame(renderer);
      showFrame(px);
      const g = insp.goal();
      const cmd: Command & { error?: string } = await link.request(encodeFrame(episode, insp.k, reflexOn, MODE.live, g.bearing, g.dist, px));
      if (cmd.error) throw new Error(cmd.error);
      replies += 1; measure.replies += 1;
      insp.step(cmd, false);
      if (insp.k % 5 === 0) status.textContent = `flying ${scenario} seed ${seed} · frame ${insp.k} · t ${insp.t.toFixed(2)} s · reply ${cmd.cmd}`;
    }
    const res = insp.result(), wall = (performance.now() - t0) / 1000;
    Object.assign(measure.flight!, { running: false, result: res, replies, wall_s: wall, reply_hz: replies / wall, max_lag_ms: maxLag });
    status.textContent = `done: ${res.collided ? 'COLLIDED' : res.arrived ? 'arrived' : 'ended'} after ${res.frames} frames (${res.t} s sim, ` +
      `${wall.toFixed(1)} s wall, ${(replies / wall).toFixed(1)} replies/s) · min clearance ${res.min_clearance_m} m`;
  } catch (err) {
    measure.error = (err as Error).message;
    status.textContent = `flight failed: ${(err as Error).message}`;
    if (measure.flight) measure.flight.running = false;
  } finally {
    insp.target.dispose();
    flying = false; flyBtn.disabled = false;
  }
}
flyBtn.onclick = () => fly();

link.open().then(() => { status.textContent = 'connected to /ws/reflex; waiting for eye.layout'; })
  .catch((err: Error) => { measure.error = err.message; status.textContent = `${err.message} — start the reflex (python -m reflex.server)`; });
