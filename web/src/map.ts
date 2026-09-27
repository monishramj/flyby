import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { dressScene, groundTexture, loadModels, model, type ModelName } from './models';
import { notify, store } from './store';

export const colors: Record<string, string> = { dispatch_ground_team: '#859966', reimage_zoom: '#dbbc7f', close_in_inspect: '#7fbbb3', ignore: '#859289', dispatched: '#56663f', awaiting_human: '#e69875' };
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
  pins: Map<string, THREE.Group>; fetching: string; ocean: THREE.Mesh | null; foam: THREE.Mesh[]; clouds: THREE.Texture | null;
}
let ctx: Ctx | null = null;

function dispose(root: THREE.Object3D) {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (mesh.userData.shared) return; // geometry/materials belong to the model cache
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

// A quadcopter drawn ~3x real size so it stays readable from the orbit camera.
function buildDrone() {
  const g = new THREE.Group(), rotors: THREE.Object3D[] = [];
  const shell = new THREE.MeshStandardMaterial({ color: '#3f7fe0', roughness: .3, metalness: .15 });
  const carbon = new THREE.MeshStandardMaterial({ color: '#23272a', roughness: .5, metalness: .4 });
  const blade = new THREE.MeshStandardMaterial({ color: '#15181a', transparent: true, opacity: .75 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 2.2, 6, 16), shell); body.rotation.x = Math.PI / 2; body.scale.set(1.25, 1, .55); g.add(body);
  const battery = new THREE.Mesh(new THREE.BoxGeometry(1.3, .5, 1.8), carbon); battery.position.set(0, .55, .75); battery.scale.z = .75; g.add(battery);
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
  // Quirky face on the flat of the nose: one big eye, one small, a lopsided grin and a blush.
  const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .3 }), ink = new THREE.MeshBasicMaterial({ color: '#0b1220' });
  for (const [x, r] of [[-.42, .24], [.4, .15]]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), white); eye.position.set(x, .5, -.35); eye.scale.y = .6; g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(r * .5, 12, 8), ink); pupil.position.set(x + (x < 0 ? .05 : -.03), .5 + r * .45, -.35 - r * .35); g.add(pupil);
  }
  const grin = new THREE.Mesh(new THREE.TorusGeometry(.42, .055, 8, 24, Math.PI), ink);
  grin.rotation.x = Math.PI / 2; grin.rotation.z = .18; grin.position.set(.02, .5, -.78); grin.scale.set(1, 1, .5); g.add(grin);
  const blush = new THREE.MeshBasicMaterial({ color: '#ff9db1' });
  for (const x of [-.85, .8]) { const dot = new THREE.Mesh(new THREE.CircleGeometry(.14, 12), blush); dot.rotation.x = -Math.PI / 2; dot.position.set(x, .47, -.75); g.add(dot); }
  g.traverse(o => { o.castShadow = true; });
  g.scale.setScalar(1.3);
  return { g, rotors };
}

/** A drifting high cloud deck: soft blobs painted once, tiled, scrolled slowly. */
function cloudLayer(scene: THREE.Scene) {
  const size = 512, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  let a = 7; const rand = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  for (let i = 0; i < 70; i++) {
    const x = rand() * size, y = rand() * size, r = 24 + rand() * 60;
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grad.addColorStop(0, 'rgba(255,255,255,.34)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
  const tex = new THREE.CanvasTexture(canvas); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(5, 5); tex.colorSpace = THREE.SRGBColorSpace;
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: .9 }));
  deck.rotation.x = Math.PI / 2; deck.position.set(150, 1400, -150); deck.renderOrder = -1; scene.add(deck);
  return tex;
}

/** Wave normals tiled over the sea: sums of sines, turned into a tangent-space normal map. */
function waterNormals() {
  const n = 128, canvas = document.createElement('canvas'); canvas.width = canvas.height = n;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(n, n), h = (x: number, y: number) => {
    const u = x / n * Math.PI * 2, v = y / n * Math.PI * 2;
    return Math.sin(u * 2 + Math.sin(v * 3) * .8) * .5 + Math.sin(v * 3 + u) * .35 + Math.sin(u * 5 - v * 4) * .18;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1), k = 1 / Math.hypot(dx * 1.6, dy * 1.6, 1), i = (y * n + x) * 4;
    img.data[i] = (-dx * 1.6 * k * .5 + .5) * 255; img.data[i + 1] = (-dy * 1.6 * k * .5 + .5) * 255; img.data[i + 2] = (k * .5 + .5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; return tex;
}

/** Foam lace for the surf line: bright at the waterline, breaking into flecks seaward. */
function foamTexture() {
  const w = 128, h = 512, canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return null;
  let a = 11; const rand = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  for (let i = 0; i < 900; i++) {
    const t = Math.pow(rand(), 1.8), x = t * w, y = rand() * h, r = 1 + rand() * 4.5 * (1 - t * .6);
    g.fillStyle = `rgba(255,255,255,${(.25 + rand() * .6) * (1 - t * .7)})`; g.beginPath(); g.ellipse(x, y, r * 1.6, r, 0, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(canvas); tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; return tex;
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
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels'; labelRoot.appendChild(labels.domElement);
  // Overcast morning after the surge: low sun from the sea, haze toward the horizon.
  const sunDir = new THREE.Vector3(420, 200, -60).normalize();
  const skySun = new THREE.Vector3(420, 420, -60).normalize();  // painted higher than the light so the horizon stays blue, not blown out
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog('#c3d3d9', 500, 3200);
  const makeSky = () => {
    const sky = new Sky(); sky.scale.setScalar(12000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.5; u.rayleigh.value = 2.4; u.mieCoefficient.value = .0015; u.mieDirectionalG.value = .7;
    u.sunPosition.value.copy(skySun).multiplyScalar(450000);
    return sky;
  };
  scene.add(makeSky());
  // The same sky, baked once, lights and reflects off the water, the drone and the houses.
  const skyScene = new THREE.Scene(); skyScene.add(makeSky());
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(skyScene, 0.02).texture; scene.environmentIntensity = 0.26;
  scene.add(new THREE.HemisphereLight('#dbe6ec', '#4a4436', 0.8));
  const sun = new THREE.DirectionalLight('#fff1dc', 2.6); sun.position.copy(sunDir).multiplyScalar(450); sun.target.position.set(150, 0, -150);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.4;
  Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 900 });
  scene.add(sun, sun.target);
  const camera = new THREE.PerspectiveCamera(50, 1, 2, 24000);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.02;
  const { g: drone, rotors } = buildDrone(); scene.add(drone);
  const [world, leadGroup, truthGroup, hazardGroup] = [1, 2, 3, 4].map(() => new THREE.Group());
  scene.add(world, leadGroup, truthGroup, hazardGroup);
  const lkp = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: '#c96b43', dashSize: 3, gapSize: 2 })); lkp.visible = false; scene.add(lkp);
  ctx = { renderer, labels, scene, camera, controls, world, leadGroup, truthGroup, hazardGroup, drone, rotors, cam: new THREE.Group(), lkp,
    coverage: null, sectorLabels: {}, houseMats: [], runId: '', hazardKey: '', truthKey: '', mode: 'orbit',
    droneTarget: new THREE.Vector3(), last: new THREE.Vector3(), pins: new Map(), fetching: '', ocean: null, foam: [], clouds: null };
  // Models stream in after first paint; the scene is rebuilt with them once they arrive.
  loadModels().then(count => { if (count && ctx) { ctx.runId = ''; renderMap(); } });
  scene.add(ctx.cam);
  ctx.clouds = cloudLayer(scene);

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
    const ocean = ctx.ocean;
    if (ocean) {
      const pos = ocean.geometry.attributes.position as THREE.BufferAttribute, t = clock.elapsedTime;
      for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), y = pos.getY(i); pos.setZ(i, Math.sin(x * .05 + t * 1.1) * .22 + Math.sin(y * .08 - t * .7) * .15); }
      pos.needsUpdate = true; ocean.geometry.computeVertexNormals();
      const nm = (ocean.material as THREE.MeshStandardMaterial).normalMap;
      if (nm) nm.offset.set(t * .006, -t * .004);
      ctx.foam.forEach(b => {
        const wave = Math.sin(t * .8 + b.userData.phase);
        b.position.x = b.userData.base + wave * 3.5; (b.material as THREE.MeshBasicMaterial).opacity = .35 + .35 * (wave * .5 + .5);
      });
    }
    if (ctx.clouds) ctx.clouds.offset.x += dt * .0006;
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
  else { ctx.controls.target.copy(centre); ctx.camera.position.set(-area * 0.3, area * 0.62, centre.z + area * 0.95); }
}

function buildWorld(c: Ctx, s: NonNullable<typeof store.snapshot>) {
  dispose(c.world); dispose(c.leadGroup); dispose(c.truthGroup); dispose(c.hazardGroup);
  c.pins.clear(); c.sectorLabels = {}; c.houseMats = []; c.truthKey = ''; c.hazardKey = ''; c.coverage = null;
  const { scene, config } = s, area = scene.area_m, cell = config.COVERAGE_CELL_M;
  const margin = 80, painted = groundTexture(scene, s.seed, margin, BEACH_M);
  const limit = painted?.limit ?? (() => area * .25);
  // Land stops at the shoreline (BEACH_M past the area edge); the sea fills everything east of it.
  const shore = area + BEACH_M;
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: '#56603f', roughness: 1 }));
  outer.rotation.x = -Math.PI / 2; outer.position.set(shore - 6000 - margin, -0.08, -area / 2); outer.receiveShadow = true; c.world.add(outer);
  const land = new THREE.Mesh(new THREE.PlaneGeometry(area + margin * 2, area + margin * 2), new THREE.MeshStandardMaterial({ map: painted?.tex ?? null, color: painted ? '#ffffff' : '#56603f', roughness: .95, alphaTest: .5 }));
  land.rotation.x = -Math.PI / 2; land.position.set(area / 2, 0, -area / 2); land.receiveShadow = true; c.world.add(land);

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
  c.ocean = null; c.foam = [];
  scene.water.forEach(w => {
    if (w.kind === 'ocean') {
      // The sea runs off to the horizon; the server rectangle only marks where it starts.
      const width = w.width + 900, height = w.height + 1200, geo = new THREE.PlaneGeometry(width, height, 90, 90);
      // Turquoise shallows fading to deep teal with distance from the shoreline (local x = east).
      const pos = geo.attributes.position, tint = new Float32Array(pos.count * 3), shallow = new THREE.Color('#5fb7a8'), deep = new THREE.Color('#0d3a49'), mix = new THREE.Color();
      for (let i = 0; i < pos.count; i++) { mix.copy(shallow).lerp(deep, Math.min(1, Math.pow((pos.getX(i) + width / 2) / 160, .6))); tint.set([mix.r, mix.g, mix.b], i * 3); }
      geo.setAttribute('color', new THREE.BufferAttribute(tint, 3));
      const normals = waterNormals();
      if (normals) { normals.repeat.set(width / 28, height / 28); normals.anisotropy = 8; }
      const sea = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .12, metalness: .05, normalMap: normals, normalScale: new THREE.Vector2(.12, .12), envMapIntensity: 1 }));
      sea.rotation.x = -Math.PI / 2; sea.position.copy(at(shore - 20 + width / 2, w.y + w.height / 2, -0.45)); sea.receiveShadow = true;
      c.world.add(sea); c.ocean = sea;
      // Beyond the animated patch the sea is flat deep water all the way to the fogged horizon.
      const far = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: '#0d3a49', roughness: .15 }));
      far.rotation.x = -Math.PI / 2; far.position.copy(at(shore + 5900, w.y + w.height / 2, -2)); c.world.add(far);
      // Two swash bands that wash in and out over the wet sand.
      c.foam = [0, 1].map(k => {
        const tex = foamTexture(); tex?.repeat.set(1, (w.height + 400) / 60);
        const band = new THREE.Mesh(new THREE.PlaneGeometry(9, w.height + 400), new THREE.MeshBasicMaterial({ map: tex, color: '#f4f7f1', transparent: true, opacity: .7, depthWrite: false, fog: false }));
        band.rotation.x = -Math.PI / 2; band.userData.base = shore + 3 + k * 7; band.userData.phase = k * 2.1;
        band.position.copy(at(band.userData.base, w.y + w.height / 2, 0.06 + k * .01)); c.world.add(band); return band;
      });
      return;
    }
    // Standing floodwater: brown, sediment-laden, still.
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(w.width, w.height), new THREE.MeshStandardMaterial({ color: '#55625a', roughness: .06, metalness: .6, transparent: true, opacity: .85 }));
    pool.rotation.x = -Math.PI / 2; pool.position.copy(at(w.x + w.width / 2, w.y + w.height / 2, 0.45)); pool.receiveShadow = true; c.world.add(pool);
  });
  const dressed = dressScene(scene, s.seed, c.world, limit);
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
