// Viewer-only dressing for the inspection scene. The fly camera must keep seeing exactly
// the scene the readout was measured on, so everything here lives on three.js layers:
//   layer 0: seen by both cameras (shared markers)
//   CHASE (1): seen only by the viewer's chase camera (colours, drone model, lights, trail)
//   EYE (2): seen only by the fly camera (the benchmark's grayscale materials and lights)
// Geometry and collisions are shared; only materials, lights and decoration differ.
import * as THREE from 'three';

// OVERLAY (3): viewer-only markers (trail, event markers, beacons), kept out of the drone's photo.
export const CHASE = 1, EYE = 2, OVERLAY = 3;

export function onLayer<T extends THREE.Object3D>(o: T, layer: number): T {
  o.traverse((c) => c.layers.set(layer));
  return o;
}

/** A viewer-only twin of an eye mesh: same geometry and transform, a coloured material. */
export function twin(eyeMesh: THREE.Mesh, mat: THREE.Material, shadows = true): THREE.Mesh {
  eyeMesh.layers.set(EYE);
  const t = new THREE.Mesh(eyeMesh.geometry, mat);
  t.layers.set(CHASE);
  t.castShadow = t.receiveShadow = shadows;
  eyeMesh.add(t); // child: follows the eye mesh (falling debris), rendered only by the chase camera
  return t;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, r: () => number) => void, seed = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  let a = (seed * 2654435761) >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  draw(c.getContext('2d')!, r);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

const speckle = (g: CanvasRenderingContext2D, r: () => number, w: number, h: number, n: number, rgb: string, alpha: number, size: number) => {
  for (let i = 0; i < n; i++) { g.fillStyle = `rgba(${rgb},${alpha * r()})`; g.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r())); }
};

/** Coloured materials, built once per page. */
export const palette = (() => {
  let p: ReturnType<typeof build> | null = null;
  const build = () => ({
    concrete: new THREE.MeshStandardMaterial({ roughness: 0.95, map: canvasTexture(512, 512, (g, r) => {
      g.fillStyle = '#9a968e'; g.fillRect(0, 0, 512, 512);
      speckle(g, r, 512, 512, 9000, '60,58,54', 0.25, 2);
      speckle(g, r, 512, 512, 4000, '230,226,215', 0.18, 2);
      for (let i = 0; i < 7; i++) { // oil and water stains
        const x = r() * 512, y = r() * 512, rad = 20 + r() * 70;
        const grd = g.createRadialGradient(x, y, 0, x, y, rad);
        grd.addColorStop(0, `rgba(40,38,36,${0.15 + 0.2 * r()})`); grd.addColorStop(1, 'rgba(40,38,36,0)');
        g.fillStyle = grd; g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
      }
      g.strokeStyle = 'rgba(50,48,45,0.55)'; g.lineWidth = 1.2; // hairline cracks
      for (let i = 0; i < 5; i++) { let x = r() * 512, y = r() * 512; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 60; g.lineTo(x, y); } g.stroke(); }
      g.strokeStyle = 'rgba(70,68,64,0.6)'; g.lineWidth = 3; g.strokeRect(0, 0, 512, 512); // expansion joints
    }, 3) }),
    wood: new THREE.MeshStandardMaterial({ roughness: 0.8, map: canvasTexture(256, 64, (g, r) => {
      g.fillStyle = '#7a5334'; g.fillRect(0, 0, 256, 64);
      for (let y = 0; y < 64; y += 2) { g.fillStyle = `rgba(${40 + r() * 30},${25 + r() * 20},10,${0.15 + 0.25 * r()})`; g.fillRect(0, y, 256, 1 + r() * 2); }
      speckle(g, r, 256, 64, 60, '30,18,8', 0.6, 3);
    }, 5) }),
    steel: new THREE.MeshStandardMaterial({ color: 0x5b6168, roughness: 0.55, metalness: 0.6 }),
    rust: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.3, map: canvasTexture(64, 256, (g, r) => {
      g.fillStyle = '#4d535a'; g.fillRect(0, 0, 64, 256);
      speckle(g, r, 64, 256, 500, '140,72,32', 0.7, 4);
    }, 7) }),
    roof: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.4, map: canvasTexture(256, 256, (g, r) => {
      for (let x = 0; x < 256; x += 16) { // corrugated sheet: light/dark ridges
        const grd = g.createLinearGradient(x, 0, x + 16, 0);
        grd.addColorStop(0, '#6f8a8f'); grd.addColorStop(0.5, '#b7c6c4'); grd.addColorStop(1, '#6f8a8f');
        g.fillStyle = grd; g.fillRect(x, 0, 16, 256);
      }
      speckle(g, r, 256, 256, 300, '120,70,40', 0.5, 5);
    }, 9) }),
    brick: new THREE.MeshStandardMaterial({ roughness: 0.9, map: canvasTexture(512, 256, (g, r) => {
      g.fillStyle = '#8f8a80'; g.fillRect(0, 0, 512, 256);
      for (let row = 0; row < 16; row++) for (let col = -1; col < 16; col++) {
        const x = col * 32 + (row % 2) * 16, y = row * 16;
        const v = 0.8 + 0.4 * r();
        g.fillStyle = `rgb(${Math.round(150 * v)},${Math.round(68 * v)},${Math.round(50 * v)})`;
        g.fillRect(x + 1, y + 1, 30, 14);
      }
      speckle(g, r, 512, 256, 1500, '40,30,25', 0.3, 2);
    }, 11) }),
    panel: new THREE.MeshStandardMaterial({ roughness: 0.85, map: canvasTexture(128, 128, (g, r) => {
      g.fillStyle = '#b89968'; g.fillRect(0, 0, 128, 128); // plywood sheet
      for (let y = 0; y < 128; y += 3) { g.fillStyle = `rgba(120,85,45,${0.1 + 0.2 * r()})`; g.fillRect(0, y, 128, 1); }
      speckle(g, r, 128, 128, 80, '60,40,20', 0.5, 4);
      g.strokeStyle = 'rgba(40,30,20,0.7)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 90); g.lineTo(50, 70); g.lineTo(128, 100); g.stroke();
    }, 13) }),
    bin: new THREE.MeshStandardMaterial({ color: 0x2f5a3a, roughness: 0.7 }),
    bin2: new THREE.MeshStandardMaterial({ color: 0x2d4c7a, roughness: 0.7 }),
    plaster: new THREE.MeshStandardMaterial({ roughness: 0.95, map: canvasTexture(256, 256, (g, r) => {
      g.fillStyle = '#d9d2c3'; g.fillRect(0, 0, 256, 256);
      speckle(g, r, 256, 256, 2000, '120,110,95', 0.12, 3);
      for (let i = 0; i < 4; i++) { const x = r() * 256, y = r() * 256, rad = 20 + r() * 60; const grd = g.createRadialGradient(x, y, 0, x, y, rad); grd.addColorStop(0, 'rgba(90,75,55,0.25)'); grd.addColorStop(1, 'rgba(90,75,55,0)'); g.fillStyle = grd; g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad); }
    }, 17) }),
    wallCut: new THREE.MeshStandardMaterial({ color: 0x3b3833, roughness: 1 }),
    floorboards: new THREE.MeshStandardMaterial({ roughness: 0.75, map: canvasTexture(512, 512, (g, r) => {
      for (let y = 0; y < 512; y += 32) for (let x = -64; x < 512; x += 128) {
        const off = ((y / 32) % 4) * 32, v = 0.8 + 0.35 * r();
        g.fillStyle = `rgb(${Math.round(150 * v)},${Math.round(108 * v)},${Math.round(70 * v)})`; g.fillRect(x + off, y, 127, 31);
      }
      speckle(g, r, 512, 512, 3000, '60,40,20', 0.25, 2);
      speckle(g, r, 512, 512, 800, '190,185,175', 0.5, 3); // plaster dust
    }, 19) }),
    fabric: new THREE.MeshStandardMaterial({ color: 0x5a6b4a, roughness: 1 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 }),
  });
  return () => (p ??= build());
})();

/** The rescue quadcopter (~8.9 units across at scale 1), shared by the scan map and the inspection viewer. */
export function buildQuad() {
  const g = new THREE.Group(), rotors: THREE.Object3D[] = [];
  const shell = new THREE.MeshStandardMaterial({ color: '#d4d8d6', roughness: .5, metalness: .3 });
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
  // Rescue airframe: vented instrument deck, antenna, fasteners and a high-visibility stripe.
  const orange = new THREE.MeshStandardMaterial({ color: '#b96d37', roughness: .6 });
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.8, .05, .3), orange); stripe.position.set(0, .58, -.5); g.add(stripe);
  for (let i = 0; i < 6; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(.8, .04, .055), carbon); vent.position.set(0, .58, .1 + i * .14); g.add(vent);
  }
  for (const x of [-.7, .7]) for (const z of [-.8, .8]) {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, .04, 6), carbon); bolt.position.set(x, .56, z); g.add(bolt);
  }
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(.04, .06, .9, 8), carbon); antenna.position.set(.5, .9, .8); g.add(antenna);
  g.traverse(o => { o.castShadow = true; });
  return { g, rotors };
}

/** The scan map's quadcopter at real size (~0.5 m across, the collision radius): props spin, body tilts. */
export function makeDrone(): THREE.Group {
  const g = new THREE.Group(); g.name = 'body';
  const { g: quad, rotors } = buildQuad();
  quad.scale.setScalar(0.49 / 8.9);
  rotors.forEach((r, i) => { r.name = 'prop'; r.userData.dir = i === 0 || i === 3 ? 1 : -1; });
  g.add(quad);
  return onLayer(g, CHASE);
}

/** A casualty lying on the ground, head toward +x, in a hi-vis jacket. */
export function makePerson(): THREE.Group {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xc69c7a, roughness: 0.7 });
  const vest = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
  const band = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.3, metalness: 0.3 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x2f4a6d, roughness: 0.85 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.8 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0, ry = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(0, ry, rz); m.castShadow = m.receiveShadow = true; g.add(m); return m;
  };
  add(new THREE.CapsuleGeometry(0.15, 0.42, 6, 12), vest, 0.35, 0.15, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.152, 0.152, 0.04, 16), band, 0.3, 0.15, 0, Math.PI / 2);
  add(new THREE.SphereGeometry(0.11, 18, 14), skin, 0.78, 0.13, 0.03);
  for (const s of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.075, 0.7, 6, 10), jeans, -0.25, 0.08, s * 0.09, Math.PI / 2, s * 0.08);
    add(new THREE.BoxGeometry(0.1, 0.1, 0.12), boot, -0.68, 0.08, s * 0.12);
    add(new THREE.CapsuleGeometry(0.05, 0.5, 6, 10), vest, 0.38, 0.1, s * 0.24, Math.PI / 2, s * 0.35);
  }
  return g;
}

/** Sky dome, sun with shadows and fill light, all viewer-only. */
export function addChaseEnvironment(scene: THREE.Scene, opts: { shadowSpan?: number } = {}) {
  const sky = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x4f6f99) }, mid: { value: new THREE.Color(0xe6c7a4) }, low: { value: new THREE.Color(0x8a7e70) } },
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 p; void main(){ float h = p.y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, low, min(1.0, -h * 4.0)); gl_FragColor = vec4(c, 1.0); }',
  }));
  sky.renderOrder = -1; sky.name = 'sky';
  scene.add(onLayer(sky, CHASE));
  scene.add(onLayer(new THREE.HemisphereLight(0xd6dde8, 0x6a5a48, 1.1), CHASE));
  const sun = new THREE.DirectionalLight(0xffd6a8, 2.5); // low early-morning sun, long shadows
  sun.position.set(-8, 7, 5); sun.castShadow = true;
  const s = opts.shadowSpan ?? 9;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 });
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  sun.target.position.set(0, 0, -2);
  scene.add(sun.target);
  scene.add(onLayer(sun, CHASE));
}

export interface ChaseRig {
  back: number; up: number; ahead: number; lookY: number;
  roof?: { halfX: number; zMin: number; zMax: number; below: number };
}

type Mark = 'brake' | 'saccade_left' | 'saccade_right' | 'reached' | 'collided';

/** Viewer camera that follows the drone smoothly, plus the flight trail and event markers. */
export class ChaseView {
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 150);
  private trail: THREE.Line;
  private pts: number[] = [];
  private marks = new THREE.Group();
  private last = '';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private init = false;
  private fog = new THREE.Fog(0xd8c6b0, 12, 55);

  constructor(private scene: THREE.Scene, private rig: ChaseRig = { back: 3.2, up: 2.6, ahead: 2.0, lookY: 1.0 }) {
    this.camera.layers.enable(CHASE); this.camera.layers.enable(OVERLAY);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 4000), 3));
    geo.setDrawRange(0, 0);
    this.trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.85 }));
    this.trail.frustumCulled = false;
    scene.add(onLayer(this.trail, OVERLAY));
    scene.add(this.marks);
  }

  private mark(kind: Mark, x: number, z: number, yaw: number) {
    const color = { brake: 0xe0a33c, saccade_left: 0xef6a5b, saccade_right: 0xef6a5b, reached: 0x6cc48a, collided: 0xef2b2b }[kind];
    const g = new THREE.Group(); g.position.set(x, 0.02, z);
    const disc = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.2, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    disc.rotation.x = -Math.PI / 2; g.add(disc);
    if (kind.startsWith('saccade')) { // arrow showing the turn direction
      const dir = kind === 'saccade_left' ? -1 : 1;
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 3), new THREE.MeshBasicMaterial({ color }));
      arrow.rotation.set(-Math.PI / 2, 0, 0); arrow.rotateZ(-yaw - dir * Math.PI / 2);
      arrow.position.set(Math.cos(yaw) * dir * 0.35, 0.01, Math.sin(yaw) * dir * 0.35);
      g.add(arrow);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.2, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
    pole.position.y = 0.6; g.add(pole);
    this.marks.add(onLayer(g, OVERLAY));
  }

  /** Call once per simulated frame. cmd: the reflex command in force; t: sim time (s). */
  update(d: { x: number; z: number; yaw: number; speed: number; t: number; drone: THREE.Object3D; cmd?: string; collided: boolean; arrived: boolean }, dtS = 0.02) {
    const n = this.pts.length / 3;
    if (n < 4000 && (n === 0 || Math.hypot(this.pts[this.pts.length - 3] - d.x, this.pts[this.pts.length - 1] - d.z) > 0.03)) {
      this.pts.push(d.x, 0.04, d.z);
      const attr = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.set(this.pts.slice(-3), this.pts.length - 3); attr.needsUpdate = true;
      this.trail.geometry.setDrawRange(0, this.pts.length / 3);
    }
    const ev = d.collided ? 'collided' : d.arrived ? 'reached' : d.cmd ?? 'none';
    if (ev !== this.last && ev !== 'none' && ev !== 'arrived') this.mark(ev as Mark, d.x, d.z, d.yaw);
    this.last = ev;
    for (const tick of (this.scene.userData.ticks ?? []) as ((t: number) => void)[]) tick(d.t);
    // Props spin with thrust; LEDs blink; the body tilts with acceleration.
    d.drone.traverse((o) => {
      if (o.name === 'prop') o.rotation.y += (o.userData.dir as number) * 1.4;
      if (o.name === 'strobe') o.visible = Math.floor(d.t * 2) % 2 === 0 && (d.t * 2) % 1 < 0.15;
    });
    const body = d.drone.getObjectByName('body');
    if (body) body.rotation.x = THREE.MathUtils.lerp(body.rotation.x, -Math.min(0.25, d.speed * 0.1), 0.1);
    const fwd = new THREE.Vector3(Math.sin(d.yaw), 0, -Math.cos(d.yaw));
    let up = this.rig.up;
    const cx = d.x - fwd.x * this.rig.back, cz = d.z - fwd.z * this.rig.back, r = this.rig.roof;
    if (r && Math.abs(cx) < r.halfX && cz < r.zMax && cz > r.zMin) up = r.below; // stay under a roof, not inside it
    const wantPos = new THREE.Vector3(cx, up, cz);
    const wantLook = new THREE.Vector3(d.x + fwd.x * this.rig.ahead, this.rig.lookY, d.z + fwd.z * this.rig.ahead);
    const k = this.init ? 1 - Math.exp(-dtS / 0.35) : 1; // ~0.35 s smoothing: saccades read as turns, not cuts
    this.pos.lerp(wantPos, k); this.look.lerp(wantLook, k); this.init = true;
    this.camera.position.copy(this.pos); this.camera.lookAt(this.look);
  }

  render(renderer: THREE.WebGLRenderer, w?: number, h?: number) {
    if (w && h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    const fog = this.scene.fog;
    this.scene.fog = this.fog; // viewer-only haze; the fly camera renders without it
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    this.scene.fog = fog;
  }
}

/** Animated viewer-only effects register here; ChaseView.update runs them with sim time. */
export function onTick(scene: THREE.Scene, fn: (t: number) => void) {
  (scene.userData.ticks ??= []).push(fn);
}

let puffTex: THREE.Texture | null = null;
function puff(): THREE.Texture {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 14; i++) { // lumpy soft blob
    const x = 64 + (Math.sin(i * 2.4) * 26), y = 64 + (Math.cos(i * 1.7) * 22), r = 30 + (i % 4) * 7;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.28)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  }
  puffTex = new THREE.CanvasTexture(c); puffTex.colorSpace = THREE.SRGBColorSpace;
  return puffTex;
}

/** A rising smoke column of looping sprites (viewer-only). */
export function addSmoke(scene: THREE.Scene, x: number, z: number, opts: { y0?: number; height?: number; width?: number; color?: number; n?: number; far?: boolean } = {}) {
  const { y0 = 0, height = 14, width = 3, color = 0x4a4540, n = 18, far = false } = opts;
  const group = new THREE.Group();
  const sprites = Array.from({ length: n }, (_, i) => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff(), color, transparent: true, depthWrite: false, fog: !far }));
    m.userData.phase = i / n; m.userData.spin = (i % 2 ? 1 : -1) * (0.1 + 0.05 * (i % 3));
    group.add(m); return m;
  });
  scene.add(onLayer(group, CHASE));
  onTick(scene, (t) => {
    for (const m of sprites) {
      const f = (m.userData.phase + t / 16) % 1; // each puff rises over 16 s
      const w = width * (0.5 + 1.8 * f);
      m.position.set(x + Math.sin(f * 5 + m.userData.phase * 9) * width * 0.35 + f * width * 0.8, y0 + f * height, z);
      m.scale.set(w, w, 1);
      m.material.opacity = Math.min(1, f * 6) * (1 - f) * 0.9;
      m.material.rotation = m.userData.spin * t;
    }
  });
}

/** Airborne dust drifting through a box (viewer-only). */
export function addDust(scene: THREE.Scene, min: THREE.Vector3, max: THREE.Vector3, n = 700) {
  const pos = new Float32Array(3 * n), base = new Float32Array(3 * n);
  let a = 12345;
  const r = () => { a = (a * 1103515245 + 12345) >>> 0; return a / 4294967296; };
  for (let i = 0; i < n; i++) {
    base[3 * i] = min.x + (max.x - min.x) * r(); base[3 * i + 1] = min.y + (max.y - min.y) * r(); base[3 * i + 2] = min.z + (max.z - min.z) * r();
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xf1dcc0, size: 0.025, transparent: true, opacity: 0.55, depthWrite: false }));
  pts.frustumCulled = false;
  scene.add(onLayer(pts, CHASE));
  const h = max.y - min.y;
  onTick(scene, (t) => {
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      pos[k] = base[k] + 0.25 * Math.sin(t * 0.3 + i);
      pos[k + 1] = min.y + ((base[k + 1] - min.y + t * 0.04 * (1 + (i % 5) * 0.2)) % h);
      pos[k + 2] = base[k + 2] + 0.25 * Math.cos(t * 0.23 + i * 1.3);
    }
    geo.attributes.position.needsUpdate = true;
  });
}

/** Flashing red/blue emergency lights with halos (viewer-only). */
export function addBeacons(scene: THREE.Scene, x: number, y: number, z: number) {
  const group = new THREE.Group();
  const halo = (color: number, dx: number) => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    m.position.set(x + dx, y, z); m.scale.set(3, 3, 1); group.add(m); return m;
  };
  const red = halo(0xff2a2a, -0.6), blue = halo(0x2a6bff, 0.6);
  const lr = new THREE.PointLight(0xff3030, 0, 14, 1.5), lb = new THREE.PointLight(0x3060ff, 0, 14, 1.5);
  lr.position.set(x - 0.6, y, z); lb.position.set(x + 0.6, y, z); group.add(lr, lb);
  scene.add(onLayer(group, CHASE));
  onTick(scene, (t) => {
    const ph = (t * 2.5) % 1, on = (a: number) => (Math.sin(a * Math.PI * 2) > 0.3 ? 1 : 0.08);
    const vr = on(ph), vb = on(ph + 0.5);
    red.material.opacity = vr; blue.material.opacity = vb; lr.intensity = 6 * vr; lb.intensity = 6 * vb;
  });
}

/**
 * The collapsed house the carport belonged to, behind the 4 m brick wall at z = -11.
 * Viewer-only, and also out of the fly's sight in reality: from any fly-eye position
 * (y = 1.2 m, z >= -9.1 on every flight) the wall hides a point at z <= -11 up to
 * h = 4 + 2.8 * (-11 - z) / 1.9; every top here stays below that bound, and |x| <= 7.5
 * keeps it within the wall's 20 m width. A higher viewer camera sees over the wall.
 */
export function addRuin(scene: THREE.Scene) {
  const pal = palette(), group = new THREE.Group();
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: THREE.Material, rot?: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    if (rot) m.rotation.set(...rot);
    m.castShadow = m.receiveShadow = true; group.add(m); return m;
  };
  const charred = new THREE.MeshStandardMaterial({ color: 0x2a2522, roughness: 1 });
  const brick = pal.brick.clone(); brick.map = pal.brick.map!.clone(); brick.map.repeat.set(2, 2);
  // Two-storey shell, z from -16 to -23: side walls with broken tops, a gable end, a fallen slab.
  box(-6.5, 0, -23, -6.2, 6.5, -16, brick);                       // left wall (tallest point 6.5 m)
  box(3.2, 0, -23, 3.5, 4.2, -18.5, brick);                       // right wall, broken
  box(3.2, 0, -18.5, 3.5, 2.6, -16, brick);
  box(-6.2, 0, -23.3, 3.2, 5.8, -23, brick);                      // back wall
  box(-6.2, 3.0, -23, 1.0, 3.2, -18, pal.plaster);                // intact half of the first floor
  box(0.2, 1.2, -21, 3.3, 1.4, -16.5, pal.plaster, [0, 0.1, 0.42]); // floor slab collapsed onto the ground
  for (let i = 0; i < 6; i++) box(-5.5 + i * 1.3, 5.2, -23, -5.35 + i * 1.3, 5.4, -17 - (i % 3), charred, [0.15 * (i % 2 ? 1 : -1), 0, 0.08 * i]); // charred rafters
  box(-6.2, 0, -16.2, -3.0, 1.1, -16, brick);                     // front wall stub
  box(-2.4, 0, -17.5, 1.8, 0.9, -15.4, pal.plaster);              // rubble heap
  box(-1.0, 0.5, -17, 0.9, 1.4, -15.8, pal.panel, [0.3, 0.5, 0.2]);
  // A leaning utility pole (top ~7 m at z = -14.5; the bound there is 9.2 m).
  const pole = box(6.4, 0, -14.6, 6.6, 7.4, -14.4, pal.wood); pole.rotation.z = -0.18; pole.position.x += 0.6;
  // Fire truck behind the wall (hidden from both cameras except its lights).
  box(-5.6, 0, -14.4, -1.2, 2.9, -12.4, new THREE.MeshStandardMaterial({ color: 0x9e1b1b, roughness: 0.5 }));
  scene.add(onLayer(group, CHASE));
  addBeacons(scene, -3.4, 3.2, -13.4);
  addSmoke(scene, -2.5, -20, { y0: 3, height: 10, width: 2.2, color: 0x3d3834 }); // top ~15.5 m < 17.3 m bound at z = -20
}

/** Dust, distant smoke columns: shared by every scene. */
export function addAtmosphere(scene: THREE.Scene, dustMin: THREE.Vector3, dustMax: THREE.Vector3) {
  addDust(scene, dustMin, dustMax);
  addSmoke(scene, -38, -42, { y0: 0, height: 30, width: 7, color: 0x5a524b, far: true, n: 14 });
  addSmoke(scene, 34, -48, { y0: 0, height: 26, width: 6, color: 0x6a625a, far: true, n: 12 });
}
