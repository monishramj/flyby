// Step 7.2 looming trace: S over the last 10 s of frame time from VizStream.history(), with
// the reflex's brake threshold θ (eye.layout S_theta; the controller brakes when S > θ), a
// dLR subplot, and markers where the viz header's command changed to brake / saccade /
// arrived. The history is sampled at VIZ_HZ, so the markers are at 0.1 s resolution.
import {
  Chart, Legend, LinearScale, LineController, LineElement, PointElement, ScatterController, Tooltip,
} from 'chart.js';
import { HISTORY_S, type VizCmd, type VizStream } from './stream';

Chart.register(LineController, ScatterController, LineElement, PointElement, LinearScale, Legend, Tooltip);

type XY = { x: number; y: number };
const MARKS: { cmd: VizCmd; label: string; color: string; style: 'triangle' | 'rectRot' | 'rect' | 'star' }[] = [
  { cmd: 'brake', label: 'brake', color: '#ef6a5b', style: 'rect' },
  { cmd: 'saccade_left', label: 'saccade left', color: '#5bb0ef', style: 'triangle' },
  { cmd: 'saccade_right', label: 'saccade right', color: '#b98cf0', style: 'triangle' },
  { cmd: 'arrived', label: 'arrived', color: '#6fd08c', style: 'star' },
];
const GRID = '#1f2a3a', TICK = '#8c98ab';

export interface TraceStats { updates: number; points: number }

export class TraceView {
  readonly el: HTMLDivElement;
  readonly stats: TraceStats = { updates: 0, points: 0 };
  private readonly sChart: Chart;
  private readonly dChart: Chart;
  private readonly note: HTMLDivElement;

  constructor(host: HTMLElement, private readonly stream: VizStream) {
    this.el = document.createElement('div');
    this.el.className = 'fv-trace';
    const sBox = document.createElement('div'); sBox.className = 'fv-trace-s';
    const dBox = document.createElement('div'); dBox.className = 'fv-trace-d';
    const sCanvas = document.createElement('canvas'), dCanvas = document.createElement('canvas');
    sBox.appendChild(sCanvas); dBox.appendChild(dCanvas);
    this.note = document.createElement('div'); this.note.className = 'fv-legend';
    this.el.append(sBox, dBox, this.note);
    host.appendChild(this.el);

    const xScale = (title: string) => ({
      type: 'linear' as const, title: { display: !!title, text: title, color: TICK },
      grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 11 },
    });
    const common = {
      animation: false as const, responsive: true, maintainAspectRatio: false, parsing: false as const,
      normalized: true, plugins: { legend: { labels: { color: TICK, boxWidth: 10, font: { size: 11 } } }, tooltip: { enabled: true } },
    };
    this.sChart = new Chart(sCanvas, {
      type: 'line',
      data: {
        datasets: [
          { label: 'S (looming score)', data: [] as XY[], borderColor: '#e0a33c', borderWidth: 1.6, pointRadius: 0, tension: 0 },
          { label: 'θ (brake when S > θ)', data: [] as XY[], borderColor: '#ef6a5b', borderDash: [6, 4], borderWidth: 1.2, pointRadius: 0 },
          ...MARKS.map((m) => ({
            type: 'scatter' as const, label: m.label, data: [] as XY[], showLine: false,
            pointStyle: m.style, pointRadius: 6, backgroundColor: m.color, borderColor: m.color,
          })),
        ],
      },
      options: { ...common, scales: { x: xScale(''), y: { grid: { color: GRID }, ticks: { color: TICK }, title: { display: true, text: 'S', color: TICK } } } },
    });
    this.dChart = new Chart(dCanvas, {
      type: 'line',
      data: { datasets: [{ label: 'dLR (> 0: more looming on the left)', data: [] as XY[], borderColor: '#5bb0ef', borderWidth: 1.4, pointRadius: 0, tension: 0 }] },
      options: {
        ...common,
        scales: { x: xScale('frame time k·Δt (s)'), y: { grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 5 }, title: { display: true, text: 'dLR', color: TICK } } },
      },
    });
    this.note.textContent = 'waiting for viz packets (live mode only)';
  }

  /** Redraw from the stream's 10 s ring (call when a new viz packet arrived). */
  update() {
    const h = this.stream.history();
    const n = h.t.length;
    const S: XY[] = new Array(n), D: XY[] = new Array(n);
    for (let i = 0; i < n; i++) { S[i] = { x: h.t[i], y: h.S[i] }; D[i] = { x: h.t[i], y: h.dLR[i] }; }
    const t1 = n ? Math.max(h.t[n - 1], HISTORY_S) : HISTORY_S, t0 = t1 - HISTORY_S; // 0–10 s until 10 s have passed
    const theta = this.stream.layout?.S_theta ?? null;
    const sd = this.sChart.data.datasets;
    sd[0].data = S;
    sd[1].data = theta === null ? [] : [{ x: t0, y: theta }, { x: t1, y: theta }];
    MARKS.forEach((m, j) => {
      const pts: XY[] = [];
      for (let i = 0; i < n; i++) if (h.cmd[i] === m.cmd && (i === 0 || h.cmd[i - 1] !== m.cmd)) pts.push({ x: h.t[i], y: h.S[i] });
      sd[2 + j].data = pts;
    });
    this.dChart.data.datasets[0].data = D;
    for (const c of [this.sChart, this.dChart]) { c.options.scales!.x!.min = t0; c.options.scales!.x!.max = t1; }
    this.sChart.update('none');
    this.dChart.update('none');
    const last = this.stream.header;
    this.note.textContent = (theta === null ? 'θ not provided by the reflex (no line drawn) · ' : `θ = ${theta} from eye.layout · `) +
      `markers at command onsets, sampled at 10 Hz` + (last ? ` · frame ${last.k}: S ${last.S.toFixed(3)}, dLR ${last.dLR.toFixed(3)}, ${last.cmd}` : '');
    this.stats.updates += 1;
    this.stats.points = n;
  }
}
