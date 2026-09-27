// Viewer-only dressing for the inspection scene. The fly camera must keep seeing exactly
// the scene the readout was measured on, so everything here lives on three.js layers:
//   layer 0: seen by both cameras (shared markers)
//   CHASE (1): seen only by the viewer's chase camera (colours, drone model, lights, trail)
//   EYE (2): seen only by the fly camera (the benchmark's grayscale materials and lights)
// Geometry and collisions are shared; only materials, lights and decoration differ.
import * as THREE from 'three';

export const CHASE = 1, EYE = 2;

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

/** Quadcopter (~0.5 m across, the collision radius) with spinning props and nav lights. */
export function makeDrone(): THREE.Group {
  const g = new THREE.Group(); g.name = 'body';
  const shell = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.35, metalness: 0.2 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xd9480f, roughness: 0.4 });
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.22), shell); g.add(core);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.162, 0.012, 0.1), accent); stripe.position.set(0, 0.031, -0.02); g.add(stripe);
  const pod = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), carbon); pod.position.set(0, -0.035, -0.11); g.add(pod);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.018, 16), new THREE.MeshBasicMaterial({ color: 0x3aa0ff })); lens.position.set(0, -0.035, -0.146); g.add(lens);
  const blade = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, transparent: true, opacity: 0.55, roughness: 0.3, side: THREE.DoubleSide });
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.25), carbon);
    arm.position.set(sx * 0.085, 0.0, sz * 0.085); arm.rotation.y = Math.atan2(sx, sz); g.add(arm);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 12), carbon);
    motor.position.set(sx * 0.17, 0.015, sz * 0.17); g.add(motor);
    const prop = new THREE.Group(); prop.name = 'prop'; prop.position.set(sx * 0.17, 0.034, sz * 0.17);
    prop.userData.dir = sx * sz;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24), new THREE.MeshBasicMaterial({ color: 0xbfc8cf, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2; prop.add(disc);
    for (const a of [0, Math.PI]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.003, 0.018), blade); b.rotation.y = a; prop.add(b); }
    g.add(prop);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.004, 6, 32), carbon);
    guard.rotation.x = Math.PI / 2; guard.position.copy(prop.position); g.add(guard);
  }
  const led = (color: number, x: number, z: number, name: string) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, -0.005, z); m.name = name; g.add(m);
  };
  led(0xff3b30, -0.17, -0.17, 'led'); led(0x34c759, 0.17, -0.17, 'led'); led(0xffffff, 0, 0.115, 'strobe');
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
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
    uniforms: { top: { value: new THREE.Color(0x6d8fb3) }, mid: { value: new THREE.Color(0xc9d3d6) }, low: { value: new THREE.Color(0xa59c8c) } },
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 p; void main(){ float h = p.y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, low, min(1.0, -h * 4.0)); gl_FragColor = vec4(c, 1.0); }',
  }));
  sky.renderOrder = -1; sky.name = 'sky';
  scene.add(onLayer(sky, CHASE));
  scene.add(onLayer(new THREE.HemisphereLight(0xdfe8f0, 0x5a5146, 1.1), CHASE));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(6, 11, 4); sun.castShadow = true;
  const s = opts.shadowSpan ?? 9;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 });
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  sun.target.position.set(0, 0, -2);
  scene.add(sun.target);
  scene.add(onLayer(sun, CHASE));
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
  private fog = new THREE.Fog(0xc9d3d6, 14, 60);

  constructor(private scene: THREE.Scene, private rig = { back: 3.2, up: 2.6, ahead: 2.0, lookY: 1.0 }) {
    this.camera.layers.enable(CHASE);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 4000), 3));
    geo.setDrawRange(0, 0);
    this.trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.85 }));
    this.trail.frustumCulled = false;
    scene.add(onLayer(this.trail, CHASE));
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
    this.marks.add(onLayer(g, CHASE));
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
    // Props spin with thrust; LEDs blink; the body tilts with acceleration.
    d.drone.traverse((o) => {
      if (o.name === 'prop') o.rotation.y += (o.userData.dir as number) * 1.4;
      if (o.name === 'strobe') o.visible = Math.floor(d.t * 2) % 2 === 0 && (d.t * 2) % 1 < 0.15;
    });
    const body = d.drone.getObjectByName('body');
    if (body) body.rotation.x = THREE.MathUtils.lerp(body.rotation.x, -Math.min(0.25, d.speed * 0.1), 0.1);
    const fwd = new THREE.Vector3(Math.sin(d.yaw), 0, -Math.cos(d.yaw));
    const wantPos = new THREE.Vector3(d.x - fwd.x * this.rig.back, this.rig.up, d.z - fwd.z * this.rig.back);
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
