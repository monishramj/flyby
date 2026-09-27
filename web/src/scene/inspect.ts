// Carport inspection scene: world, drone kinematics, collisions, FPV frames, reflex link.
// Units: metres, seconds. World: y up; the drone flies in the x–z plane at DRONE_Y.
// Heading 0 faces −z; + yaw turns right (toward +x). Camera image: x right, y up,
// sent with row 0 = top. Constants mirror reflex/config.py where they overlap.
import * as THREE from 'three';

export const FRAME_R = 96;
export const DT = 0.02;
export const HOVER_S = 1.0;
export const A_BRAKE = 4.0;
export const A_ACCEL = 2.0;
export const CRUISE_MPS = 1.5;
export const DRONE_RADIUS = 0.25;
export const DRONE_Y = 1.2;
export const HEADER_BYTES = 20;
export const MAX_T_S = 25;
export const GOAL_RADIUS = 0.5;
export const MODE = { live: 0, bench_record: 1, bench_closed: 2 } as const;

const POST_X = 1.4, POST_R = 0.05, POST_H = 2.3, BACK_Z = -5, BEAM_TOP = 2.3;
// Debris: a roof panel that drops and hangs across the flight path (bottom at 0.9 m).
const GRAVITY = 9.81, DEBRIS_Z = -1.0, DEBRIS_HALF = new THREE.Vector3(0.4, 0.35, 0.05);
const DEBRIS_TOP_Y = POST_H - 0.35 - DEBRIS_HALF.y, DEBRIS_REST_Y = 0.9 + DEBRIS_HALF.y;

export const SCENARIOS = ['post', 'beam', 'debris', 'clear', 'near_post'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface EpisodeSpec {
  seed: number; scenario: Scenario; fovDeg: number;
  startX: number; startZ: number; heading: number; goalX: number; goalZ: number;
  beamSag: number; debris: { x: number; tFall: number } | null;
}

export function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSpec(seed: number, scenario: Scenario, fovDeg = 120): EpisodeSpec {
  const r = rng(seed * 31 + SCENARIOS.indexOf(scenario));
  const u = (a: number, b: number) => a + (b - a) * r();
  const side = r() < 0.5 ? -1 : 1;
  const startX = {
    post: side * POST_X + u(-0.15, 0.15),
    near_post: side * (POST_X - u(0.45, 0.7)),
    beam: u(-0.4, 0.4), debris: u(-0.3, 0.3), clear: u(-0.5, 0.5),
  }[scenario];
  const startZ = 6;
  // Debris lands ~2.5 m ahead of the drone's straight-line arrival at DEBRIS_Z.
  const cruiseStart = HOVER_S + CRUISE_MPS / A_ACCEL;
  const accelDist = CRUISE_MPS ** 2 / (2 * A_ACCEL);
  const tArrive = cruiseStart + (startZ - DEBRIS_Z - accelDist) / CRUISE_MPS;
  const fallS = Math.sqrt((2 * (DEBRIS_TOP_Y - DEBRIS_REST_Y)) / GRAVITY);
  return {
    seed, scenario, fovDeg, startX, startZ,
    heading: u(-2, 2) * Math.PI / 180,
    goalX: startX, goalZ: -8,
    beamSag: scenario === 'beam' ? u(0.95, 1.3) : u(0, 0.3),
    debris: scenario === 'debris' ? { x: startX + u(-0.15, 0.15), tFall: tArrive - 2.5 / CRUISE_MPS - fallS + u(-0.3, 0.3) } : null,
  };
}

function noiseTexture(seed: number, size: number, base: number, amp: number, cell: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  for (let y = 0; y < size; y += cell) for (let x = 0; x < size; x += cell) {
    const v = Math.max(0, Math.min(255, base + (r() - 0.5) * 2 * amp));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, cell, cell);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  return t;
}

type Box = { min: THREE.Vector3; max: THREE.Vector3; mesh?: THREE.Mesh };

export interface Command { cmd: string; speed: number | null; yaw_rate: number | null; S: number | null; dLR: number | null }

export class Inspection {
  readonly scene = new THREE.Scene();
  readonly fpv: THREE.PerspectiveCamera;
  readonly drone = new THREE.Group();
  readonly target = new THREE.WebGLRenderTarget(FRAME_R, FRAME_R);
  k = 0; t = 0; x: number; z: number; yaw: number; speed = 0;
  collided = false; arrived = false; contactK: number | null = null; minClearance = Infinity;
  private posts: THREE.Vector2[] = [];
  private boxes: Box[] = [];
  private debris: Box | null = null;
  private rgba = new Uint8Array(FRAME_R * FRAME_R * 4);

  constructor(readonly spec: EpisodeSpec) {
    this.x = spec.startX; this.z = spec.startZ; this.yaw = spec.heading;
    const s = this.scene;
    s.background = new THREE.Color(0xb8bdb8);
    s.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(4, 8, 3); s.add(sun);

    const groundTex = noiseTexture(11, 256, 128, 45, 8); groundTex.repeat.set(12, 12);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ map: groundTex }));
    ground.rotation.x = -Math.PI / 2; s.add(ground);

    const dark = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    const wood = new THREE.MeshLambertMaterial({ map: noiseTexture(23, 64, 90, 25, 4) });
    for (const px of [-POST_X, POST_X]) for (const pz of [0, BACK_Z]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, POST_H, 12), dark);
      m.position.set(px, POST_H / 2, pz); s.add(m); this.posts.push(new THREE.Vector2(px, pz));
    }
    // Front beam, sagging as a parabola toward the middle; approximated by 14 boxes.
    const n = 14, w = (2 * POST_X) / n;
    for (let i = 0; i < n; i++) {
      const cx = -POST_X + (i + 0.5) * w;
      const bottom = BEAM_TOP - 0.2 - spec.beamSag * (1 - (cx / POST_X) ** 2);
      this.addBox(new THREE.Vector3(cx - w / 2, bottom, -0.075), new THREE.Vector3(cx + w / 2, bottom + 0.2, 0.075), wood);
    }
    this.addBox(new THREE.Vector3(-POST_X, BEAM_TOP - 0.2, BACK_Z - 0.075), new THREE.Vector3(POST_X, BEAM_TOP, BACK_Z + 0.075), wood);
    const roof = new THREE.MeshLambertMaterial({ map: noiseTexture(37, 128, 150, 30, 8) });
    this.addBox(new THREE.Vector3(-1.7, 2.35, BACK_Z - 0.3), new THREE.Vector3(1.7, 2.45, 0.3), roof);
    const brick = noiseTexture(41, 256, 110, 55, 16); brick.repeat.set(4, 1);
    this.addBox(new THREE.Vector3(-10, 0, -11.2), new THREE.Vector3(10, 4, -11), new THREE.MeshLambertMaterial({ map: brick }));
    for (const bx of [-3.2, 3.4]) this.addBox(new THREE.Vector3(bx - 0.3, 0, -2.3), new THREE.Vector3(bx + 0.3, 1.0, -1.7), dark);

    const goal = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.05, 24), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    goal.position.set(spec.goalX, 0.03, spec.goalZ); s.add(goal);

    if (spec.debris) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2 * DEBRIS_HALF.x, 2 * DEBRIS_HALF.y, 2 * DEBRIS_HALF.z), new THREE.MeshLambertMaterial({ map: noiseTexture(53, 64, 120, 40, 8) }));
      this.debris = { min: new THREE.Vector3(), max: new THREE.Vector3(), mesh: m };
      s.add(m);
      this.placeDebris();
    }

    this.fpv = new THREE.PerspectiveCamera(spec.fovDeg, 1, 0.05, 60);
    this.drone.add(this.fpv);
    const body = new THREE.Mesh(new THREE.SphereGeometry(DRONE_RADIUS, 16, 12), new THREE.MeshLambertMaterial({ color: 0xd9480f, transparent: true, opacity: 0.6 }));
    body.visible = false; body.name = 'body';
    this.drone.add(body);
    s.add(this.drone);
    this.pose();
  }

  private addBox(min: THREE.Vector3, max: THREE.Vector3, mat: THREE.Material) {
    const size = max.clone().sub(min);
    const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    m.position.copy(min.clone().add(max).multiplyScalar(0.5));
    this.scene.add(m);
    this.boxes.push({ min, max, mesh: m });
  }

  private placeDebris() {
    const d = this.spec.debris!, b = this.debris!;
    const dt = Math.max(0, this.t - d.tFall);
    const y = Math.max(DEBRIS_REST_Y, DEBRIS_TOP_Y - 0.5 * GRAVITY * dt * dt);
    const c = new THREE.Vector3(d.x, y, DEBRIS_Z);
    b.mesh!.position.copy(c);
    b.min.copy(c).sub(DEBRIS_HALF);
    b.max.copy(c).add(DEBRIS_HALF);
  }

  private pose() {
    this.drone.position.set(this.x, DRONE_Y, this.z);
    this.drone.rotation.set(0, -this.yaw, 0);
  }

  goal(): { bearing: number; dist: number } {
    const dx = this.spec.goalX - this.x, dz = this.spec.goalZ - this.z;
    const fwd = dx * Math.sin(this.yaw) - dz * Math.cos(this.yaw);
    const right = dx * Math.cos(this.yaw) + dz * Math.sin(this.yaw);
    return { bearing: Math.atan2(right, fwd), dist: Math.hypot(dx, dz) };
  }

  private clearance(): number {
    let c = Infinity;
    for (const p of this.posts) c = Math.min(c, Math.hypot(this.x - p.x, this.z - p.y) - POST_R - DRONE_RADIUS);
    const centre = new THREE.Vector3(this.x, DRONE_Y, this.z), q = new THREE.Vector3();
    for (const b of this.debris ? [...this.boxes, this.debris] : this.boxes) {
      q.copy(centre).clamp(b.min, b.max);
      c = Math.min(c, q.distanceTo(centre) - DRONE_RADIUS);
    }
    return c;
  }

  /** Advance one frame. scripted: fly straight at cruise after the hover (bench_record). */
  step(cmd: Command | null, scripted: boolean) {
    if (this.collided || this.arrived) return;
    let targetSpeed = 0, yawRate = 0;
    if (this.t >= HOVER_S) {
      if (scripted) targetSpeed = CRUISE_MPS;
      else if (cmd && cmd.speed !== null && cmd.yaw_rate !== null) {
        targetSpeed = cmd.speed; yawRate = cmd.yaw_rate * Math.PI / 180;
      }
    }
    const a = targetSpeed < this.speed ? A_BRAKE : A_ACCEL;
    this.speed += Math.max(-a * DT, Math.min(a * DT, targetSpeed - this.speed));
    this.yaw += yawRate * DT;
    this.x += Math.sin(this.yaw) * this.speed * DT;
    this.z -= Math.cos(this.yaw) * this.speed * DT;
    this.t += DT; this.k += 1;
    if (this.debris) this.placeDebris();
    this.pose();
    const c = this.clearance();
    this.minClearance = Math.min(this.minClearance, c);
    if (c <= 0) { this.collided = true; this.contactK = this.k; }
    if (this.goal().dist < GOAL_RADIUS) this.arrived = true;
  }

  /** Render the FPV camera to FRAME_R² grayscale, row 0 = top of the image. */
  frame(renderer: THREE.WebGLRenderer): Uint8Array {
    const body = this.drone.getObjectByName('body')!;
    const wasVisible = body.visible; body.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.fpv);
    renderer.readRenderTargetPixels(this.target, 0, 0, FRAME_R, FRAME_R, this.rgba);
    renderer.setRenderTarget(null);
    body.visible = wasVisible;
    const out = new Uint8Array(FRAME_R * FRAME_R);
    for (let row = 0; row < FRAME_R; row++) {
      const src = (FRAME_R - 1 - row) * FRAME_R * 4; // WebGL reads bottom-up
      for (let col = 0; col < FRAME_R; col++) {
        const i = src + col * 4;
        out[row * FRAME_R + col] = Math.round(0.299 * this.rgba[i] + 0.587 * this.rgba[i + 1] + 0.114 * this.rgba[i + 2]);
      }
    }
    return out;
  }

  done(): boolean {
    return this.collided || this.arrived || this.t >= MAX_T_S || this.z < this.spec.goalZ - 1;
  }

  result() {
    return { collided: this.collided, contact_k: this.contactK, arrived: this.arrived, t: +this.t.toFixed(2),
             frames: this.k, min_clearance_m: +this.minClearance.toFixed(3), end: [+this.x.toFixed(3), +this.z.toFixed(3)] };
  }
}

export function encodeFrame(episode: number, k: number, reflexOn: boolean, mode: number,
                            bearing: number, dist: number, pixels: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_BYTES + pixels.length);
  const v = new DataView(buf);
  v.setUint32(0, episode, true); v.setUint32(4, k, true);
  v.setUint8(8, reflexOn ? 1 : 0); v.setUint8(9, mode); v.setUint16(10, 0, true);
  v.setFloat32(12, bearing, true); v.setFloat32(16, dist, true);
  new Uint8Array(buf, HEADER_BYTES).set(pixels);
  return buf;
}

/** WebSocket to the reflex. The server answers every message in order. */
export class ReflexLink {
  private ws!: WebSocket;
  private pending: ((msg: any) => void)[] = [];
  latest: any = null;

  async open(url = 'ws://127.0.0.1:8001/ws/reflex') {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.latest = msg;
      this.pending.shift()?.(msg);
    };
    await new Promise<void>((ok, fail) => { this.ws.onopen = () => ok(); this.ws.onerror = () => fail(new Error(`cannot reach ${url}`)); });
  }

  request(data: ArrayBuffer | object): Promise<any> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.ws.send(data instanceof ArrayBuffer ? data : JSON.stringify(data));
    });
  }

  close() { this.ws.close(); }
}
