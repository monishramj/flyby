// Step 7.2 eye view: the 721 flyvis columns drawn at their image position (layout col_x
// right, col_y up), coloured from the latest streamed deviations (stream.ts). Nothing here
// is simulated: every value is a deviation from rest of real flyvis nodes, grouped by
// layout.node_col. Layers:
//   receptors  mean deviation of R1–R6 per column (grey: dark = below rest, light = above)
//   motion     strongest rectified T4/T5 subtype per column; hue = its measured preferred
//              direction (layout.subtype_dir), brightness = its value
//   looming    (outward − inward) rectified T4+T5 per column, outward judged from the column's
//              own position (sign of col_x for left/right, sign of col_y for up/down), summed.
//              Computed here from the streamed deviations: no motion adaptation or EMA, so it
//              is NOT the reflex's cone score, only the same kind of quantity.
import type { EyeLayout } from './stream';

export type EyeLayer = 'receptors' | 'motion' | 'looming';
export const EYE_LAYERS: EyeLayer[] = ['receptors', 'motion', 'looming'];

const DIRS = ['left', 'right', 'up', 'down'] as const;
type Dir = (typeof DIRS)[number];
/** Hue per direction on a colour wheel (right = 0°, up = 90°, as the image axes). */
const DIR_HUE: Record<Dir, number> = { right: 0, up: 90, left: 180, down: 270 };
const RECEPTORS_R1_R6 = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
const PEAK_DECAY = 0.97; // per update: colour scale follows the recent peak, never a fixed guess

export interface EyeStats { updates: number; layer: EyeLayer; scale: number }

export class EyeView {
  readonly el: HTMLDivElement;
  readonly stats: EyeStats;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly legend: HTMLDivElement;
  private readonly nCols: number;
  private readonly recNodes: Int32Array[]; // per column: R1–R6 node indices
  private readonly dirNodes: Int32Array[][]; // [dir][subtype] → node per column (-1 if absent)
  private readonly dirs: Dir[]; // direction of each dirNodes row, measured (layout.subtype_dir)
  private readonly subtypes: string[][];
  private readonly outH: Int8Array; // per column: index in dirs of outward horizontal / vertical
  private readonly outV: Int8Array;
  private readonly values: Float32Array;
  private readonly hue: Float32Array;
  private peak: Record<EyeLayer, number> = { receptors: 0, motion: 0, looming: 0 };
  private hexPath: { dx: number[]; dy: number[] };
  private layer: EyeLayer = 'receptors';
  private last: Float32Array | null = null;

  constructor(host: HTMLElement, private readonly layout: EyeLayout, size = 360) {
    const L = layout;
    this.nCols = L.col_x.length;
    this.el = document.createElement('div');
    this.el.className = 'fv-eye';
    const tabs = document.createElement('div');
    tabs.className = 'fv-tabs';
    for (const name of EYE_LAYERS) {
      const b = document.createElement('button');
      b.textContent = name; b.dataset.layer = name;
      b.onclick = () => this.setLayer(name);
      tabs.appendChild(b);
    }
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.legend = document.createElement('div');
    this.legend.className = 'fv-legend';
    this.el.append(tabs, this.canvas, this.legend);
    host.appendChild(this.el);

    // Node index tables from the layout (native flyvis node order = viz body order).
    const typeIdx = new Map(L.types.map((t, i) => [t, i]));
    const rec = RECEPTORS_R1_R6.map((t) => typeIdx.get(t)).filter((i): i is number => i !== undefined);
    const recLists: number[][] = Array.from({ length: this.nCols }, () => []);
    const bySub = new Map<string, Int32Array>();
    for (const [sub] of Object.entries(L.subtype_dir)) bySub.set(sub, new Int32Array(this.nCols).fill(-1));
    const subOfType = new Map<number, Int32Array>();
    for (const [sub, arr] of bySub) { const ti = typeIdx.get(sub); if (ti !== undefined) subOfType.set(ti, arr); }
    for (let n = 0; n < L.node_type.length; n++) {
      const t = L.node_type[n], c = L.node_col[n];
      if (rec.includes(t)) recLists[c].push(n);
      const arr = subOfType.get(t);
      if (arr) arr[c] = n;
    }
    this.recNodes = recLists.map((l) => Int32Array.from(l));
    this.dirs = DIRS.filter((d) => Object.values(L.subtype_dir).includes(d));
    this.subtypes = this.dirs.map((d) => Object.keys(L.subtype_dir).filter((s) => L.subtype_dir[s] === d));
    this.dirNodes = this.subtypes.map((subs) => subs.map((s) => bySub.get(s)!));
    const di = (d: Dir) => this.dirs.indexOf(d);
    this.outH = Int8Array.from(L.col_x, (x) => (x > 0 ? di('right') : x < 0 ? di('left') : -1));
    this.outV = Int8Array.from(L.col_y, (y) => (y > 0 ? di('up') : y < 0 ? di('down') : -1));
    this.values = new Float32Array(this.nCols);
    this.hue = new Float32Array(this.nCols);
    this.hexPath = this.hexShape();
    this.stats = { updates: 0, layer: this.layer, scale: 0 };
    this.setLayer('receptors');
  }

  /** Flat-topped hexagon sized from the measured column spacing (col_x and col_y are scaled
   *  separately, so the lattice is not regular: use the real vertical and horizontal steps). */
  private hexShape() {
    const { col_x: x, col_y: y } = this.layout;
    let c0 = 0, best = Infinity;
    for (let i = 0; i < this.nCols; i++) { const r = x[i] ** 2 + y[i] ** 2; if (r < best) { best = r; c0 = i; } }
    let sv = Infinity, sh = Infinity;
    for (let j = 0; j < this.nCols; j++) {
      if (j === c0) continue;
      const dx = Math.abs(x[j] - x[c0]), dy = Math.abs(y[j] - y[c0]);
      if (dx < 1e-6) sv = Math.min(sv, dy); else if (Math.hypot(dx, dy) < 0.2) sh = Math.min(sh, dx);
    }
    const R = sh / 1.5, h = sv / 2;
    return { dx: [R, R / 2, -R / 2, -R, -R / 2, R / 2], dy: [0, h, h, 0, -h, -h] };
  }

  setLayer(layer: EyeLayer) {
    this.layer = layer;
    this.stats.layer = layer;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.fv-tabs button')) b.classList.toggle('on', b.dataset.layer === layer);
    if (this.last) this.update(this.last, false); else this.drawEmpty();
  }

  private drawEmpty() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.drawHexes(() => '#141a24');
    this.legend.textContent = 'waiting for viz packets (live mode only)';
  }

  /** Redraw from one deviation vector (stream.latest). */
  update(dev: Float32Array, count = true) {
    this.last = dev;
    const v = this.values, n = this.nCols;
    let maxAbs = 0;
    if (this.layer === 'receptors') {
      for (let c = 0; c < n; c++) {
        const nodes = this.recNodes[c];
        let s = 0; for (let j = 0; j < nodes.length; j++) s += dev[nodes[j]];
        v[c] = nodes.length ? s / nodes.length : NaN;
        if (Math.abs(v[c]) > maxAbs) maxAbs = Math.abs(v[c]);
      }
    } else {
      const drive = (d: number, c: number) => { // relu(T4) + relu(T5) of direction row d
        let s = 0; for (const arr of this.dirNodes[d]) { const k = arr[c]; if (k >= 0 && dev[k] > 0) s += dev[k]; }
        return s;
      };
      const opp = (d: number) => this.dirs.indexOf(({ left: 'right', right: 'left', up: 'down', down: 'up' } as const)[this.dirs[d]]);
      for (let c = 0; c < n; c++) {
        if (this.layer === 'motion') {
          let bestV = 0, bestD = -1;
          for (let d = 0; d < this.dirNodes.length; d++) for (const arr of this.dirNodes[d]) {
            const k = arr[c]; if (k >= 0 && dev[k] > bestV) { bestV = dev[k]; bestD = d; }
          }
          v[c] = bestV; this.hue[c] = bestD >= 0 ? DIR_HUE[this.dirs[bestD]] : -1;
        } else {
          let q = 0;
          const h = this.outH[c], vv = this.outV[c];
          if (h >= 0) q += drive(h, c) - drive(opp(h), c);
          if (vv >= 0) q += drive(vv, c) - drive(opp(vv), c);
          v[c] = q;
        }
        if (Math.abs(v[c]) > maxAbs) maxAbs = Math.abs(v[c]);
      }
    }
    const peak = this.peak[this.layer] = Math.max(maxAbs, this.peak[this.layer] * PEAK_DECAY);
    const scale = peak > 0 ? peak : 1;
    this.stats.scale = peak;

    const { ctx, canvas } = this;
    ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.layer === 'receptors') {
      this.drawHexes((c) => {
        if (Number.isNaN(v[c])) return '#000';
        const g = Math.round(128 + 127 * Math.max(-1, Math.min(1, v[c] / scale)));
        return `rgb(${g},${g},${g})`;
      });
      this.legend.innerHTML = `mean deviation of R1–R6 per column · grey = rest, dark = below, light = above · scale ±${fmt(peak)}`;
    } else if (this.layer === 'motion') {
      this.drawHexes((c) => {
        if (this.hue[c] < 0 || v[c] <= 0) return '#0b0f16';
        const l = Math.round(8 + 52 * Math.sqrt(Math.min(1, v[c] / scale)));
        return `hsl(${this.hue[c]},90%,${l}%)`;
      });
      this.legend.innerHTML = 'strongest rectified T4/T5 subtype per column · hue = its measured preferred direction: ' +
        this.dirs.map((d) => `<span style="color:hsl(${DIR_HUE[d]},90%,60%)">■ ${d} (${this.subtypes[this.dirs.indexOf(d)].join(', ')})</span>`).join(' ') +
        ` · brightness up to ${fmt(peak)}`;
    } else {
      this.drawHexes((c) => diverging(v[c] / scale));
      this.legend.innerHTML = `outward − inward rectified T4+T5 per column (from its own position), unadapted · ` +
        `<span style="color:#e8664f">■ outward</span> <span style="color:#4f8fe8">■ inward</span> · scale ±${fmt(peak)} · ` +
        'computed in the browser; not the reflex\'s cone score';
    }
    if (count) this.stats.updates += 1;
  }

  private drawHexes(color: (c: number) => string) {
    const { ctx, canvas } = this;
    const { col_x: x, col_y: y } = this.layout;
    const pad = 0.06, W = canvas.width, s = (W / 2) / (1 + pad);
    const { dx, dy } = this.hexPath;
    for (let c = 0; c < this.nCols; c++) {
      const cx = W / 2 + x[c] * s, cy = W / 2 - y[c] * s; // y up in the layout, down on canvas
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const px = cx + dx[i] * s * 0.96, py = cy - dy[i] * s * 0.96;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color(c);
      ctx.fill();
    }
  }
}

function diverging(t: number): string {
  const a = Math.max(-1, Math.min(1, t));
  if (!Number.isFinite(a)) return '#000';
  const m = Math.sqrt(Math.abs(a));
  return a >= 0
    ? `rgb(${Math.round(20 + 212 * m)},${Math.round(22 + 80 * m)},${Math.round(28 + 51 * m)})`
    : `rgb(${Math.round(20 + 59 * m)},${Math.round(22 + 121 * m)},${Math.round(28 + 204 * m)})`;
}

function fmt(v: number): string {
  return v === 0 ? '0' : Math.abs(v) >= 0.01 ? v.toFixed(3) : v.toExponential(1);
}
