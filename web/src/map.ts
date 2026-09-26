import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { notify, store } from './store';

export const colors: Record<string, string> = { dispatch_ground_team: '#327c65', reimage_zoom: '#bb913f', close_in_inspect: '#5f76b0', ignore: '#79847f', dispatched: '#195846', awaiting_human: '#cf653c' };
export type CameraMode = 'orbit' | 'follow' | 'top';

// World (x east, y north, metres) -> three (x, up, -y): origin SW, north is -z.
const at = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
const VIS_COLOR: Record<string, string> = { visible: '#5fd08a', partial: '#e3c04a', under_structure: '#d96b5f' };

interface Ctx {
  renderer: THREE.WebGLRenderer; labels: CSS2DRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  world: THREE.Group; leadGroup: THREE.Group; truthGroup: THREE.Group; hazardGroup: THREE.Group;
  drone: THREE.Group; rotors: THREE.Object3D[]; cam: THREE.Group; lkp: THREE.LineLoop;
  coverage: { tex: THREE.DataTexture; n: number; count: number } | null;
  sectorLabels: Record<string, HTMLElement>; houseMats: THREE.Material[];
  runId: string; hazardKey: string; truthKey: string; mode: CameraMode; droneTarget: THREE.Vector3; last: THREE.Vector3;
  pins: Map<string, THREE.Group>; fetching: string;
}
let ctx: Ctx | null = null;

function dispose(root: THREE.Object3D) {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    [mesh.material].flat().forEach(m => m?.dispose());
  });
  root.clear();
}

function label(text: string, cls: string) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`; el.textContent = text;
  return new CSS2DObject(el);
}

function buildDrone() {
  const g = new THREE.Group(), rotors: THREE.Object3D[] = [];
  const dark = new THREE.MeshStandardMaterial({ color: '#233d33' }), light = new THREE.MeshStandardMaterial({ color: '#9fd4bf' });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 4), dark));
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.25, 0.3), dark);
    arm.position.set(sx * 1.2, 0.1, sz * 1.1); arm.rotation.y = Math.atan2(-sz * 2.2, sx * 2.4); g.add(arm);
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.08, 20), light);
    rotor.position.set(sx * 2.4, 0.4, sz * 2.2); (rotor.material as THREE.MeshStandardMaterial).transparent = true; (rotor.material as THREE.MeshStandardMaterial).opacity = 0.55;
    g.add(rotor); rotors.push(rotor);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.6, 8), new THREE.MeshStandardMaterial({ color: '#cf653c' }));
  nose.rotation.x = -Math.PI / 2; nose.position.z = -2.6; g.add(nose);
  g.scale.setScalar(1.6);
  return { g, rotors };
}

function buildCamera(altitude: number, footprint: number) {
  const h = footprint / 2, g = new THREE.Group();
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => new THREE.Vector3(x, 0.15 - altitude, z));
  const apex = new THREE.Vector3(0, 0, 0), pts: THREE.Vector3[] = [];
  corners.forEach((c, i) => { pts.push(apex, c, c, corners[(i + 1) % 4]); });
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#cf653c', transparent: true, opacity: 0.85 })));
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(footprint, footprint), new THREE.MeshBasicMaterial({ color: '#cf653c', transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
  quad.rotation.x = -Math.PI / 2; quad.position.y = 0.2 - altitude; g.add(quad);
  return g;
}

export function mountMap(canvas: HTMLCanvasElement, labelRoot: HTMLElement, onPick: (leadId: string) => void): boolean {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); }
  catch { labelRoot.innerHTML = '<p class="nogl">3D view unavailable: this browser has no WebGL.</p>'; return false; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels'; labelRoot.appendChild(labels.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#0d1417');
  scene.add(new THREE.HemisphereLight('#dfeee8', '#25332c', 1.5));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(120, 260, 80); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 4000);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.02;
  const { g: drone, rotors } = buildDrone(); scene.add(drone);
  const [world, leadGroup, truthGroup, hazardGroup] = [1, 2, 3, 4].map(() => new THREE.Group());
  scene.add(world, leadGroup, truthGroup, hazardGroup);
  const lkp = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: '#c96b43', dashSize: 3, gapSize: 2 })); lkp.visible = false; scene.add(lkp);
  ctx = { renderer, labels, scene, camera, controls, world, leadGroup, truthGroup, hazardGroup, drone, rotors, cam: new THREE.Group(), lkp,
    coverage: null, sectorLabels: {}, houseMats: [], runId: '', hazardKey: '', truthKey: '', mode: 'orbit',
    droneTarget: new THREE.Vector3(), last: new THREE.Vector3(), pins: new Map(), fetching: '' };
  scene.add(ctx.cam);

  const resize = () => {
    const w = labelRoot.clientWidth, h = labelRoot.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(labelRoot); resize();

  let down = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), ctx.camera);
    const hit = ray.intersectObjects(ctx.leadGroup.children, true)[0];
    let node: THREE.Object3D | null = hit?.object ?? null;
    while (node && !node.userData.leadId) node = node.parent;
    if (node) onPick(node.userData.leadId);
  });

  const clock = new THREE.Clock();
  const loop = () => {
    requestAnimationFrame(loop);
    if (!ctx || !labelRoot.clientWidth) return;
    const dt = clock.getDelta();
    ctx.drone.position.lerp(ctx.droneTarget, Math.min(1, dt * 12));
    ctx.cam.position.copy(ctx.drone.position);
    const v = ctx.droneTarget.clone().sub(ctx.last);
    if (v.lengthSq() > 0.01) { ctx.drone.rotation.y = Math.atan2(-v.x, -v.z); ctx.last.copy(ctx.droneTarget); }
    ctx.rotors.forEach(r => { r.rotation.y += dt * 40; });
    if (ctx.mode === 'follow') { const shift = ctx.drone.position.clone().sub(ctx.controls.target); ctx.controls.target.add(shift); ctx.camera.position.add(shift); }
    ctx.controls.update();
    ctx.renderer.render(ctx.scene, ctx.camera); ctx.labels.render(ctx.scene, ctx.camera);
  };
  loop();
  return true;
}

export function setCameraMode(mode: CameraMode) {
  if (!ctx) return;
  const s = store.snapshot, area = s?.scene.area_m ?? 300, centre = at(area / 2, area / 2);
  ctx.mode = mode;
  if (mode === 'top') { ctx.controls.target.copy(centre); ctx.camera.position.set(centre.x, area * 1.15, centre.z + 0.01); }
  else if (mode === 'follow') { ctx.controls.target.copy(ctx.drone.position); ctx.camera.position.copy(ctx.drone.position).add(new THREE.Vector3(0, 35, 65)); }
  else { ctx.controls.target.copy(centre); ctx.camera.position.set(centre.x, area * 0.7, centre.z + area * 0.95); }
}

function buildWorld(c: Ctx, s: NonNullable<typeof store.snapshot>) {
  dispose(c.world); dispose(c.leadGroup); dispose(c.truthGroup); dispose(c.hazardGroup);
  c.pins.clear(); c.sectorLabels = {}; c.houseMats = []; c.truthKey = ''; c.hazardKey = ''; c.coverage = null;
  const { scene, config } = s, area = scene.area_m, cell = config.COVERAGE_CELL_M;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(area + 160, area + 160), new THREE.MeshStandardMaterial({ color: '#2b3a30' }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(area / 2, -0.05, -area / 2); c.world.add(ground);
  const field = new THREE.Mesh(new THREE.PlaneGeometry(area, area), new THREE.MeshStandardMaterial({ color: '#3a4d3d' }));
  field.rotation.x = -Math.PI / 2; field.position.set(area / 2, 0, -area / 2); c.world.add(field);

  const n = Math.ceil(area / cell), data = new Uint8Array(n * n * 4);
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
  const cov = new THREE.Mesh(new THREE.PlaneGeometry(area, area), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  cov.rotation.x = -Math.PI / 2; cov.position.set(area / 2, 0.1, -area / 2); cov.renderOrder = 1; c.world.add(cov);
  c.coverage = { tex, n, count: -1 };

  const size = area / scene.sector_grid, grid: THREE.Vector3[] = [];
  for (let i = 0; i <= scene.sector_grid; i++) { grid.push(at(i * size, 0, 0.2), at(i * size, area, 0.2), at(0, i * size, 0.2), at(area, i * size, 0.2)); }
  c.world.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), new THREE.LineBasicMaterial({ color: '#8fa38f', transparent: true, opacity: 0.45 })));
  for (let row = 0; row < scene.sector_grid; row++) for (let col = 0; col < scene.sector_grid; col++) {
    const id = `S${row * scene.sector_grid + col + 1}`, l = label(id, 'sector');
    l.position.copy(at(col * size + 12, (row + 1) * size - 12, 1)); c.world.add(l); c.sectorLabels[id] = l.element;
  }
  scene.water.forEach(w => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.width, 0.6, w.height), new THREE.MeshStandardMaterial({ color: '#3f7f9a', transparent: true, opacity: 0.8 }));
    m.position.copy(at(w.x + w.width / 2, w.y + w.height / 2, 0.3)); c.world.add(m);
  });
  const wall = new THREE.MeshStandardMaterial({ color: '#c4c1aa' }), roof = new THREE.MeshStandardMaterial({ color: '#8f5a48' }), post = new THREE.MeshStandardMaterial({ color: '#aeab95' });
  [wall, roof, post].forEach(m => { m.transparent = true; }); c.houseMats = [wall, roof, post];
  scene.houses.forEach(h => {
    const centre = at(h.x, h.y);
    if (h.kind === 'carport') {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(h.width, 0.6, h.height), post); slab.position.copy(centre).setY(4); c.world.add(slab);
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 4, 8), post);
        p.position.set(centre.x + dx * (h.width / 2 - 0.6), 2, centre.z + dz * (h.height / 2 - 0.6)); c.world.add(p);
      }
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(h.width, 6, h.height), wall); box.position.copy(centre).setY(3); c.world.add(box);
      const geo = new THREE.ConeGeometry(1, 4, 4); geo.rotateY(Math.PI / 4);
      const top = new THREE.Mesh(geo, roof); top.scale.set(h.width * 0.7071, 1, h.height * 0.7071); top.position.copy(centre).setY(8); c.world.add(top);
    }
  });
  const trunk = new THREE.MeshStandardMaterial({ color: '#5b4633' }), leaves = new THREE.MeshStandardMaterial({ color: '#4f8a5b' });
  scene.trees.forEach(t => {
    const p = at(t.x, t.y), h = t.radius * 1.5;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, h, 8), trunk); stem.position.copy(p).setY(h / 2); c.world.add(stem);
    const top = new THREE.Mesh(new THREE.ConeGeometry(t.radius, t.radius * 2.6, 10), leaves); top.position.copy(p).setY(h + t.radius * 1.1); c.world.add(top);
  });
  Object.entries(scene.gazetteer).forEach(([name, point]) => {
    const l = label(point.label || name.replaceAll('_', ' '), 'landmark'); l.position.copy(at(point.x, point.y, 12)); c.world.add(l);
  });
  c.world.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(config.SWEEP_PATH.map(p => at(p.x, p.y, 0.3))), new THREE.LineBasicMaterial({ color: '#7fc3ac', transparent: true, opacity: 0.35 })));

  dispose(c.cam); c.cam.add(buildCamera(config.ALT_M, config.FOOTPRINT_M));
  const start = at(s.state.drone.x, s.state.drone.y, config.ALT_M);
  c.drone.position.copy(start); c.droneTarget.copy(start); c.last.copy(start);
  setCameraMode(c.mode);
}

function syncTruth(c: Ctx, s: NonNullable<typeof store.snapshot>) {
  c.houseMats.forEach(m => { m.opacity = store.showTruth ? 0.3 : 1; });
  const want = store.showTruth && store.truth?.run_id === s.run_id ? s.run_id : '';
  if (store.showTruth && !want && c.fetching !== s.run_id) {
    c.fetching = s.run_id;
    fetch('/api/truth').then(r => r.json()).then(body => { store.truth = body; notify('truth'); }).catch(() => { c.fetching = ''; store.showTruth = false; notify('truth'); });
  }
  if (c.truthKey === want) return;
  dispose(c.truthGroup); c.truthKey = want;
  if (!want || !store.truth) return;
  store.truth.subjects.forEach(p => {
    const colour = VIS_COLOR[p.visibility] ?? '#fff';
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.1, 4, 8), new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.4 }));
    body.position.copy(at(p.x, p.y, 1.2)); c.truthGroup.add(body);
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.2, 24), new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.copy(at(p.x, p.y, 0.25)); c.truthGroup.add(ring);
    const l = label(`${p.id} · ${p.visibility.replace('_', ' ')}`, 'truth'); l.position.copy(at(p.x, p.y, 5)); c.truthGroup.add(l);
  });
  store.truth.decoys.forEach(d => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial({ color: '#9aa39f' }));
    box.position.copy(at(d.x, d.y, 0.7)); c.truthGroup.add(box);
    const l = label(`${d.id} · ${d.type.replaceAll('_', ' ')}`, 'truth decoy'); l.position.copy(at(d.x, d.y, 4)); c.truthGroup.add(l);
  });
}

function makePin(leadId: string) {
  const g = new THREE.Group(); g.userData.leadId = leadId;
  const mat = new THREE.MeshStandardMaterial({ color: '#fff' });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(3, 11, 12), mat); cone.rotation.x = Math.PI; cone.position.y = 5.5; g.add(cone);
  const head = new THREE.Mesh(new THREE.SphereGeometry(3.4, 16, 12), mat); head.position.y = 12.5; g.add(head);
  const l = label(leadId, 'pin'); l.position.y = 19; l.visible = false; g.add(l);
  g.userData.mat = mat; g.userData.label = l;
  return g;
}

export function renderMap() {
  const c = ctx, s = store.snapshot;
  if (!c || !s) return;
  if (c.runId !== s.run_id) { buildWorld(c, s); c.runId = s.run_id; }
  const { state, incident, leads, config } = s;

  c.droneTarget.copy(at(state.drone.x, state.drone.y, config.ALT_M));

  if (c.coverage && c.coverage.count !== state.coverage_cells.length) {
    const { tex, n } = c.coverage, data = tex.image.data as Uint8Array, cell = config.COVERAGE_CELL_M;
    data.fill(0);
    state.coverage_cells.forEach(k => {
      const col = Math.min(n - 1, Math.floor(k.x / cell)), row = Math.min(n - 1, Math.floor(k.y / cell)), i = (row * n + col) * 4;
      data[i] = 84; data[i + 1] = 200; data[i + 2] = 140; data[i + 3] = 90;
    });
    tex.needsUpdate = true; c.coverage.count = state.coverage_cells.length;
  }

  Object.entries(c.sectorLabels).forEach(([id, el]) => el.classList.toggle('crit', incident.sector_priority[id] === 'critical'));

  const ids = new Set(leads.map(l => l.lead_id));
  c.pins.forEach((pin, id) => { if (!ids.has(id)) { c.leadGroup.remove(pin); c.pins.delete(id); } });
  leads.forEach(lead => {
    let pin = c.pins.get(lead.lead_id);
    if (!pin) { pin = makePin(lead.lead_id); c.pins.set(lead.lead_id, pin); c.leadGroup.add(pin); }
    const selected = store.selected === lead.lead_id;
    pin.position.copy(at(lead.x, lead.y)); pin.scale.setScalar(selected ? 1.6 : 1);
    (pin.userData.mat as THREE.MeshStandardMaterial).color.set(colors[lead.status] || colors[lead.decision?.action || 'ignore']);
    (pin.userData.label as CSS2DObject).visible = selected;
  });

  const hazardKey = JSON.stringify(incident.hazards);
  if (c.hazardKey !== hazardKey) {
    dispose(c.hazardGroup); c.hazardKey = hazardKey;
    incident.hazards.forEach(h => {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3.5, 9, 4), new THREE.MeshStandardMaterial({ color: '#e07a3a', emissive: '#a34a17' }));
      cone.position.copy(at(h.x, h.y, 4.5)); c.hazardGroup.add(cone);
      const l = label(h.type.replaceAll('_', ' '), 'hazard'); l.position.copy(at(h.x, h.y, 12)); c.hazardGroup.add(l);
    });
  }
  const lk = incident.last_known_point;
  c.lkp.visible = Boolean(lk);
  if (lk) {
    c.lkp.geometry.setFromPoints(Array.from({ length: 48 }, (_, i) => at(lk.x + 18 * Math.cos(i / 48 * Math.PI * 2), lk.y + 18 * Math.sin(i / 48 * Math.PI * 2), 0.4)));
    c.lkp.computeLineDistances();
  }
  syncTruth(c, s);
}
