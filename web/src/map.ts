import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { batchScenery, dressScene, groundTexture, loadModels, model, type ModelName } from './models';
import { notify, store } from './store';

export const colors: Record<string, string> = { dispatch_ground_team: '#a5c3ac', reimage_zoom: '#e3b77a', close_in_inspect: '#91adc5', ignore: '#a3aaa3', dispatched: '#78a18d', awaiting_human: '#dd9975' };
export type CameraMode = 'orbit' | 'follow' | 'top';

// World (x east, y north, metres) -> three (x, up, -y): origin SW, north is -z.
const at = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
const BEACH_M = 26;
const VIS_COLOR: Record<string, string> = { visible: '#5fd08a', partial: '#e3c04a', under_structure: '#d96b5f' };

interface Ctx {
  renderer: THREE.WebGLRenderer; labels: CSS2DRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  world: THREE.Group; leadGroup: THREE.Group; truthGroup: THREE.Group; hazardGroup: THREE.Group;
  drone: THREE.Group; rotors: THREE.Object3D[]; cam: THREE.Group; lkp: THREE.LineLoop;
  coverage: { tex: THREE.DataTexture; n: number; count: number } | null;
  sectorLabels: Record<string, HTMLElement>; houseMats: THREE.Material[];
  runId: string; hazardKey: string; truthKey: string; mode: CameraMode; droneTarget: THREE.Vector3; last: THREE.Vector3;
  pins: Map<string, THREE.Group>; fetching: string; ocean: THREE.Mesh | null;
  truthVisible: boolean;
}
let ctx: Ctx | null = null;

function dispose(root: THREE.Object3D) {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (o instanceof CSS2DObject) o.element.remove();
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    if (mesh.userData.shared) return; // geometry/materials belong to the model cache
    if (!mesh.userData.sharedGeometry) mesh.geometry?.dispose();
    [mesh.material].flat().forEach(m => {
      if (m?.userData.ownedMap) (m as THREE.MeshBasicMaterial).map?.dispose();
      if (m?.userData.ownedNormal) (m as THREE.MeshStandardMaterial).normalMap?.dispose();
      m?.dispose();
    });
  });
  root.clear();
}

function label(text: string, cls: string) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`; el.textContent = text;
  return new CSS2DObject(el);
}

// A quadcopter drawn ~3x real size so it stays readable from the orbit camera.
function buildDrone() {
  const g = new THREE.Group(), rotors: THREE.Object3D[] = [];
  const shell = new THREE.MeshStandardMaterial({ color: '#e9ecea', roughness: .35, metalness: .1 });
  const carbon = new THREE.MeshStandardMaterial({ color: '#23272a', roughness: .5, metalness: .4 });
  const blade = new THREE.MeshStandardMaterial({ color: '#15181a', transparent: true, opacity: .75 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 2.2, 6, 16), shell); body.rotation.x = Math.PI / 2; body.scale.set(1.25, 1, .55); g.add(body);
  const battery = new THREE.Mesh(new THREE.BoxGeometry(1.3, .5, 1.8), carbon); battery.position.y = .55; g.add(battery);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const tip = new THREE.Vector3(sx * 2.9, 0.1, sz * 2.9), arm = new THREE.Mesh(new THREE.CylinderGeometry(.14, .18, tip.length(), 8), carbon);
    arm.position.copy(tip).multiplyScalar(.5); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().normalize()); g.add(arm);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(.38, .42, .55, 16), carbon); motor.position.copy(tip).setY(.3); g.add(motor);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(1.55, .06, 6, 40), shell); guard.rotation.x = Math.PI / 2; guard.position.copy(tip).setY(.55); g.add(guard);
    const rotor = new THREE.Group(); rotor.position.copy(tip).setY(.62);
    for (const r of [0, Math.PI]) { const b = new THREE.Mesh(new THREE.BoxGeometry(1.45, .03, .22), blade); b.position.x = Math.cos(r) * .72; b.rotation.y = r; rotor.add(b); }
    g.add(rotor); rotors.push(rotor);
    const led = new THREE.Mesh(new THREE.SphereGeometry(.16, 8, 6), new THREE.MeshBasicMaterial({ color: sz < 0 ? '#39ff8e' : '#ff4b3a' }));
    led.position.copy(tip).setY(-.1); g.add(led);
  }
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(.5, 16, 12), carbon); gimbal.position.set(0, -.55, -1); g.add(gimbal);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(.22, .22, .2, 16), new THREE.MeshStandardMaterial({ color: '#0a2340', metalness: .9, roughness: .1 }));
  lens.position.set(0, -.85, -1); g.add(lens);
  for (const sx of [-1, 1]) { const skid = new THREE.Mesh(new THREE.BoxGeometry(.12, .9, 2.4), carbon); skid.position.set(sx * .8, -.7, 0); g.add(skid); }
  // Keep the shadow map static: the drone is already visible above its camera footprint.
  g.traverse(o => { o.castShadow = false; });
  g.scale.setScalar(1.3);
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels'; labelRoot.appendChild(labels.domElement);
  // Overcast morning after the surge: low sun from the sea, haze toward the horizon.
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#9baaa7'); scene.fog = new THREE.Fog('#9baaa7', 500, 1500);
  const pmrem = new THREE.PMREMGenerator(renderer), environment = new RoomEnvironment();
  scene.environment = pmrem.fromScene(environment, 0.04).texture; scene.environmentIntensity = 0.28;
  environment.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight('#dbe6ec', '#4a4436', 0.8));
  const sun = new THREE.DirectionalLight('#fff1dc', 2.6); sun.position.set(420, 260, -60); sun.target.position.set(150, 0, -150);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.4;
  Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 900 });
  scene.add(sun, sun.target);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 4000);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.02;
  const { g: drone, rotors } = buildDrone(); scene.add(drone);
  const [world, leadGroup, truthGroup, hazardGroup] = [1, 2, 3, 4].map(() => new THREE.Group());
  scene.add(world, leadGroup, truthGroup, hazardGroup);
  const lkp = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: '#c96b43', dashSize: 3, gapSize: 2 })); lkp.visible = false; scene.add(lkp);
  ctx = { renderer, labels, scene, camera, controls, world, leadGroup, truthGroup, hazardGroup, drone, rotors, cam: new THREE.Group(), lkp,
    coverage: null, sectorLabels: {}, houseMats: [], runId: '', hazardKey: '', truthKey: '', mode: 'orbit',
    droneTarget: new THREE.Vector3(), last: new THREE.Vector3(), pins: new Map(), fetching: '', ocean: null, truthVisible: false };
  // Models stream in after first paint; the scene is rebuilt with them once they arrive.
  loadModels().then(count => {
    if (!count || !ctx) return;
    const position = ctx.camera.position.clone(), target = ctx.controls.target.clone();
    ctx.runId = ''; renderMap();
    ctx.camera.position.copy(position); ctx.controls.target.copy(target);
  });
  scene.add(ctx.cam);

  const resize = () => {
    const w = labelRoot.clientWidth, h = labelRoot.clientHeight;
    if (!w || !h) return;
    const previousFit = Math.max(1, 1.45 / camera.aspect), nextFit = Math.max(1, 1.45 / (w / h));
    if (ctx?.mode !== 'follow') camera.position.sub(controls.target).multiplyScalar(nextFit / previousFit).add(controls.target);
    renderer.setSize(w, h, false); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(labelRoot); resize();
  let inView = true;
  new IntersectionObserver(entries => { inView = entries[0].isIntersecting; }).observe(canvas);

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

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const direction = new THREE.Vector3(), shift = new THREE.Vector3();
  let previous = performance.now(), lastLabels = 0, lastDeclutter = 0;
  const loop = (now = performance.now()) => {
    requestAnimationFrame(loop);
    const dt = Math.min((now - previous) / 1000, .05); previous = now;
    if (!ctx || document.hidden || !inView || !labelRoot.clientWidth || !labelRoot.clientHeight) return;
    ctx.drone.position.lerp(ctx.droneTarget, Math.min(1, dt * 12));
    ctx.cam.position.copy(ctx.drone.position);
    const v = direction.copy(ctx.droneTarget).sub(ctx.last);
    if (v.lengthSq() > 0.01) { ctx.drone.rotation.y = Math.atan2(-v.x, -v.z); ctx.last.copy(ctx.droneTarget); }
    if (!reducedMotion.matches && store.snapshot?.state.running) ctx.rotors.forEach(r => { r.rotation.y += dt * 40; });
    const ocean = ctx.ocean;
    if (ocean) {
      // The broad water surface uses a tiny tiled normal map. No vertex uploads or normal rebuilds.
      const normal = (ocean.material as THREE.MeshStandardMaterial).normalMap;
      if (normal && !reducedMotion.matches) normal.offset.set(now * .000002, now * .000001);
    }
    if (ctx.mode === 'follow') { shift.copy(ctx.drone.position).sub(ctx.controls.target); ctx.controls.target.add(shift); ctx.camera.position.add(shift); }
    ctx.controls.update();
    ctx.renderer.render(ctx.scene, ctx.camera);
    if (now - lastLabels > 33) { ctx.labels.render(ctx.scene, ctx.camera); lastLabels = now; }
    if (now - lastDeclutter > 120) {
      // Resolve label overlap in screen space. Selected leads and reported hazards take priority.
      const occupied: DOMRect[] = [];
      for (const selector of ['.pin', '.hazard', '.sector', '.truth', '.landmark']) {
        ctx.labels.domElement.querySelectorAll<HTMLElement>(selector).forEach(el => {
          const box = el.getBoundingClientRect();
          const overlap = occupied.some(b => box.left < b.right + 6 && box.right > b.left - 6 && box.top < b.bottom + 3 && box.bottom > b.top - 3);
          el.style.visibility = overlap ? 'hidden' : '';
          if (!overlap && box.width && box.height) occupied.push(box);
        });
      }
      lastDeclutter = now;
    }
  };
  loop();
  return true;
}

export function setCameraMode(mode: CameraMode) {
  if (!ctx) return;
  const s = store.snapshot, area = s?.scene.area_m ?? 300, centre = at(area / 2, area / 2);
  ctx.mode = mode;
  if (mode === 'top') { ctx.controls.target.copy(centre); ctx.camera.position.set(centre.x, area * 1.4, centre.z + 0.01); }
  else if (mode === 'follow') { ctx.controls.target.copy(ctx.drone.position); ctx.camera.position.copy(ctx.drone.position).add(new THREE.Vector3(0, 35, 65)); }
  else { ctx.controls.target.copy(centre); ctx.camera.position.set(-area * 0.2, area * 0.76, centre.z + area * 0.73); }
  if (mode !== 'follow') ctx.camera.position.sub(centre).multiplyScalar(Math.max(1, 1.45 / ctx.camera.aspect)).add(centre);
}

/** Read-only renderer counters for local performance checks. */
export function getRenderStats() {
  if (!ctx) return null;
  return { calls: ctx.renderer.info.render.calls, triangles: ctx.renderer.info.render.triangles,
    geometries: ctx.renderer.info.memory.geometries, textures: ctx.renderer.info.memory.textures,
    pixelRatio: ctx.renderer.getPixelRatio() };
}

function waterNormal() {
  const n = 64, pixels = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    pixels[i] = 128 + Math.sin(x / n * Math.PI * 8 + Math.sin(y / n * Math.PI * 4)) * 26;
    pixels[i + 1] = 128 + Math.cos(y / n * Math.PI * 12 + x / n * Math.PI * 4) * 20;
    pixels[i + 2] = 250; pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, n, n);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.repeat.set(16, 16); texture.needsUpdate = true;
  return texture;
}

function buildWorld(c: Ctx, s: NonNullable<typeof store.snapshot>) {
  dispose(c.world); dispose(c.leadGroup); dispose(c.truthGroup); dispose(c.hazardGroup);
  c.renderer.shadowMap.needsUpdate = true;
  c.pins.clear(); c.sectorLabels = {}; c.houseMats = []; c.truthKey = ''; c.hazardKey = ''; c.coverage = null;
  const { scene, config } = s, area = scene.area_m, cell = config.COVERAGE_CELL_M;
  const margin = 80, painted = groundTexture(scene, s.seed, margin, BEACH_M);
  const limit = painted?.limit ?? (() => area * .25);
  // Land stops at the shoreline (BEACH_M past the area edge); the sea fills everything east of it.
  const shore = area + BEACH_M;
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: '#56603f', roughness: 1 }));
  outer.rotation.x = -Math.PI / 2; outer.position.set(shore - 1200 - margin, -0.08, -area / 2); outer.receiveShadow = true; c.world.add(outer);
  const land = new THREE.Mesh(new THREE.PlaneGeometry(area + margin * 2, area + margin * 2), new THREE.MeshStandardMaterial({ map: painted?.tex ?? null, color: painted ? '#ffffff' : '#56603f', roughness: .95, alphaTest: .5 }));
  land.rotation.x = -Math.PI / 2; land.position.set(area / 2, 0, -area / 2); land.receiveShadow = true; c.world.add(land);
  land.material.userData.ownedMap = true;

  const n = Math.ceil(area / cell), data = new Uint8Array(n * n * 4);
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
  const cov = new THREE.Mesh(new THREE.PlaneGeometry(area, area), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  cov.rotation.x = -Math.PI / 2; cov.position.set(area / 2, 0.1, -area / 2); cov.renderOrder = 1; c.world.add(cov);
  cov.material.userData.ownedMap = true;
  c.coverage = { tex, n, count: -1 };

  const size = area / scene.sector_grid, grid: THREE.Vector3[] = [];
  for (let i = 0; i <= scene.sector_grid; i++) { grid.push(at(i * size, 0, 0.2), at(i * size, area, 0.2), at(0, i * size, 0.2), at(area, i * size, 0.2)); }
  c.world.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), new THREE.LineBasicMaterial({ color: '#8fa38f', transparent: true, opacity: 0.45 })));
  for (let row = 0; row < scene.sector_grid; row++) for (let col = 0; col < scene.sector_grid; col++) {
    const id = `S${row * scene.sector_grid + col + 1}`, l = label(id, 'sector');
    l.position.copy(at(col * size + 12, (row + 1) * size - 12, 1)); c.world.add(l); c.sectorLabels[id] = l.element;
  }
  c.ocean = null;
  scene.water.forEach(w => {
    if (w.kind === 'ocean') {
      // The sea runs off to the horizon; the server rectangle only marks where it starts.
      const width = w.width + 900, height = w.height + 1200, sea = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
        new THREE.MeshStandardMaterial({ color: '#42636a', roughness: .55, metalness: .15, normalMap: waterNormal(), normalScale: new THREE.Vector2(.16, .16) }));
      sea.material.userData.ownedNormal = true;
      sea.rotation.x = -Math.PI / 2; sea.position.copy(at(shore - 20 + width / 2, w.y + w.height / 2, -0.45)); sea.receiveShadow = true;
      c.world.add(sea); c.ocean = sea;
      const foam = new THREE.Mesh(new THREE.PlaneGeometry(4, w.height + 400), new THREE.MeshBasicMaterial({ color: '#e8efe9', transparent: true, opacity: .6, depthWrite: false }));
      foam.rotation.x = -Math.PI / 2; foam.position.copy(at(shore + 2, w.y + w.height / 2, 0.05)); c.world.add(foam);
      return;
    }
    // Standing floodwater: brown, sediment-laden, still.
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(w.width, w.height), new THREE.MeshStandardMaterial({ color: '#55625a', roughness: .06, metalness: .6, transparent: true, opacity: .85 }));
    pool.rotation.x = -Math.PI / 2; pool.position.copy(at(w.x + w.width / 2, w.y + w.height / 2, 0.45)); pool.receiveShadow = true; c.world.add(pool);
  });
  const scenery = new THREE.Group(); c.world.add(scenery);
  const dressed = dressScene(scene, s.seed, scenery, limit);
  if (dressed) batchScenery(scenery);
  const wall = new THREE.MeshStandardMaterial({ color: '#c4c1aa' }), roof = new THREE.MeshStandardMaterial({ color: '#8f5a48' }), post = new THREE.MeshStandardMaterial({ color: '#aeab95' });
  [wall, roof, post].forEach(m => { m.transparent = true; }); c.houseMats = dressed ?? [wall, roof, post];
  if (!dressed) scene.houses.forEach(h => {
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
  if (!dressed) scene.trees.forEach(t => {
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
  if (c.truthVisible !== store.showTruth) {
    c.truthVisible = store.showTruth;
    c.renderer.shadowMap.needsUpdate = true;
  }
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
    const person = model((['manA', 'womanB', 'manC'] as ModelName[])[Number(p.id.slice(1)) % 3], 1.75, 'height');
    const body = person ?? new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.1, 4, 8), new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.4 }));
    body.position.copy(at(p.x, p.y, person ? 0.1 : 1.2)); if (person) person.scale.setScalar(2.2); c.truthGroup.add(body);
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
      data[i] = 127; data[i + 1] = 174; data[i + 2] = 156; data[i + 3] = 43;
    });
    tex.needsUpdate = true; c.coverage.count = state.coverage_cells.length;
  }

  Object.entries(c.sectorLabels).forEach(([id, el]) => el.classList.toggle('crit', incident.sector_priority[id] === 'critical'));

  const ids = new Set(leads.map(l => l.lead_id));
  c.pins.forEach((pin, id) => { if (!ids.has(id)) { c.leadGroup.remove(pin); dispose(pin); c.pins.delete(id); } });
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
