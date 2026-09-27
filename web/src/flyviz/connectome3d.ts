// README Step 7.4: 3D connectome view. Our flyvis deviations (45,669 nodes, our node order) are
// projected onto the male-CNS neurons that fly-brain maps to flyvis nodes (left eye), drawn as
// skeletons in a separate Three.js renderer and colored from a per-neuron activity texture (the
// approach of fly-brain's viewer, src/main.js). All other neurons are dim somas.
//
// Node order: fly-brain's flyvis node order (vision/flyvis.bin) was checked to be identical to
// data/flyvis_layout.json by (type, u, v); see tools/check_flybrain_map.py and
// data/flybrain_node_map.json. The map's node indices are therefore used directly.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadNeurons, loadSkeletons, type NeuronTable, type Skeletons } from '../../vendor/fly-brain/data.js';

export const CONNECTOME_LABEL = 'flyvis activity projected onto matching connectome neurons';
export const CONNECTOME_ATTRIBUTION =
  'Neuron skeletons, somas and the flyvis→neuron map: fly-brain (Lulzx, MIT) · ' +
  'male CNS v1.0 connectome (Janelia FlyEM & Google, CC-BY 4.0) · ' +
  'flyvis model (Lappalainen et al. 2024, MIT)';
export const FLYVIS_NODES = 45_669;
/** |deviation from rest| that maps to full brightness (deviation units, clipped above). */
export const DEFAULT_ACTIVITY_SCALE = 0.5;

const BASE = `${import.meta.env.BASE_URL}fly-brain/`;
const TEX_W = 2048;
const SOMA_UM = 8 / 1000; // neurons.flyn somas are 8 nm voxels; skeletons are in µm

interface FlyvisMap { eyes: Record<string, { pairs: [number, number][] }> }

export interface ConnectomeOptions {
  eye?: 'L' | 'R';
  activityScale?: number;
  onStatus?: (s: string) => void;
}

export interface ConnectomeStats {
  neurons: number;
  mappedNeurons: number;
  mappedNodes: number;
  skeletonVertices: number;
  skeletonSegments: number;
  loadMs: number;
}

const VERT = `
  attribute float nid;
  uniform sampler2D actTex; uniform float texW, texH, pointSize;
  varying float vAct;
  void main() {
    vec2 uv = vec2((mod(nid, texW) + 0.5) / texW, (floor(nid / texW) + 0.5) / texH);
    vAct = texture2D(actTex, uv).r;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = pointSize * (1.0 + 1.5 * abs(vAct));
  }`;
const FRAG = `
  uniform float baseOpacity;
  varying float vAct;
  void main() {
    float a = clamp(abs(vAct), 0.0, 1.0);
    vec3 base = vec3(0.36, 0.45, 0.62);
    vec3 hot = vAct >= 0.0 ? vec3(1.0, 0.72, 0.25) : vec3(0.30, 0.62, 1.0);
    vec3 col = mix(base, hot, a);
    gl_FragColor = vec4(col * (0.5 + 1.0 * a), mix(baseOpacity, 0.12, a));
  }`;

export class Connectome3D {
  readonly stats: ConnectomeStats;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private actTex: THREE.DataTexture;
  private act: Float32Array;
  private pairNeuron: Uint32Array;
  private pairNode: Uint32Array;
  private scale: number;
  private frame = 0;
  private resize: ResizeObserver;
  private overlay: HTMLDivElement;

  /** Loads the vendored fly-brain assets and builds the view inside `container`. */
  static async create(container: HTMLElement, opts: ConnectomeOptions = {}): Promise<Connectome3D> {
    const t0 = performance.now();
    const status = opts.onStatus ?? (() => {});
    const eye = opts.eye ?? 'L';
    const [map, neurons, skel] = await Promise.all([
      fetch(`${BASE}vision/flyvis_map.json`).then((r) => {
        if (!r.ok) throw new Error(`flyvis_map.json: ${r.status}`);
        return r.json() as Promise<FlyvisMap>;
      }),
      loadNeurons(status),
      loadSkeletons(status),
    ]);
    const pairs = map.eyes[eye]?.pairs;
    if (!pairs?.length) throw new Error(`flyvis_map.json has no pairs for eye ${eye}`);
    if (skel.N !== neurons.N) throw new Error(`skeletons (${skel.N}) and neurons (${neurons.N}) disagree`);
    status('building geometry');
    const view = new Connectome3D(container, neurons, skel, pairs, opts.activityScale ?? DEFAULT_ACTIVITY_SCALE);
    view.stats.loadMs = performance.now() - t0;
    return view;
  }

  private constructor(container: HTMLElement, neurons: NeuronTable, skel: Skeletons,
    pairs: [number, number][], scale: number) {
    const N = neurons.N;
    this.scale = scale;
    this.pairNeuron = new Uint32Array(pairs.length);
    this.pairNode = new Uint32Array(pairs.length);
    const mapped = new Uint8Array(N);
    const nodes = new Set<number>();
    pairs.forEach(([n, k], i) => {
      if (n < 0 || n >= N || k < 0 || k >= FLYVIS_NODES) throw new Error(`map pair ${i} out of range`);
      this.pairNeuron[i] = n; this.pairNode[i] = k; mapped[n] = 1; nodes.add(k);
    });

    // Per-neuron activity texture (signed, scaled to [-1, 1]), as in fly-brain's viewer.
    const texH = Math.ceil(N / TEX_W);
    this.act = new Float32Array(TEX_W * texH);
    this.actTex = new THREE.DataTexture(this.act, TEX_W, texH, THREE.RedFormat, THREE.FloatType);
    this.actTex.magFilter = this.actTex.minFilter = THREE.NearestFilter;
    this.actTex.needsUpdate = true;
    const uniforms = {
      actTex: { value: this.actTex }, texW: { value: TEX_W }, texH: { value: texH },
      baseOpacity: { value: 0.006 }, pointSize: { value: 2.0 * Math.min(devicePixelRatio, 2) },
    };
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

    // Skeletons of the mapped neurons only.
    const newIndex = new Int32Array(skel.V).fill(-1);
    let nv = 0;
    for (let n = 0; n < N; n++) if (mapped[n]) for (let v = skel.vOff[n]; v < skel.vOff[n + 1]; v++) newIndex[v] = nv++;
    const pos = new Float32Array(nv * 3), nid = new Float32Array(nv);
    for (let n = 0; n < N; n++) {
      if (!mapped[n]) continue;
      for (let v = skel.vOff[n]; v < skel.vOff[n + 1]; v++) {
        const j = newIndex[v];
        pos[j * 3] = skel.pos[v * 3]; pos[j * 3 + 1] = skel.pos[v * 3 + 1]; pos[j * 3 + 2] = skel.pos[v * 3 + 2];
        nid[j] = n;
      }
    }
    const segs = new Uint32Array(skel.seg.length);
    let ns = 0;
    for (let s = 0; s < skel.seg.length; s += 2) {
      const a = newIndex[skel.seg[s]], b = newIndex[skel.seg[s + 1]];
      if (a >= 0 && b >= 0) { segs[ns++] = a; segs[ns++] = b; }
    }
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lineGeom.setAttribute('nid', new THREE.BufferAttribute(nid, 1));
    lineGeom.setIndex(new THREE.BufferAttribute(segs.slice(0, ns), 1));
    const lines = new THREE.LineSegments(lineGeom, material);
    lines.frustumCulled = false;
    this.scene.add(lines);

    // Somas: mapped ones share the activity shader, all other neurons are dim gray points.
    const mPos: number[] = [], mId: number[] = [], oPos: number[] = [];
    for (let n = 0; n < N; n++) {
      const x = neurons.soma[n * 3];
      if (!Number.isFinite(x)) continue;
      const p = [x * SOMA_UM, neurons.soma[n * 3 + 1] * SOMA_UM, neurons.soma[n * 3 + 2] * SOMA_UM];
      if (mapped[n]) { mPos.push(...p); mId.push(n); } else oPos.push(...p);
    }
    const mGeom = new THREE.BufferGeometry();
    mGeom.setAttribute('position', new THREE.Float32BufferAttribute(mPos, 3));
    mGeom.setAttribute('nid', new THREE.Float32BufferAttribute(mId, 1));
    const mPoints = new THREE.Points(mGeom, material);
    mPoints.frustumCulled = false;
    this.scene.add(mPoints);
    const oGeom = new THREE.BufferGeometry();
    oGeom.setAttribute('position', new THREE.Float32BufferAttribute(oPos, 3));
    const others = new THREE.Points(oGeom, new THREE.PointsMaterial({ color: 0x8090a8, size: 1.2,
      sizeAttenuation: false, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending }));
    others.frustumCulled = false;
    this.scene.add(others);

    this.stats = { neurons: N, mappedNeurons: pairs.length, mappedNodes: nodes.size,
      skeletonVertices: nv, skeletonSegments: ns / 2, loadMs: 0 };

    // Camera on the mapped optic lobe, far enough out to show the whole brain around it.
    lineGeom.computeBoundingBox();
    const lobe = lineGeom.boundingBox!.getCenter(new THREE.Vector3());
    const [x0, y0, z0, x1, y1, z1] = skel.bbox;
    const extent = Math.max(x1 - x0, y1 - y0, z1 - z0);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070b);
    container.style.position ||= 'relative';
    container.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 20 * extent);
    this.camera.up.set(0, -1, 0); // EM y axis points ventral
    this.camera.position.copy(lobe).add(new THREE.Vector3(0.35, -0.25, -1).normalize().multiplyScalar(extent * 0.9));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(lobe);
    this.controls.enableDamping = true;
    this.controls.update();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:absolute;left:10px;right:10px;top:8px;pointer-events:none;' +
      'font:12px/1.4 Inter,"Segoe UI",Arial,sans-serif;color:#dfe6f2;text-shadow:0 1px 2px #000';
    const swatch = (c: string) => `<i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};margin:0 4px 0 10px;vertical-align:-1px"></i>`;
    this.overlay.innerHTML =
      `<div style="font-weight:700;font-size:13px">${CONNECTOME_LABEL}</div>` +
      `<div style="color:#a9b4c6">${pairs.length.toLocaleString()} left-eye neurons mapped to ${nodes.size.toLocaleString()} ` +
      `flyvis nodes by cell type and column (approximate). Brightness = |deviation from rest| / ${scale}, clipped.</div>` +
      `<div>${swatch('#ffb840')}above rest${swatch('#4d9eff')}below rest${swatch('#5c7394')}mapped, at rest` +
      `${swatch('#3a4250')}other neurons (not driven)</div>`;
    const credit = document.createElement('div');
    credit.style.cssText = 'position:absolute;left:10px;right:10px;bottom:6px;pointer-events:none;' +
      'font:11px/1.3 Inter,"Segoe UI",Arial,sans-serif;color:#8591a5';
    credit.textContent = CONNECTOME_ATTRIBUTION;
    container.append(this.overlay, credit);

    const fit = () => {
      const w = container.clientWidth || 1, h = container.clientHeight || 1;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    this.resize = new ResizeObserver(fit);
    this.resize.observe(container);
    fit();
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  /** deviation: every flyvis node's activity − rest, our node order (length 45,669). */
  setActivity(deviation: Float32Array): void {
    if (deviation.length !== FLYVIS_NODES) throw new Error(`expected ${FLYVIS_NODES} deviations, got ${deviation.length}`);
    const act = this.act, inv = 1 / this.scale;
    for (let i = 0; i < this.pairNeuron.length; i++) {
      const x = deviation[this.pairNode[i]] * inv;
      act[this.pairNeuron[i]] = x > 1 ? 1 : x < -1 ? -1 : x;
    }
    this.actTex.needsUpdate = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.actTex.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.nextSibling?.remove();
    this.overlay.remove();
  }
}
