// Live carport inspection: chase view, the drone's camera, and the reflex state.
// Live mode never waits on the reflex: each 20 ms tick uses the newest reply.
import * as THREE from 'three';
import { DT, FRAME_R, HOVER_S, Inspection, MODE, ReflexLink, SCENARIOS, encodeFrame, makeSpec, type Command, type Scenario } from './scene/inspect';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>('view');
const fpvCanvas = $<HTMLCanvasElement>('fpv');
const fpvCtx = fpvCanvas.getContext('2d')!;
const hud = $<HTMLDivElement>('hud');
const scenarioSel = $<HTMLSelectElement>('scenario');
for (const s of SCENARIOS) scenarioSel.add(new Option(s.replace('_', ' '), s));

const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
const chase = new THREE.PerspectiveCamera(55, 1, 0.05, 100);
const fpvImage = new ImageData(FRAME_R, FRAME_R);
let insp: Inspection | null = null;
let link: ReflexLink | null = null;
let episode = 1;
let running = false, acc = 0, last = 0, stale = 0, theta = NaN;
let command: Command | null = null;

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  chase.aspect = w / h; chase.updateProjectionMatrix();
}
addEventListener('resize', resize);

function drawFpv(pixels: Uint8Array) {
  for (let i = 0; i < pixels.length; i++) {
    const j = i * 4; fpvImage.data[j] = fpvImage.data[j + 1] = fpvImage.data[j + 2] = pixels[i]; fpvImage.data[j + 3] = 255;
  }
  const off = new OffscreenCanvas(FRAME_R, FRAME_R);
  off.getContext('2d')!.putImageData(fpvImage, 0, 0);
  fpvCtx.imageSmoothingEnabled = false;
  fpvCtx.drawImage(off, 0, 0, fpvCanvas.width, fpvCanvas.height);
}

function showHud() {
  if (!insp) return;
  const c = command;
  const state = insp.collided ? 'COLLIDED' : insp.arrived ? 'ARRIVED' : insp.t < HOVER_S ? 'hover' : (c?.cmd ?? '—').replace('_', ' ');
  const S = c?.S ?? null;
  const pct = S === null || !isFinite(theta) ? 0 : Math.min(100, (S / (theta * 1.5)) * 100);
  hud.innerHTML = `
    <div class="state ${insp.collided ? 'bad' : insp.arrived ? 'good' : c?.cmd && c.cmd !== 'none' ? 'act' : ''}">${state}</div>
    <div class="row"><span>t</span><b>${insp.t.toFixed(2)} s</b></div>
    <div class="row"><span>speed</span><b>${insp.speed.toFixed(2)} m/s</b></div>
    <div class="row"><span>goal</span><b>${insp.goal().dist.toFixed(2)} m</b></div>
    <div class="row"><span>looming S</span><b>${S === null ? '—' : S.toFixed(2)}</b></div>
    <div class="bar"><i style="width:${pct}%"></i><em style="left:${(1 / 1.5) * 100}%"></em></div>
    <div class="row"><span>dLR</span><b>${c?.dLR == null ? '—' : c.dLR.toFixed(2)}</b></div>
    <div class="row"><span>late replies</span><b>${stale}</b></div>
    <div class="row"><span>clearance min</span><b>${isFinite(insp.minClearance) ? insp.minClearance.toFixed(2) + ' m' : '—'}</b></div>`;
}

function tick(now: number) {
  if (!insp) return;
  acc += Math.min(100, now - last); last = now;
  while (running && acc >= DT * 1000) {
    acc -= DT * 1000;
    const reply = link?.latest;
    if (reply && typeof reply.k === 'number') {
      if (reply.k !== insp.k - 1 && insp.k > 0) stale += 1;
      command = reply as Command;
    }
    insp.step(command, false);
    const pixels = insp.frame(renderer);
    drawFpv(pixels);
    const g = insp.goal();
    link?.request(encodeFrame(episode, insp.k, $<HTMLInputElement>('reflex').checked, MODE.live, g.bearing, g.dist, pixels));
    if (insp.done()) { running = false; $<HTMLButtonElement>('start').textContent = 'Fly again'; }
  }
  const fwd = new THREE.Vector3(Math.sin(insp.yaw), 0, -Math.cos(insp.yaw));
  chase.position.set(insp.x - fwd.x * 3.2, 2.6, insp.z - fwd.z * 3.2);
  chase.lookAt(insp.x + fwd.x * 2, 1.0, insp.z + fwd.z * 2);
  renderer.setRenderTarget(null);
  renderer.render(insp.scene, chase);
  showHud();
  requestAnimationFrame(tick);
}

async function start() {
  const spec = makeSpec(Number($<HTMLInputElement>('seed').value) || 0, scenarioSel.value as Scenario, Number($<HTMLSelectElement>('fov').value));
  insp = new Inspection(spec);
  (insp.drone.getObjectByName('body') as THREE.Mesh).visible = true;
  command = null; stale = 0; episode += 1;
  $<HTMLParagraphElement>('error').textContent = '';
  try {
    if (!link) {
      link = new ReflexLink(); await link.open();
      const health = await fetch('http://127.0.0.1:8001/health').then((r) => r.json()).catch(() => null);
      theta = health?.theta ?? NaN;
    }
  } catch (e) {
    link = null;
    $<HTMLParagraphElement>('error').textContent = `Reflex not reachable. Start it with: uv run --extra fly python -m reflex.server`;
  }
  running = true; last = performance.now(); acc = 0;
  $<HTMLButtonElement>('start').textContent = 'Restart';
  resize();
  requestAnimationFrame(tick);
}

$<HTMLButtonElement>('start').addEventListener('click', start);
resize();
