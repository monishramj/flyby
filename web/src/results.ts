import { Chart, BarController, BarElement, CategoryScale, Legend, LineController, LineElement, LinearScale, PointElement, Title, Tooltip } from 'chart.js';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Title, Tooltip);

type Summary = {
  seeds: number[]; generated_at: string;
  assumptions: Record<string, unknown>;
  arms: Record<string, any>;
  comparison: { arm: string; review_s: number; flyby_median_s: number | null; manual_median_s: number | null; speedup: number | null; flyby_n: number; manual_n: number }[];
};

const charts: Chart[] = [];
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
  root.innerHTML = `
    <section class="cards">
      ${arms.map(arm => armCard(arm, summary)).join('')}
    </section>
    <section class="charts">
      <figure><figcaption>Time from first capture to dispatch (visible and partial subjects)</figcaption><canvas id="chart-dispatch"></canvas></figure>
      <figure><figcaption>Reliability of Laya P(person) vs detector confidence</figcaption><canvas id="chart-calibration"></canvas></figure>
    </section>
    <section class="assumptions">
      <h3>Declared assumptions</h3>
      <p>These are simulation assumptions, not measured detector or operator performance.</p>
      <pre>${JSON.stringify(summary.assumptions, null, 1)}</pre>
      <p class="muted">seeds ${summary.seeds.join(', ')} · generated ${new Date(summary.generated_at).toLocaleString()}</p>
    </section>`;

  const labels = summary.comparison.map(row => `${row.arm} · review ${row.review_s}s`);
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-dispatch')!, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'FlyBy median (s)', data: summary.comparison.map(row => row.flyby_median_s), backgroundColor: '#3f8f74' },
        { label: 'Manual review median (s)', data: summary.comparison.map(row => row.manual_median_s), backgroundColor: '#c2703f' },
      ],
    },
    options: { responsive: true, scales: { y: { type: 'logarithmic', title: { display: true, text: 'seconds from t0 (log)' } } } },
  }));

  const arm = summary.arms[arms.find(name => summary.arms[name].calibration.laya_p_person.n > 0) ?? arms[0]];
  const bins = arm.calibration.reliability as { bin: string; n: number; confidence: number | null; accuracy: number | null }[];
  charts.push(new Chart(root.querySelector<HTMLCanvasElement>('#chart-calibration')!, {
    type: 'line',
    data: {
      labels: bins.map(bin => bin.bin),
      datasets: [
        { label: `observed share that were people (ECE ${arm.calibration.laya_p_person.ece ?? '—'})`, data: bins.map(bin => bin.accuracy), borderColor: '#3f8f74', spanGaps: true },
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
      ${rows.map(row => `<div><dt>vs manual @ ${row.review_s}s</dt><dd>${minutes(row.manual_median_s)} <small>${row.speedup ?? '—'}× faster</small></dd></div>`).join('')}
      <div><dt>subjects found</dt><dd>${data.subjects.dispatched}/${data.subjects.placed}</dd></div>
      <div><dt>under structure</dt><dd>${minutes(data.under_structure_time_to_dispatch_s.median)} <small>inspection only, n=${data.under_structure_time_to_dispatch_s.n}</small></dd></div>
      <div><dt>action accuracy</dt><dd>${data.action_accuracy.decision ?? '—'} <small>final ${data.action_accuracy.final ?? '—'}</small></dd></div>
      <div><dt>dispatch precision / recall</dt><dd>${data.dispatch.precision ?? '—'} / ${data.dispatch.recall ?? '—'}</dd></div>
      <div><dt>routed to human</dt><dd>${data.routing_rate ?? '—'} <small>fallback ${data.fallback_rate ?? '—'}</small></dd></div>
      <div><dt>re-decisions</dt><dd>${data.redecisions}</dd></div>
      <div><dt>decision latency</dt><dd>${data.latency_ms.p50} / ${data.latency_ms.p95} ms <small>p50 / p95</small></dd></div>
      <div><dt>ECE</dt><dd>${data.calibration.laya_p_person.ece ?? '—'} <small>detector ${data.calibration.detector_conf.ece ?? '—'}</small></dd></div>
    </dl>
  </article>`;
}
