// Inspection scenes (benchmark carport, damaged house): world, drone kinematics, collisions, FPV frames, reflex link.
// Units: metres, seconds. World: y up; the drone flies in the x–z plane at DRONE_Y.
// Heading 0 faces −z; + yaw turns right (toward +x). Camera image: x right, y up,
// sent with row 0 = top. Constants mirror reflex/config.py where they overlap.
import * as THREE from 'three';
import { CHASE, EYE, addAtmosphere, addChaseEnvironment, addRuin, makeDrone, makePerson, onLayer, palette, twin } from './dress';

export const FRAME_R = 96;
// The camera renders at SUPERSAMPLE× resolution with MSAA, then is area-averaged to
// FRAME_R² for the fly eye: a sharp, alias-free camera image seen at the eye's resolution.
export const SUPERSAMPLE = 4;
const CAM_R = FRAME_R * SUPERSAMPLE;
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
export const WAYPOINT_TIMEOUT_S = 8; // a waypoint not reached in this long is skipped, not chased forever
export const MODE = { live: 0, bench_record: 1, bench_closed: 2 } as const;

const POST_X = 1.4, POST_R = 0.05, POST_H = 2.3, BACK_Z = -5, BEAM_TOP = 2.3;
// Debris: a roof panel that drops and hangs across the flight path (bottom at 0.9 m).
const GRAVITY = 9.81, DEBRIS_Z = -1.0, DEBRIS_HALF = new THREE.Vector3(0.4, 0.35, 0.05);
const DEBRIS_TOP_Y = POST_H - 0.35 - DEBRIS_HALF.y, DEBRIS_REST_Y = 0.9 + DEBRIS_HALF.y;

// Benchmark scenarios (carport): the readout was fitted and scored on these.
export const SCENARIOS = ['post', 'beam', 'debris', 'clear', 'near_post'] as const;
// Plus scenes never used for fitting or scoring (demo / out-of-distribution tests).
export const ALL_SCENARIOS = [...SCENARIOS, 'house'] as const;
export type Scenario = (typeof ALL_SCENARIOS)[number];

// House: a gutted open-plan house whose front wall has collapsed (x right, forward is -z).
// Walls run along the route, as in a real search: a fly-like reflex avoids what looms,
// it does not aim for doorways, so no solid wall stands across the route.
const H_CEIL = 2.7, H_T = 0.15, H_CUT = 1.0, H_W = 3.2; // viewer cutaway: walls drawn to 1 m in the chase view
export const HOUSE_ROUTE: Waypoint[] = [
  { id: 'entry', x: 0, z: 1.0 }, { id: 'living room', x: 0.3, z: -4.2 }, { id: 'target', x: -1.2, z: -7.2 },
];
/** Default inspection route per scene; the last waypoint is the target. */
export function defaultRoute(scenario: Scenario): Waypoint[] {
  return scenario === 'house' ? HOUSE_ROUTE : [{ id: 'entry', x: 0, z: 1.5 }, { id: 'target', x: 0, z: -2.5 }];
}

export interface EpisodeSpec {
  seed: number; scenario: Scenario; fovDeg: number;
  startX: number; startZ: number; heading: number; goalX: number; goalZ: number;
  beamSag: number; debris: { x: number; tFall: number } | null;
  person: boolean; // a person lying at the goal (mission inspections)
  waypoints: Waypoint[]; // flown in order; the last one is the goal
  clutter: number; // house: lateral offset of the hanging ceiling panel (m)
}

export interface Waypoint { id: string; x: number; z: number }
export type WaypointStatus = 'pending' | 'reached' | 'skipped' | 'collided';

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

export function makeSpec(seed: number, scenario: Scenario, fovDeg = 120,
                         opts: { goalZ?: number; person?: boolean; waypoints?: Waypoint[] } = {}): EpisodeSpec {
  const r = rng(seed * 31 + ALL_SCENARIOS.indexOf(scenario));
  const u = (a: number, b: number) => a + (b - a) * r();
  const side = r() < 0.5 ? -1 : 1;
  const startX = {
    post: side * POST_X + u(-0.15, 0.15),
    near_post: side * (POST_X - u(0.45, 0.7)),
    beam: u(-0.4, 0.4), debris: u(-0.3, 0.3), clear: u(-0.5, 0.5),
    house: 0, // set below from its own stream: every draw here shifts the benchmark flights' seeds
  }[scenario];
  const startZ = 6;
  // Debris lands ~2.5 m ahead of the drone's straight-line arrival at DEBRIS_Z.
  const cruiseStart = HOVER_S + CRUISE_MPS / A_ACCEL;
  const accelDist = CRUISE_MPS ** 2 / (2 * A_ACCEL);
  const tArrive = cruiseStart + (startZ - DEBRIS_Z - accelDist) / CRUISE_MPS;
  const fallS = Math.sqrt((2 * (DEBRIS_TOP_Y - DEBRIS_REST_Y)) / GRAVITY);
  const house = scenario === 'house';
  const hr = rng(seed * 131 + 7);
  const startXFinal = house ? -0.2 + 0.4 * hr() : startX;
  const waypoints = opts.waypoints ?? (house ? HOUSE_ROUTE : [{ id: 'target', x: startX, z: opts.goalZ ?? -8 }]);
  const last = waypoints[waypoints.length - 1];
  return {
    seed, scenario, fovDeg, startX: startXFinal, startZ,
    heading: u(-2, 2) * Math.PI / 180,
    goalX: house ? last.x : startX, goalZ: house ? last.z : opts.goalZ ?? -8, person: opts.person ?? false,
    waypoints, clutter: house ? -0.3 + 0.6 * hr() : 0,
    beamSag: scenario === 'beam' ? u(0.95, 1.3) : u(0, 0.3),
    debris: scenario === 'debris' ? { x: startX + u(-0.15, 0.15), tFall: tArrive - 2.5 / CRUISE_MPS - fallS + u(-0.3, 0.3) } : null,
  };
}

/** Seeded noise texture: fine grain (amp, cell) plus optional coarse blotches. */
function noiseTexture(seed: number, size: number, base: number, amp: number, cell: number,
                      coarseAmp = 0, coarseCell = 0): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  const coarse: number[] = [];
  const nc = coarseCell ? size / coarseCell : 0;
  for (let i = 0; i < nc * nc; i++) coarse.push((r() - 0.5) * 2 * coarseAmp);
  for (let y = 0; y < size; y += cell) for (let x = 0; x < size; x += cell) {
    const blotch = nc ? coarse[Math.floor(y / coarseCell) * nc + Math.floor(x / coarseCell)] : 0;
    const v = Math.max(0, Math.min(255, base + blotch + (r() - 0.5) * 2 * amp));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, cell, cell);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

type Box = { min: THREE.Vector3; max: THREE.Vector3; mesh?: THREE.Mesh };

export interface Command { cmd: string; speed: number | null; yaw_rate: number | null; S: number | null; dLR: number | null }

export class Inspection {
  readonly scene = new THREE.Scene();
  readonly fpv: THREE.PerspectiveCamera;
  readonly drone = new THREE.Group();
  readonly target = new THREE.WebGLRenderTarget(CAM_R, CAM_R, { samples: 4 });
  k = 0; t = 0; x: number; z: number; yaw: number; speed = 0;
  collided = false; arrived = false; contactK: number | null = null; minClearance = Infinity;
  wp = 0; wpStartT = 0; wpStatus: WaypointStatus[];
  private posts: THREE.Vector2[] = [];
  private boxes: Box[] = [];
  private debris: Box | null = null;
  /** Viewer chase-camera placement for this scene (see dress.ts ChaseView). */
  chaseRig = { back: 3.2, up: 2.6, ahead: 2.0, lookY: 1.0 };
  private rgba = new Uint8Array(CAM_R * CAM_R * 4);

  constructor(readonly spec: EpisodeSpec) {
    this.x = spec.startX; this.z = spec.startZ; this.yaw = spec.heading;
    this.wpStatus = spec.waypoints.map(() => 'pending' as WaypointStatus);
    const s = this.scene;
    const pal = palette();
    s.background = new THREE.Color(0xb8bdb8);
    // Fly-camera lights (EYE layer): unchanged from the benchmark. The chase camera has its own.
    s.add(onLayer(new THREE.HemisphereLight(0xffffff, 0x555555, 1.6), EYE));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(4, 8, 3); s.add(onLayer(sun, EYE));
    addChaseEnvironment(s);
    addAtmosphere(s, new THREE.Vector3(-5, 0.1, -12), new THREE.Vector3(5, 3.5, 8));
    if (spec.scenario !== 'house') addRuin(s);
    this.chaseRig = spec.scenario === 'house' ? { back: 3.4, up: 4.0, ahead: 1.4, lookY: 0.5 } : { back: 2.8, up: 2.7, ahead: 2.0, lookY: 1.1 };

    // Concrete-like ground: 2 cm grain with broad stains (texture spans 5 m).
    const groundTex = noiseTexture(11, 512, 128, 22, 2, 18, 64); groundTex.repeat.set(12, 12);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ map: groundTex }));
    ground.rotation.x = -Math.PI / 2; s.add(ground);
    const concrete = pal.concrete.clone(); concrete.map = pal.concrete.map!.clone(); concrete.map.repeat.set(10, 10);
    twin(ground, concrete).castShadow = false;

    if (spec.scenario === 'house') this.buildHouse();
    else this.buildCarport();

    const goal = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.05, 24), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    goal.position.set(spec.goalX, 0.03, spec.goalZ); s.add(goal);
    for (const w of spec.waypoints.slice(0, -1)) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 8, 32), new THREE.MeshLambertMaterial({ color: 0xe0a33c }));
      ring.rotation.x = Math.PI / 2; ring.position.set(w.x, 0.03, w.z); ring.name = `waypoint-${w.id}`; s.add(ring);
    }
    // Viewer-only beacons over each waypoint, so the route reads at a glance.
    for (const [i, w] of spec.waypoints.entries()) {
      const last = i === spec.waypoints.length - 1;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: last ? 0x6cc48a : 0xe0a33c, transparent: true, opacity: 0.25, depthWrite: false }));
      beam.position.set(w.x, 1.1, w.z); beam.name = `beacon-${i}`;
      s.add(onLayer(beam, CHASE));
    }
    if (spec.person) {
      const figure = makePerson(); figure.position.set(spec.goalX, 0, spec.goalZ - 0.3);
      if (spec.scenario === 'house') {
        figure.rotation.y = 0.6; s.add(figure); // new scene: the fly camera sees the figure too
      } else {
        // Benchmark scene: the fly camera keeps the measured capsule; the viewer sees a figure.
        const skin = new THREE.MeshLambertMaterial({ color: 0xc9a27e }), cloth = new THREE.MeshLambertMaterial({ color: 0x2f5d8a });
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 1.1, 4, 12), cloth);
        body.rotation.z = Math.PI / 2; body.position.set(spec.goalX, 0.18, spec.goalZ - 0.3); s.add(onLayer(body, EYE));
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), skin);
        head.position.set(spec.goalX + 0.8, 0.2, spec.goalZ - 0.3); s.add(onLayer(head, EYE));
        figure.position.x -= 0.1; s.add(onLayer(figure, CHASE));
      }
    }

    if (spec.debris) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2 * DEBRIS_HALF.x, 2 * DEBRIS_HALF.y, 2 * DEBRIS_HALF.z), new THREE.MeshLambertMaterial({ map: noiseTexture(53, 64, 120, 40, 8) }));
      twin(m, pal.panel);
      this.debris = { min: new THREE.Vector3(), max: new THREE.Vector3(), mesh: m };
      s.add(m);
      this.placeDebris();
    }

    this.fpv = new THREE.PerspectiveCamera(spec.fovDeg, 1, 0.05, 60);
    this.fpv.layers.enable(EYE);
    this.drone.add(this.fpv);
    const body = makeDrone();
    body.visible = false;
    this.drone.add(body);
    s.add(this.drone);
    this.pose();
  }

  /** The benchmark carport (fly camera: exactly as measured; viewer: coloured twins). */
  private buildCarport() {
    const s = this.scene, spec = this.spec, pal = palette();
    const dark = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    const wood = new THREE.MeshLambertMaterial({ map: noiseTexture(23, 64, 90, 25, 4) });
    for (const px of [-POST_X, POST_X]) for (const pz of [0, BACK_Z]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, POST_H, 12), dark);
      m.position.set(px, POST_H / 2, pz); s.add(m); this.posts.push(new THREE.Vector2(px, pz));
      twin(m, pal.rust);
    }
    // Front beam, sagging as a parabola toward the middle; approximated by 14 boxes.
    const n = 14, w = (2 * POST_X) / n;
    for (let i = 0; i < n; i++) {
      const cx = -POST_X + (i + 0.5) * w;
      const bottom = BEAM_TOP - 0.2 - spec.beamSag * (1 - (cx / POST_X) ** 2);
      this.addBox(new THREE.Vector3(cx - w / 2, bottom, -0.075), new THREE.Vector3(cx + w / 2, bottom + 0.2, 0.075), wood, pal.wood);
    }
    this.addBox(new THREE.Vector3(-POST_X, BEAM_TOP - 0.2, BACK_Z - 0.075), new THREE.Vector3(POST_X, BEAM_TOP, BACK_Z + 0.075), wood, pal.wood);
    const roof = new THREE.MeshLambertMaterial({ map: noiseTexture(37, 128, 150, 30, 8) });
    this.addBox(new THREE.Vector3(-1.7, 2.35, BACK_Z - 0.3), new THREE.Vector3(1.7, 2.45, 0.3), roof, pal.roof);
    const brick = noiseTexture(41, 256, 110, 55, 16); brick.repeat.set(4, 1);
    const brickC = pal.brick.clone(); brickC.map = pal.brick.map!.clone(); brickC.map.repeat.set(5, 1);
    this.addBox(new THREE.Vector3(-10, 0, -11.2), new THREE.Vector3(10, 4, -11), new THREE.MeshLambertMaterial({ map: brick }), brickC);
    for (const [i, bx] of [-3.2, 3.4].entries()) this.addBox(new THREE.Vector3(bx - 0.3, 0, -2.3), new THREE.Vector3(bx + 0.3, 1.0, -1.7), dark, i ? pal.bin2 : pal.bin);
  }

  /** A gutted house; seen by both cameras except the viewer's cutaway walls and ceiling. */
  private buildHouse() {
    const pal = palette(), v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const tex = (m: THREE.MeshStandardMaterial, rx: number, ry: number) => { const c = m.clone(); c.map = m.map!.clone(); c.map.repeat.set(rx, ry); return c; };
    // Walls: full height for the fly camera (EYE), cut at H_CUT for the viewer (CHASE).
    const wall = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.max(x1 - x0, z1 - z0);
      this.addBox(v(x0, 0, z0), v(x1, H_CEIL, z1), tex(pal.plaster, len / 2, 1.3), null, EYE);
      const cut = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, H_CUT, z1 - z0), tex(pal.plaster, len / 2, 0.5));
      cut.position.set((x0 + x1) / 2, H_CUT / 2, (z0 + z1) / 2); cut.castShadow = cut.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 0.002, 0.01, z1 - z0 + 0.002), pal.wallCut);
      cap.position.set((x0 + x1) / 2, H_CUT, (z0 + z1) / 2);
      this.scene.add(onLayer(cut, CHASE), onLayer(cap, CHASE));
    };
    wall(-H_W - H_T, -12, -H_W, 2); wall(H_W, -12, H_W + H_T, 2);       // side walls
    wall(-H_W, -3 - H_T / 2, -1.7, -3 + H_T / 2);                        // half partition, left
    wall(-H_W, -12 - H_T, H_W, -12);                                     // back wall, far behind the target
    // Ceiling: the front third collapsed with the facade; the panel below hangs from its broken edge.
    this.addBox(v(-H_W, H_CEIL, -12), v(H_W, H_CEIL + 0.1, -1.1), tex(pal.plaster, 3, 5), null, EYE);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * H_W, 14), tex(pal.floorboards, 3, 6));
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.004, -5); floor.receiveShadow = true;
    this.scene.add(floor);
    // The facade collapsed entirely: only a low rubble line remains (a looming reflex cannot
    // tell a doorway from an obstacle; a door frame dead ahead reads as a collision).
    for (const [x0, x1] of [[-H_W, -1.1], [1.1, H_W]]) this.addBox(v(x0, 0, 1.9), v(x1, 0.35, 2.1), pal.plaster);
    // Hazards at drone height: a ceiling panel hanging into the living room (x varies by seed)
    // and a toppled wardrobe on the way to the target.
    const px = 0.2 + this.spec.clutter;
    this.addBox(v(px - 0.55, 0.75, -1.25), v(px + 0.55, H_CEIL, -1.15), pal.panel);
    this.addBox(v(-1.3, 0, -6.1), v(0.1, 1.9, -5.6), pal.wood);
    // Furniture below drone height (seen, not in the way): couch, table, bed, rubble.
    this.addBox(v(-3.1, 0, -2.6), v(-2.2, 0.8, -0.2), pal.fabric);
    this.addBox(v(1.6, 0, -2.4), v(2.6, 0.45, -1.6), pal.wood);
    this.addBox(v(1.6, 0, -11.9), v(3.1, 0.55, -9.8), pal.fabric);
    const r = rng(this.spec.seed * 7 + 3);
    for (let i = 0; i < 16; i++) {
      const x = -3 + 6 * r(), z = -11 + 12 * r(), sz = 0.08 + 0.2 * r();
      this.addBox(v(x, 0, z), v(x + sz, 0.05 + 0.15 * r(), z + sz * (0.5 + r())), i % 2 ? pal.panel : pal.plaster);
    }
  }

  private addBox(min: THREE.Vector3, max: THREE.Vector3, mat: THREE.Material, pretty: THREE.Material | null = null, layer = 0) {
    const size = max.clone().sub(min);
    const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    m.position.copy(min.clone().add(max).multiplyScalar(0.5));
    if (pretty) twin(m, pretty); else { m.layers.set(layer); m.castShadow = m.receiveShadow = true; }
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

  /** Bearing and distance to the current waypoint (the last one once all are resolved). */
  goal(): { bearing: number; dist: number } {
    const w = this.spec.waypoints[Math.min(this.wp, this.spec.waypoints.length - 1)];
    const dx = w.x - this.x, dz = w.z - this.z;
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
    if (c <= 0) {
      this.collided = true; this.contactK = this.k;
      if (this.wp < this.wpStatus.length) this.wpStatus[this.wp] = 'collided';
      return;
    }
    if (this.wp >= this.wpStatus.length) return;
    if (this.goal().dist < GOAL_RADIUS) this.nextWaypoint('reached');
    else if (!scripted && this.t >= HOVER_S && this.t - this.wpStartT > WAYPOINT_TIMEOUT_S) this.nextWaypoint('skipped');
  }

  private nextWaypoint(status: WaypointStatus) {
    this.wpStatus[this.wp] = status;
    this.wp += 1;
    this.wpStartT = this.t;
    if (this.wp >= this.wpStatus.length) this.arrived = this.wpStatus[this.wpStatus.length - 1] === 'reached';
  }

  /** Render the FPV camera to FRAME_R² grayscale, row 0 = top of the image. */
  frame(renderer: THREE.WebGLRenderer): Uint8Array {
    const body = this.drone.getObjectByName('body')!;
    const wasVisible = body.visible; body.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.fpv);
    renderer.readRenderTargetPixels(this.target, 0, 0, CAM_R, CAM_R, this.rgba);
    renderer.setRenderTarget(null);
    body.visible = wasVisible;
    const sum = new Float32Array(FRAME_R * FRAME_R);
    for (let y = 0; y < CAM_R; y++) {
      const row = FRAME_R - 1 - Math.floor(y / SUPERSAMPLE); // WebGL reads bottom-up
      for (let x = 0; x < CAM_R; x++) {
        const i = (y * CAM_R + x) * 4;
        sum[row * FRAME_R + Math.floor(x / SUPERSAMPLE)] += 0.299 * this.rgba[i] + 0.587 * this.rgba[i + 1] + 0.114 * this.rgba[i + 2];
      }
    }
    const out = new Uint8Array(FRAME_R * FRAME_R);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(sum[i] / (SUPERSAMPLE * SUPERSAMPLE));
    return out;
  }

  done(): boolean {
    return this.collided || this.wp >= this.wpStatus.length || this.t >= MAX_T_S || this.z < this.spec.goalZ - 1;
  }

  result() {
    return { collided: this.collided, contact_k: this.contactK, arrived: this.arrived, t: +this.t.toFixed(2),
             frames: this.k, min_clearance_m: +this.minClearance.toFixed(3), end: [+this.x.toFixed(3), +this.z.toFixed(3)],
             waypoints: this.spec.waypoints.map((w, i) => ({ id: w.id, status: this.wpStatus[i] })) };
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

/** Handles unsolicited reflex messages (eye.layout JSON, binary viz); true if consumed. */
export interface ReflexSideChannel { handle(data: string | ArrayBuffer): boolean }

/** WebSocket to the reflex. The server answers every request in order; eye.layout
 *  (on connect) and binary viz packets are not replies and go to `side` instead. */
export class ReflexLink {
  private ws!: WebSocket;
  private pending: ((msg: any) => void)[] = [];
  latest: any = null;
  constructor(private side?: ReflexSideChannel) {}

  // Vite dev proxies /ws/reflex to the reflex on :8001; the built UI is served by the mission
  // server on :8000, which has no reflex route, so it connects to :8001 directly.
  async open(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${import.meta.env.DEV ? location.host : `${location.hostname}:8001`}/ws/reflex`) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => {
      if (this.side?.handle(e.data)) return;
      if (typeof e.data !== 'string') return; // binary viz with no side channel
      const msg = JSON.parse(e.data);
      if (msg.type === 'eye.layout') return;
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
