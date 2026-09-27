// Step 7.3 circuit view: all 65 flyvis cell types in fixed columns, receptors → lamina →
// medulla → T4/T5, then our engineered looming readout (reflex/looming.py; NOT flyvis cells)
// → brake / turn. Edges are the strongest 3 inputs per displayed type from layout.type_edges
// (thickness = weight, colour = sign). Node brightness = the type's mean |deviation from
// rest| over all its nodes, from the latest streamed viz packet. Our readout's inner values
// (cone score, unit responses) are not streamed, so those nodes stay unlit; only S (header),
// the brake and the turn (header cmd) are live.
import type { EyeLayout, VizHeader } from './stream';

export type ReadoutKind = 'learned' | 'default' | null; // reflex /health "readout"

const SVG = 'http://www.w3.org/2000/svg';
const W = 1040, H = 600;
const COLS: { title: string; x: number; groups: { label?: string; types: string[] }[] }[] = [
  { title: 'Photoreceptors', x: 70, groups: [{ types: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'] }] },
  { title: 'Lamina', x: 220, groups: [{ types: ['L1', 'L2', 'L3', 'L4', 'L5', 'Lawf1', 'Lawf2', 'Am', 'C2', 'C3'] }] },
  { title: 'Medulla inputs', x: 380, groups: [{ label: 'ON', types: ['Mi1', 'Tm3', 'Mi4', 'Mi9'] }, { label: 'OFF', types: ['Tm1', 'Tm2', 'Tm4', 'Tm9'] }] },
  { title: 'T4 / T5 (motion)', x: 540, groups: [{ types: ['T4a', 'T4b', 'T4c', 'T4d'] }, { types: ['T5a', 'T5b', 'T5c', 'T5d'] }] },
];
const TOP = 70, BOTTOM = 440, OTHER_Y = 500;
const EXC = '#e0a33c', INH = '#5bb0ef', READOUT = '#c7cfdb';
const PEAK_DECAY = 0.97;

interface NodeG { g: SVGGElement; shape: SVGElement; title: SVGTitleElement; x: number; y: number; r: number }

export interface CircuitStats { updates: number; brakeFlashes: number }

export class CircuitView {
  readonly el: HTMLDivElement;
  readonly stats: CircuitStats = { updates: 0, brakeFlashes: 0 };
  private readonly svg: SVGSVGElement;
  private readonly nodes = new Map<string, NodeG>();
  private readonly typeNodes: Int32Array[]; // per layout type index: its node indices
  private readonly mean: Float32Array;
  private readonly main = new Set<string>();
  private peak = 0;
  private readonly note: HTMLDivElement;
  private readonly sText: SVGTextElement;
  private readonly turnText: SVGTextElement;
  private lastCmd: string | null = null;

  constructor(host: HTMLElement, private readonly layout: EyeLayout, private readonly readout: ReadoutKind) {
    this.el = document.createElement('div');
    this.el.className = 'fv-circuit';
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.note = document.createElement('div'); this.note.className = 'fv-legend';
    this.el.append(this.svg, this.note);
    host.appendChild(this.el);

    const T = layout.types.length;
    const lists: number[][] = Array.from({ length: T }, () => []);
    layout.node_type.forEach((t, n) => lists[t].push(n));
    this.typeNodes = lists.map((l) => Int32Array.from(l));
    this.mean = new Float32Array(T);

    const edgeLayer = el('g', {}), nodeLayer = el('g', {});
    this.svg.append(edgeLayer, nodeLayer);

    // Fixed flyvis columns.
    for (const col of COLS) {
      nodeLayer.append(text(col.x, 40, col.title, { 'text-anchor': 'middle', fill: '#a9b4c6', 'font-size': 13, 'font-weight': 600 }));
      const all = col.groups.flatMap((g) => g.types);
      const gap = col.groups.length > 1 ? 22 : 0;
      const step = Math.min(40, (BOTTOM - TOP - gap * (col.groups.length - 1)) / Math.max(1, all.length - 1));
      let y = TOP;
      col.groups.forEach((grp, gi) => {
        if (grp.label) nodeLayer.append(text(col.x - 58, y + 4, grp.label, { fill: '#6e7a8d', 'font-size': 10, 'text-anchor': 'end' }));
        for (const t of grp.types) {
          if (!layout.types.includes(t)) continue;
          this.addNode(nodeLayer, t, col.x, y, 13, t);
          this.main.add(t);
          y += step;
        }
        if (gi < col.groups.length - 1) y += gap;
      });
    }

    // Every other flyvis type, dimmed, so all 65 are present.
    const others = layout.types.filter((t) => !this.main.has(t));
    nodeLayer.append(text(20, OTHER_Y - 26, `Other medulla / lobula flyvis types (${others.length}; dimmed)`, { fill: '#6e7a8d', 'font-size': 11 }));
    const perRow = Math.ceil(others.length / 2), dx = (W - 60) / perRow;
    others.forEach((t, i) => this.addNode(nodeLayer, t, 40 + dx * (i % perRow), OTHER_Y + 50 * Math.floor(i / perRow), 7, t, true));

    // Engineered readout (reflex/looming.py): clearly outside flyvis.
    const bx = 640, bw = 250;
    nodeLayer.append(el('rect', { x: bx, y: 52, width: bw, height: 390, rx: 10, fill: 'none', stroke: '#e0a33c', 'stroke-dasharray': '6 5', 'stroke-width': 1.2 }));
    nodeLayer.append(text(bx + bw / 2, 40, 'Our readout — not flyvis cells', { 'text-anchor': 'middle', fill: '#e0a33c', 'font-size': 13, 'font-weight': 600 }));
    const learned = this.readout === 'learned';
    const coneY = 130, unitsY = 250, sY = 370;
    this.addBox(nodeLayer, 'cone', bx + 20, coneY - 34, bw - 40, 68, 'Cone',
      learned ? 'outward − inward T4/T5 per column,\nGaussian-weighted at the image centre' : this.readout === 'default' ? 'not used by the default readout' : 'readout kind unknown (reflex /health)');
    this.addBox(nodeLayer, 'units', bx + 20, unitsY - 34, bw - 40, 68, 'LPLC2-style units ×7',
      '4 branches, radial motion opponency;\n2d / horiz / vert pathways' + (learned ? ', fitted weights' : ''));
    this.addBox(nodeLayer, 'S', bx + 20, sY - 34, bw - 40, 68, 'Looming score S',
      learned ? 'S = max(cone/θc, 1 + units − θu)' : this.readout === 'default' ? 'S = max(2d, horiz), each scaled' : 'S from the viz header');
    this.sText = text(bx + bw - 30, sY - 12, '', { fill: '#e8edf5', 'font-size': 12, 'text-anchor': 'end' });
    nodeLayer.append(this.sText);

    // Commands, decided by the reflex controller (S > θ → brake, then a saccade).
    const cx = 960;
    nodeLayer.append(text(cx, 40, 'Command', { 'text-anchor': 'middle', fill: '#a9b4c6', 'font-size': 13, 'font-weight': 600 }));
    this.addNode(nodeLayer, 'Brake', cx, 300, 26, 'Brake', false, 'rect');
    this.addNode(nodeLayer, 'Turn', cx, 400, 22, 'Turn', false, 'rect');
    this.turnText = text(cx, 436, '', { fill: '#a9b4c6', 'font-size': 11, 'text-anchor': 'middle' });
    nodeLayer.append(this.turnText);

    // flyvis edges: strongest 3 inputs of each displayed type.
    const maxW = Math.max(...layout.type_edges.map((e) => e.weight));
    const byDst = new Map<string, typeof layout.type_edges>();
    for (const e of layout.type_edges) (byDst.get(e.dst) ?? byDst.set(e.dst, []).get(e.dst)!).push(e);
    let shown = 0;
    for (const dst of this.main) {
      const top3 = (byDst.get(dst) ?? []).slice().sort((a, b) => b.weight - a.weight).slice(0, 3);
      for (const e of top3) {
        const a = this.nodes.get(e.src), b = this.nodes.get(e.dst);
        if (!a || !b) continue;
        const dim = !this.main.has(e.src);
        edgeLayer.append(el('path', {
          d: curve(a, b), fill: 'none', stroke: e.sign > 0 ? EXC : INH,
          'stroke-width': (0.4 + 3.6 * Math.log1p(e.weight) / Math.log1p(maxW)).toFixed(2),
          'stroke-opacity': dim ? 0.18 : 0.55,
        }, `${e.src} → ${e.dst}: weight ${e.weight.toFixed(1)}, ${e.sign > 0 ? 'excitatory' : 'inhibitory'}`));
        shown++;
      }
    }
    // Our readout edges (dashed): T4/T5 → cone and units → S → brake / turn.
    const dash = { fill: 'none', stroke: READOUT, 'stroke-dasharray': '5 4', 'stroke-width': 1, 'stroke-opacity': 0.6 };
    const cone = this.nodes.get('cone')!, units = this.nodes.get('units')!, S = this.nodes.get('S')!;
    for (const t of this.layout.t4t5_types) {
      const a = this.nodes.get(t); if (!a) continue;
      if (learned) edgeLayer.append(el('path', { d: curve(a, cone), ...dash }, 'our readout: rectified T4/T5 drive'));
      edgeLayer.append(el('path', { d: curve(a, units), ...dash }, 'our readout: rectified T4/T5 drive'));
    }
    if (learned) edgeLayer.append(el('path', { d: `M${cone.x},${cone.y + 34} L${S.x},${S.y - 34}`, ...dash }));
    edgeLayer.append(el('path', { d: `M${units.x},${units.y + 34} L${S.x},${S.y - 34}`, ...dash }));
    edgeLayer.append(el('path', { d: curve(S, this.nodes.get('Brake')!), ...dash }, 'S > θ → brake'));
    edgeLayer.append(el('path', { d: curve(S, this.nodes.get('Turn')!), ...dash }, 'after a brake: saccade away from the looming side (dLR)'));

    this.note.innerHTML = `node brightness = mean |deviation from rest| of all nodes of that flyvis type (latest viz packet) · ` +
      `edges: strongest 3 inputs per column type from layout.type_edges (${shown} shown; inputs to the dimmed types omitted), ` +
      `thickness = weight, <span style="color:${EXC}">excitatory</span> / <span style="color:${INH}">inhibitory</span> · ` +
      `dashed box and edges = our engineered readout (reflex/looming.py), not flyvis cells; cone and unit values are not streamed, so they stay unlit`;
  }

  private addNode(parent: SVGElement, key: string, x: number, y: number, r: number, label: string, dim = false, shape: 'circle' | 'rect' = 'circle') {
    const g = el('g', {}) as SVGGElement;
    const s = shape === 'circle'
      ? el('circle', { cx: x, cy: y, r, fill: '#141a24', stroke: dim ? '#253042' : '#3a4a62' })
      : el('rect', { x: x - r * 1.6, y: y - r * 0.8, width: r * 3.2, height: r * 1.6, rx: 6, fill: '#141a24', stroke: '#3a4a62' });
    const title = document.createElementNS(SVG, 'title');
    s.appendChild(title);
    g.append(s);
    if (shape === 'circle') {
      g.append(text(dim ? x : x + r + 6, dim ? y + r + 11 : y + 4, label, {
        fill: dim ? '#5d687a' : '#c7cfdb', 'font-size': dim ? 8.5 : 11, 'text-anchor': dim ? 'middle' : 'start',
      }));
    } else {
      g.append(text(x, y + 4, label, { fill: '#e8edf5', 'font-size': 12, 'text-anchor': 'middle', 'font-weight': 600 }));
    }
    parent.append(g);
    this.nodes.set(key, { g, shape: s, title, x, y, r });
  }

  private addBox(parent: SVGElement, key: string, x: number, y: number, w: number, h: number, head: string, sub: string) {
    const g = el('g', {}) as SVGGElement;
    const s = el('rect', { x, y, width: w, height: h, rx: 8, fill: '#10151e', stroke: '#6e5a33', 'stroke-dasharray': '4 3' });
    const title = document.createElementNS(SVG, 'title');
    s.appendChild(title);
    g.append(s, text(x + 10, y + 18, head, { fill: '#e8edf5', 'font-size': 12, 'font-weight': 600 }));
    sub.split('\n').forEach((line, i) => g.append(text(x + 10, y + 36 + 14 * i, line, { fill: '#8c98ab', 'font-size': 10.5 })));
    parent.append(g);
    this.nodes.set(key, { g, shape: s, title, x: x + w / 2, y: y + h / 2, r: h / 2 });
    title.textContent = key === 'S' ? 'S from the viz header' : 'value not streamed by the reflex (not drawn)';
  }

  /** Redraw from one viz packet: deviations (stream.latest) and its header. */
  update(dev: Float32Array, header: VizHeader) {
    const T = this.layout.types.length;
    let peak = 0;
    for (let t = 0; t < T; t++) {
      const nodes = this.typeNodes[t];
      let s = 0; for (let j = 0; j < nodes.length; j++) s += Math.abs(dev[nodes[j]]);
      this.mean[t] = nodes.length ? s / nodes.length : 0;
      if (this.mean[t] > peak) peak = this.mean[t];
    }
    this.peak = Math.max(peak, this.peak * PEAK_DECAY);
    const scale = this.peak || 1;
    this.layout.types.forEach((t, i) => {
      const n = this.nodes.get(t); if (!n) return;
      const a = Math.sqrt(Math.min(1, this.mean[i] / scale));
      const dim = !this.main.has(t);
      n.shape.setAttribute('fill', `hsl(38,${dim ? 45 : 85}%,${(8 + (dim ? 30 : 52) * a).toFixed(1)}%)`);
      n.title.textContent = `${t}: mean |deviation| ${this.mean[i].toPrecision(3)} over ${this.typeNodes[i].length} nodes`;
    });

    const theta = this.layout.S_theta;
    const S = this.nodes.get('S')!;
    if (theta !== null && theta > 0) {
      const a = Math.max(0, Math.min(1, header.S / theta));
      S.shape.setAttribute('fill', header.S > theta ? '#7a2a22' : `hsl(38,70%,${(6 + 30 * a).toFixed(1)}%)`);
    }
    this.sText.textContent = `S ${header.S.toFixed(3)}` + (theta !== null ? ` / θ ${theta}` : '');

    const brake = this.nodes.get('Brake')!, turn = this.nodes.get('Turn')!;
    const braking = header.cmd === 'brake', turning = header.cmd.startsWith('saccade_');
    brake.shape.setAttribute('fill', braking ? '#ef6a5b' : '#141a24');
    turn.shape.setAttribute('fill', turning ? '#5bb0ef' : '#141a24');
    this.turnText.textContent = turning ? header.cmd.replace('saccade_', 'saccade ') : '';
    if (braking && this.lastCmd !== 'brake') this.stats.brakeFlashes += 1;
    this.lastCmd = header.cmd;
    this.stats.updates += 1;
  }
}

function el(tag: string, attrs: Record<string, string | number>, title?: string): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (title) { const t = document.createElementNS(SVG, 'title'); t.textContent = title; e.appendChild(t); }
  return e;
}

function text(x: number, y: number, s: string, attrs: Record<string, string | number>): SVGTextElement {
  const t = el('text', {
    x, y, 'font-family': 'Inter, Segoe UI, Arial, sans-serif', 'paint-order': 'stroke', stroke: '#0a0e15', 'stroke-width': 3,
    'stroke-linejoin': 'round', ...attrs,
  }) as SVGTextElement;
  t.textContent = s;
  return t;
}

function curve(a: { x: number; y: number; r: number }, b: { x: number; y: number; r: number }): string {
  if (b.x > a.x + 1) {
    const x1 = a.x + a.r, x2 = b.x - b.r, mx = (x1 + x2) / 2;
    return `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`;
  }
  // Same column or feedback: loop out to the left of both.
  const x0 = Math.min(a.x, b.x) - Math.max(a.r, b.r) - 30 - Math.abs(a.y - b.y) * 0.15;
  return `M${a.x - a.r},${a.y} C${x0},${a.y} ${x0},${b.y} ${b.x - b.r},${b.y}`;
}
