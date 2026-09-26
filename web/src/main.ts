import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main>
    <header><span class="brand">FLYBY</span><span class="badge">BUILD 00 · FOUNDATION</span></header>
    <section class="intro"><p class="eyebrow">CONNECTOME LAB</p>
      <h1>A fly’s visual circuit.<br>A drone’s reflex.</h1>
      <p class="lede">Follow camera input through the fly’s motion cells to a measured brake response.</p>
    </section>
    <section class="pipeline" aria-label="Planned reflex pipeline">
      <div><b>01</b><h2>Camera</h2><p>Grayscale frames</p></div><span aria-hidden="true">→</span>
      <div><b>02</b><h2>Fly eye</h2><p>Connectome-constrained model</p></div><span aria-hidden="true">→</span>
      <div><b>03</b><h2>Looming</h2><p>T4 / T5 motion readout</p></div><span aria-hidden="true">→</span>
      <div><b>04</b><h2>Reflex</h2><p>Brake and swerve</p></div>
    </section>
    <section class="next"><div><p class="eyebrow">NEXT CHECKPOINT</p><h2>Measure the real fly eye.</h2>
      <p>Load pretrained weights, verify camera orientation and neuron directions, then measure latency.</p></div>
      <p class="status">Model not loaded<br><small>No live activity or benchmark results yet</small></p>
    </section>
    <footer>Flyvis model activity will be projected onto matching connectome neurons. The looming readout is our engineered layer.</footer>
  </main>`;
