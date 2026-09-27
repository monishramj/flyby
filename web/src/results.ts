import { Chart, BarController, BarElement, CategoryScale, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Tooltip);

// Dark categorical slots 1-3 plus a recessive neutral, validated against the panel surface
// (dataviz validate_palette.js: adjacent pairs pass CVD and normal-vision separation).
const BLUE = '#3987e5', ORANGE = '#d95926', GREEN = '#199e70';
const MUTED = '#4d5d62', GRID = '#26343a', SURFACE = '#172024';
Chart.defaults.color = '#94a5a0';
Chart.defaults.borderColor = GRID;

type Arm = Record<string, any>;
type Summary = { seeds: number[]; generated_at: string; assumptions: Record<string, unknown>; arms: Record<string, Arm> };

const ACTION_LABEL: Record<string, string> = {
  dispatch_ground_team: 'Send crew', reimage_zoom: 'Zoom photo', close_in_inspect: 'Close-in look', ignore: 'Not a person',
};
const ROUTE_LABEL: Record<string, string> = { no_human: 'Handled without you', one_click: 'One-click approval', needed_judgment: 'Needed your judgment' };
// Cleared is the expected outcome, so it recedes; the three outcomes a judge should notice carry the hues.
const OUTCOMES: [string, string, string][] = [
  ['cleared', 'Not a person, cleared', MUTED], ['person_reached', 'Real person, crew sent', BLUE],
  ['person_missed', 'Real person, no crew', ORANGE], ['empty_dispatch', 'Crew sent, no one there', GREEN],
];

const charts: Chart[] = [];
const pct = (value: number | null | undefined) => (value == null ? '—' : `${Math.round(value * 100)}%`);
const secs = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const minutes = (s: number | null | undefined) => (s == null ? '—' : s < 120 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
const sum = (row: Record<string, number>) => Object.values(row).reduce((a, b) => a + b, 0);

async function load<T>(name: string): Promise<T | null> {
  try {
    const response = await fetch(`/api/results/${name}`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function renderResults(root: HTMLElement) {
  root.innerHTML = '<p class="empty">Loading results…</p>';
  const [summary, grok, finetune] = await Promise.all([load<Summary>('summary.json'), load<any>('grok.json'), load<any>('finetune.json')]);
  if (!summary?.arms.laya) {
    root.innerHTML = `<p class="empty">No evaluation yet. Run <code>uv run python -m batch.run_eval</code> to produce <code>results/summary.json</code>.</p>`;
    return;
  }
  charts.splice(0).forEach(chart => chart.destroy());
  const arm = summary.arms.laya;
  root.innerHTML = `
    ${headline(arm)}
    ${flowSection(arm)}
    ${confidenceSection(arm)}
    ${grokSection(grok)}
    ${finetuneSection(finetune)}
    <details class="assumptions">
      <summary>Simulation assumptions · ${summary.seeds.length} missions · generated ${new Date(summary.generated_at).toLocaleString()}</summary>
      <p>Detector rates and commander behaviour are declared simulation assumptions, not measured performance.</p>
      <pre>${JSON.stringify(summary.assumptions, null, 1)}</pre>
    </details>`;
  drawFlow(root, arm);
  drawConfidence(root, arm);
  if (grok) drawGrok(root, grok);
  if (finetune) drawFinetune(root, finetune);
}

const tile = (label: string, value: string, note: string, tone = '') =>
  `<article class="kpi ${tone}"><h4>${label}</h4><p class="value">${value}</p><p class="note">${note}</p></article>`;

function headline(arm: Arm): string {
  const load = arm.human_load, flow = arm.flag_flow;
  return `<section class="kpis">
    ${tile('Real people reached a crew', `${arm.subjects.dispatched}<small> of ${arm.subjects.placed}</small>`,
      `${flow.people_never_flagged} were never flagged by the camera`, 'hero')}
    ${tile('Flags handled without you', `${load.no_human}<small> of ${load.flags}</small>`,
      `${load.people_closed_without_human} of them were real people`, load.people_closed_without_human ? 'warn' : '')}
    ${tile('First sighting to crew', minutes(arm.time_to_dispatch_s.median),
      `median, people in the open · under a roof ${minutes(arm.under_structure_time_to_dispatch_s.median)}`)}
    ${tile('Laya decides in', `${Math.round(arm.latency_ms.p50)}<small> ms</small>`, `per flag, on CPU · slowest 5%: ${Math.round(arm.latency_ms.p95)} ms`)}
  </section>`;
}

// ---- 1. Where the flags go ------------------------------------------------------

function flowSection(arm: Arm): string {
  const routes = arm.flag_flow.routes as Record<string, Record<string, number>>;
  const missed = Object.values(routes).reduce((total, row) => total + row.person_missed, 0);
  return `<section class="story">
    <h3>Where the flags go</h3>
    <p class="takeaway">${arm.human_load.flags} detector flags over ${arm.runs} missions: ${sum(routes.needed_judgment)} needed
      a judgment call, ${sum(routes.one_click)} a single click, ${sum(routes.no_human)} none. ${missed} real
      ${missed === 1 ? 'person' : 'people'} got no crew.</p>
    <figure class="wide"><canvas id="chart-flow" role="img" aria-label="Flags by who handled them, split by outcome"></canvas></figure>
  </section>`;
}

function drawFlow(root: HTMLElement, arm: Arm) {
  const routes = arm.flag_flow.routes as Record<string, Record<string, number>>;
  const names = Object.keys(ROUTE_LABEL);
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-flow')!, {
    type: 'bar',
    data: {
      labels: names.map(name => `${ROUTE_LABEL[name]} · ${sum(routes[name])}`),
      datasets: OUTCOMES.map(([key, label, color]) => ({
        label, data: names.map(name => routes[name][key]), backgroundColor: color,
        borderColor: SURFACE, borderWidth: { right: 2 }, borderSkipped: false, barThickness: 22,
      })),
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' },
        tooltip: { callbacks: { label: item => ` ${item.dataset.label}: ${item.parsed.x} of ${sum(routes[names[item.dataIndex]])}` } } },
      scales: { x: { stacked: true, title: { display: true, text: 'flags' }, grid: { color: GRID } }, y: { stacked: true, grid: { display: false } } },
    },
  }));
}

// ---- 2. Can Laya's confidence be trusted? ------------------------------------------

function confidenceSection(arm: Arm): string {
  const confidence = arm.confidence;
  const at = nearest(confidence.points, confidence.tau_route);
  const actions = Object.keys(ACTION_LABEL);
  const max = Math.max(1, ...actions.flatMap(chosen => actions.map(right => confidence.confusion[chosen][right])));
  const cell = (chosen: string, right: string) => {
    const n = confidence.confusion[chosen][right];
    return `<td class="${chosen === right ? 'diag' : ''}" style="--a:${(n / max).toFixed(2)}" title="Laya chose ${ACTION_LABEL[chosen]}; right was ${ACTION_LABEL[right]}: ${n}">${n || ''}</td>`;
  };
  return `<section class="story">
    <h3>Can Laya's confidence be trusted?</h3>
    <p class="takeaway">At our ${pct(confidence.tau_route)} bar, ${pct(at?.cleared_share)} of Laya's first calls clear it
      and ${pct(at?.accuracy)} of those are right, vs ${pct(confidence.accuracy)} over all ${confidence.n}. Above the bar
      its confidence does not buy more accuracy, so a person stays in the loop for every crew.</p>
    <div class="pair">
      <figure><figcaption>Share of Laya's first calls at or above each confidence bar, and how often they are right</figcaption>
        <canvas id="chart-confidence" role="img" aria-label="Accuracy and share of calls by confidence bar"></canvas></figure>
      <figure><figcaption>Laya's first call vs the right action · diagonal = correct</figcaption>
        <table class="confusion">
          <thead><tr><th>Laya chose ↓ · right →</th>${actions.map(a => `<th>${ACTION_LABEL[a]}</th>`).join('')}</tr></thead>
          <tbody>${actions.map(chosen => `<tr><th>${ACTION_LABEL[chosen]}</th>${actions.map(right => cell(chosen, right)).join('')}</tr>`).join('')}</tbody>
        </table></figure>
    </div>
  </section>`;
}

const nearest = (points: any[], bar: number) => points.find(point => point.bar >= bar - 1e-9);

function drawConfidence(root: HTMLElement, arm: Arm) {
  const { points, tau_route: tau } = arm.confidence;
  const mark = (index: number) => (Math.abs(points[index].bar - tau) < 1e-9 ? 7 : 2);
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-confidence')!, {
    type: 'line',
    data: {
      labels: points.map((point: any) => pct(point.bar)),
      datasets: [
        { label: 'Right when this sure', data: points.map((point: any) => point.accuracy), borderColor: BLUE, backgroundColor: BLUE,
          borderWidth: 2, pointRadius: points.map((_: any, i: number) => mark(i)), spanGaps: true },
        { label: 'Share of calls this sure', data: points.map((point: any) => point.cleared_share), borderColor: ORANGE, backgroundColor: ORANGE,
          borderWidth: 2, pointRadius: points.map((_: any, i: number) => mark(i)) },
      ],
    },
    options: {
      responsive: true, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: {
        title: items => `Confidence bar ${items[0].label}${Math.abs(points[items[0].dataIndex].bar - tau) < 1e-9 ? ' (ours)' : ''}`,
        label: item => ` ${item.dataset.label}: ${pct(item.parsed.y)}` } } },
      scales: {
        x: { title: { display: true, text: "Laya's confidence bar" }, grid: { display: false } },
        y: { min: 0, max: 1, grid: { color: GRID }, ticks: { callback: value => pct(Number(value)) } },
      },
    },
  }));
}

// ---- 3. Grok in the loop ------------------------------------------------------------

const FIELD_LABEL: Record<string, string> = {
  location: 'Where (sector / landmark)', subject_count: 'How many people', urgency: 'Urgency',
  hazards: 'Hazards', source: 'Firsthand or relayed', is_retraction: 'Is it a retraction',
};

function grokSection(grok: any): string {
  if (!grok) return pending('Grok in the loop', 'uv run python -m tools.grok_eval');
  const { intel, orders } = grok;
  return `<section class="story">
    <h3>Grok in the loop</h3>
    <p class="takeaway">Grok turns radio chatter into the incident picture and Laya's calls into crew orders. It never
      picks an action, and code strips any number it writes. Live calls to ${grok.model} over ${grok.seeds.length} missions.</p>
    <div class="pair">
      <div class="kpis">
        ${tile('Crew orders ready', `${orders.ok}<small> of ${orders.n}</small>`,
          `${orders.timeout} timed out at ${orders.timeout_s} s · the template brief covers those`)}
        ${tile('Order written in', secs(orders.latency_ms.median), `median · slowest quarter over ${secs(orders.latency_ms.p75)}`)}
        ${tile('Radio messages parsed', `${intel.ok}<small> of ${intel.n}</small>`, `median ${secs(intel.latency_ms.median)}`)}
        ${tile('Numbers Grok slipped in', String(orders.digits_caught), 'orders where code stripped digits', orders.digits_caught ? 'warn' : '')}
      </div>
      <figure><figcaption>Radio messages: Grok's reading vs the scripted truth, per field</figcaption>
        <canvas id="chart-grok" role="img" aria-label="Share of intel fields Grok parsed correctly"></canvas></figure>
    </div>
  </section>`;
}

function drawGrok(root: HTMLElement, grok: any) {
  const fields = Object.keys(FIELD_LABEL).filter(name => grok.intel.fields[name]?.n);
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-grok')!, {
    type: 'bar',
    data: { labels: fields.map(name => FIELD_LABEL[name]),
      datasets: [{ label: 'matches the truth', data: fields.map(name => grok.intel.fields[name].share), backgroundColor: BLUE, borderRadius: 4, barThickness: 14 }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: item => ` ${pct(item.parsed.x)} of ${grok.intel.fields[fields[item.dataIndex]].n} reports` } } },
      scales: { x: { min: 0, max: 1, grid: { color: GRID }, ticks: { callback: value => pct(Number(value)) } }, y: { grid: { display: false } } } },
  }));
}

// ---- 4. Fine-tuning Laya --------------------------------------------------------------

const FT_ROWS: [string, (row: any) => number | null, string][] = [
  ['Right action', row => row.action_accuracy, 'higher is better'],
  ['Right when acting alone', row => row.auto_accuracy, 'higher is better'],
  ['Flags sent to you', row => row.routed_share, 'lower means less work'],
  ["Real people called 'not a person'", row => row.people_called_ignore / row.people, 'lower is better'],
  ['P(person) calibration error', row => row.p_person_ece, 'lower is better'],
];

function finetuneSection(finetune: any): string {
  if (!finetune) return pending('Fine-tuning Laya', 'uv run python -m tools.laya_finetune');
  const { stock, fine_tuned: tuned } = finetune;
  return `<section class="story">
    <h3>Fine-tuning Laya: tried, not shipped</h3>
    <p class="takeaway">We retrained Laya's scorer on ${finetune.train.states} simulated decisions and tested on
      ${finetune.test.states} unseen ones. Right when acting alone ${pct(stock.auto_accuracy)} → ${pct(tuned.auto_accuracy)};
      flags sent to you ${pct(stock.routed_share)} → ${pct(tuned.routed_share)}; real people called 'not a person'
      ${stock.people_called_ignore} → ${tuned.people_called_ignore} of ${stock.people}.
      ${tuned.people_called_ignore >= stock.people_called_ignore ? `Those people sit in the open on a low camera score and read
      exactly like debris, so retraining cannot find them. The stricter auto-close rule keeps them in front of you instead.` : ''}</p>
    <figure class="wide tall"><canvas id="chart-finetune" role="img" aria-label="Stock vs fine-tuned Laya on held-out missions"></canvas></figure>
  </section>`;
}

function drawFinetune(root: HTMLElement, finetune: any) {
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-finetune')!, {
    type: 'bar',
    data: { labels: FT_ROWS.map(([label, , note]) => [label, note]),
      datasets: [['Stock Laya', finetune.stock, MUTED], ['Fine-tuned', finetune.fine_tuned, BLUE]].map(([label, row, color]) => ({
        label: label as string, data: FT_ROWS.map(([, value]) => value(row)), backgroundColor: color as string,
        borderColor: SURFACE, borderWidth: 2, borderRadius: 4, barThickness: 12 })) },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: item => ` ${item.dataset.label}: ${pct(item.parsed.x)}` } } },
      scales: { x: { min: 0, max: 1, grid: { color: GRID }, ticks: { callback: value => pct(Number(value)) } },
        y: { grid: { display: false }, ticks: { autoSkip: false } } } },
  }));
}

const pending = (title: string, command: string) =>
  `<section class="story"><h3>${title}</h3><p class="empty">Not run yet: <code>${command}</code></p></section>`;
