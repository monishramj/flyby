import { Chart, BarController, BarElement, CategoryScale, Legend, LineController, LineElement, LinearScale, LogarithmicScale, PointElement, Title, Tooltip } from 'chart.js';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, LogarithmicScale, Legend, Title, Tooltip);

// Dark categorical slots 1-3, validated against the panel surface (dataviz validate_palette.js, all checks pass).
const SERIES = ['#3987e5', '#d95926', '#199e70'];
const MUTED = '#60716f', GRID = '#35413e', SURFACE = '#191f21';
Chart.defaults.color = '#abb8b1';
Chart.defaults.font.family = "'Segoe UI', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.animation = false;
Chart.defaults.borderColor = GRID;

type Summary = {
  seeds: number[]; generated_at: string;
  assumptions: Record<string, unknown>;
  arms: Record<string, any>;
  comparison: { arm: string; review_s: number; flyby_median_s: number | null; manual_median_s: number | null; speedup: number | null; flyby_n: number; manual_n: number }[];
};

const charts: Chart[] = [];
const times = (value: number | null) => (value == null ? '—' : `${value >= 10 ? Math.round(value) : value.toFixed(1)}×`);
const minutes = (value: number | null) => (value == null ? '—' : `${(value / 60).toFixed(1)} min`);

export async function renderResults(root: HTMLElement) {
  root.innerHTML = '<p class="empty">Loading results…</p>';
  let summary: Summary;
  try {
    const response = await fetch('/api/results/summary.json');
    if (!response.ok) throw new Error(String(response.status));
    summary = await response.json();
  } catch {
    root.innerHTML = `<p class="empty">No evaluation yet. Run <code>uv run python -m batch.run_eval</code> to produce <code>results/summary.json</code>.</p>`;
    return;
  }
  charts.splice(0).forEach(chart => chart.destroy());
  const arms = Object.keys(summary.arms);
  const live = summary.arms.laya ? 'laya' : arms[0];
  root.innerHTML = `
    ${headline(summary, live)}
    <section class="charts">
      <figure><figcaption><b>Time from first sighting to crew dispatch</b> · median, log scale</figcaption><canvas id="chart-dispatch" role="img" aria-label="Median time to dispatch for FlyBy and a manual reviewer"></canvas></figure>
      <figure><figcaption><b>What happened to every flag</b> · a manual reviewer judges all of them</figcaption><canvas id="chart-load" role="img" aria-label="How many flags needed a human"></canvas></figure>
    </section>
    <section class="cards">
      ${arms.map(arm => armCard(arm, summary)).join('')}
    </section>
    <section class="charts">
      <figure><figcaption>Reliability of Laya P(person)</figcaption><canvas id="chart-calibration"></canvas></figure>
    </section>
    <section class="assumptions">
      <h3>Declared assumptions</h3>
      <p>These are simulation assumptions, not measured detector or operator performance.</p>
      <pre>${JSON.stringify(summary.assumptions, null, 1)}</pre>
      <p class="muted">seeds ${summary.seeds.join(', ')} · generated ${new Date(summary.generated_at).toLocaleString()}</p>
    </section>`;

  // Emphasis: FlyBy's live policy is the point; the rule and manual review are context.
  const rows = [
    { label: `FlyBy · ${live}`, value: summary.arms[live].time_to_dispatch_s.median, color: SERIES[0] },
    ...arms.filter(arm => arm !== live).map(arm => ({ label: `FlyBy · ${arm}`, value: summary.arms[arm].time_to_dispatch_s.median, color: MUTED })),
    ...summary.comparison.filter(row => row.arm === live).map(row => ({ label: `Manual · ${row.review_s} s/image`, value: row.manual_median_s, color: MUTED })),
  ];
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-dispatch')!, {
    type: 'bar',
    data: { labels: rows.map(row => `${row.label} — ${minutes(row.value)}`),
      datasets: [{ label: 'median time to dispatch', data: rows.map(row => row.value), backgroundColor: rows.map(row => row.color), borderRadius: 4, barThickness: 16 }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: item => ` ${minutes(item.parsed.x)} median` } } },
      scales: { x: { type: 'logarithmic', title: { display: true, text: 'seconds (log scale)' }, grid: { color: GRID },
        // Decades only: minor log ticks crowd the axis and add nothing a reader uses.
        afterBuildTicks: axis => { axis.ticks = [10, 100, 1000, 10000].filter(v => v >= axis.min && v <= axis.max).map(value => ({ value })); },
        ticks: { maxRotation: 0, callback: value => Number(value).toLocaleString() } }, y: { grid: { display: false } } } },
  }));

  const loads = [...arms.map(arm => ({ label: `FlyBy · ${arm}`, load: summary.arms[arm].human_load })).filter(row => row.load),
    ...(summary.arms[live].human_load ? [{ label: 'Manual review', load: { flags: summary.arms[live].human_load.flags, needed_judgment: summary.arms[live].human_load.flags, one_click: 0, no_human: 0 } }] : [])];
  const segments: [string, string, string][] = [['needed_judgment', 'Needed your judgment', SERIES[0]], ['one_click', 'One-click approval', SERIES[1]], ['no_human', 'Handled without you', SERIES[2]]];
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-load')!, {
    type: 'bar',
    data: { labels: loads.map(row => row.label),
      datasets: segments.map(([key, label, color]) => ({ label, data: loads.map(row => row.load[key]), backgroundColor: color,
        borderColor: SURFACE, borderWidth: { right: 2 }, borderSkipped: false, barThickness: 16 })) },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { position: 'bottom' },
      tooltip: { callbacks: { label: item => ` ${item.dataset.label}: ${item.parsed.x} of ${loads[item.dataIndex].load.flags} flags` } } },
      scales: { x: { stacked: true, title: { display: true, text: 'flags' }, grid: { color: GRID } }, y: { stacked: true, grid: { display: false } } } },
  }));

  const arm = summary.arms[arms.find(name => summary.arms[name].calibration.laya_p_person.n > 0) ?? arms[0]];
  const bins = arm.calibration.reliability as { bin: string; n: number; confidence: number | null; accuracy: number | null }[];
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-calibration')!, {
    type: 'line',
    data: {
      labels: bins.map(bin => bin.bin),
      datasets: [
        { label: `observed share that were people (ECE ${arm.calibration.laya_p_person.ece ?? '—'})`, data: bins.map(bin => bin.accuracy), borderColor: '#a5c3ac', backgroundColor: '#a5c3ac', spanGaps: true },
        { label: 'perfect calibration', data: bins.map((_, index) => (index + 0.5) / bins.length), borderColor: '#7b8a82', borderDash: [5, 5], pointRadius: 0 },
      ],
    },
    options: { responsive: true, scales: { y: { min: 0, max: 1, title: { display: true, text: 'observed P(person)' } } } },
  }));
}

function armCard(arm: string, summary: Summary): string {
  const data = summary.arms[arm];
  const rows = summary.comparison.filter(row => row.arm === arm);
  return `<article>
    <h3>${arm} policy</h3>
    <dl>
      <div><dt>time to dispatch</dt><dd>${minutes(data.time_to_dispatch_s.median)} <small>median, n=${data.time_to_dispatch_s.n}</small></dd></div>
      ${rows.map(row => `<div><dt>vs manual @ ${row.review_s}s</dt><dd>${minutes(row.manual_median_s)} <small>${times(row.speedup)} faster</small></dd></div>`).join('')}
      <div><dt>subjects found</dt><dd>${data.subjects.dispatched}/${data.subjects.placed}</dd></div>
      <div><dt>under structure</dt><dd>${minutes(data.under_structure_time_to_dispatch_s.median)} <small>inspection only, n=${data.under_structure_time_to_dispatch_s.n}</small></dd></div>
      <div><dt>action accuracy</dt><dd>${data.action_accuracy.decision ?? '—'} <small>final ${data.action_accuracy.final ?? '—'}</small></dd></div>
      <div><dt>dispatch precision / recall</dt><dd>${data.dispatch.precision ?? '—'} / ${data.dispatch.recall ?? '—'}</dd></div>
      <div><dt>fallback to rule</dt><dd>${data.fallback_rate ?? '—'}</dd></div>
      <div><dt>re-decisions</dt><dd>${data.redecisions}</dd></div>
      <div><dt>decision latency</dt><dd>${data.latency_ms.p50} / ${data.latency_ms.p95} ms <small>p50 / p95</small></dd></div>
      <div><dt>ECE</dt><dd>${data.calibration.laya_p_person.ece ?? '—'} <small>detector ${data.calibration.detector_conf.ece ?? '—'}</small></dd></div>
    </dl>
  </article>`;
}

/** The numbers that validate the product, before any chart: speed, reach, human load, and the cost of not looking. */
function headline(summary: Summary, live: string): string {
  const arm = summary.arms[live];
  const others = Object.keys(summary.arms).filter(name => name !== live);
  const baseline = others.length ? summary.arms[others[0]] : null;
  const reviews = summary.comparison.filter(row => row.arm === live);
  const slow = reviews.reduce((a, b) => (b.review_s > a.review_s ? b : a), reviews[0]);
  const fast = reviews.reduce((a, b) => (b.review_s < a.review_s ? b : a), reviews[0]);
  const load = arm.human_load;
  const tile = (label: string, value: string, note: string, tone = '') => `<article class="kpi ${tone}"><h4>${label}</h4><p class="value">${value}</p><p class="note">${note}</p></article>`;
  return `<section class="kpis">
    ${tile('Median time to dispatch', minutes(arm.time_to_dispatch_s.median),
      slow ? `${times(slow.speedup)} faster than manual review at ${slow.review_s} s/image · ${times(fast.speedup)} at ${fast.review_s} s/image` : '', 'hero')}
    ${tile('Real people reached a crew', `${arm.subjects.dispatched}<small> of ${arm.subjects.placed}</small>`,
      baseline ? `${others[0]} policy: ${baseline.subjects.dispatched}` : '')}
    ${load ? tile('Flags that needed you', `${load.needed_judgment + load.one_click}<small> of ${load.flags}</small>`,
      `${load.needed_judgment} judgment calls · ${load.one_click} one-click · manual review: all ${load.flags}`) : ''}
    ${load ? tile('Real people closed unseen', String(load.people_closed_without_human),
      baseline?.human_load ? `${others[0]} policy: ${baseline.human_load.people_closed_without_human} · lower is better` : 'lower is better', load.people_closed_without_human ? 'warn' : '') : ''}
  </section>`;
}
