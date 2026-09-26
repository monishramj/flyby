import { store, type Lead } from './store';
export const colors: Record<string, string> = { dispatch_ground_team: '#327c65', reimage_zoom: '#bb913f', close_in_inspect: '#5f76b0', ignore: '#79847f', dispatched: '#195846', awaiting_human: '#cf653c' };
export function drawMap(canvas: HTMLCanvasElement) {
  const snapshot = store.snapshot; if (!snapshot) return;
  const ctx = canvas.getContext('2d')!;
  const size = canvas.clientWidth, dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr; canvas.height = size * dpr; ctx.scale(dpr, dpr);
  const pad = 32, scale = (size - 2 * pad) / snapshot.scene.area_m;
  const x = (v: number) => pad + v * scale, y = (v: number) => size - pad - v * scale;
  ctx.fillStyle = '#e7ebe1'; ctx.fillRect(0, 0, size, size);
  const { scene, state, incident, leads } = snapshot;
  ctx.fillStyle = '#bdced0'; scene.water.forEach(w => ctx.fillRect(x(w.x), y(w.y + w.height), w.width * scale, w.height * scale));
  ctx.fillStyle = '#54836120'; state.coverage_cells.forEach(c => ctx.fillRect(x(c.x), y(c.y + snapshot.config.COVERAGE_CELL_M), snapshot.config.COVERAGE_CELL_M * scale, snapshot.config.COVERAGE_CELL_M * scale));
  ctx.lineWidth = 1; ctx.strokeStyle = '#aab5a5'; ctx.setLineDash([3, 5]);
  for (let i = 0; i <= scene.sector_grid; i++) { const v = i * scene.area_m / scene.sector_grid; ctx.beginPath(); ctx.moveTo(x(v), y(0)); ctx.lineTo(x(v), y(scene.area_m)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x(0), y(v)); ctx.lineTo(x(scene.area_m), y(v)); ctx.stroke(); }
  ctx.setLineDash([]); ctx.font = '10px ui-monospace, monospace';
  for (let row = 0; row < scene.sector_grid; row++) for (let col = 0; col < scene.sector_grid; col++) { const sector = `S${row * scene.sector_grid + col + 1}`; ctx.fillStyle = incident.sector_priority[sector] === 'critical' ? '#bc603f' : '#798975'; ctx.fillText(sector, x(col * scene.area_m / scene.sector_grid) + 7, y((row + 1) * scene.area_m / scene.sector_grid) + 15); }
  ctx.fillStyle = '#93a88b'; scene.trees.forEach(t => { ctx.beginPath(); ctx.arc(x(t.x), y(t.y), t.radius * scale, 0, Math.PI * 2); ctx.fill(); });
  scene.houses.forEach(h => { ctx.fillStyle = h.kind === 'carport' ? '#aeab95' : '#c4c1aa'; ctx.strokeStyle = '#a8a58d'; ctx.fillRect(x(h.x - h.width / 2), y(h.y + h.height / 2), h.width * scale, h.height * scale); ctx.strokeRect(x(h.x - h.width / 2), y(h.y + h.height / 2), h.width * scale, h.height * scale); });
  ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = '#566353';
  Object.entries(scene.gazetteer).forEach(([name, point]) => ctx.fillText(point.label || name.replaceAll('_', ' '), x(point.x) + 3, y(point.y) - 13));
  incident.hazards.forEach(h => { ctx.fillStyle = '#c96b43'; ctx.font = 'bold 16px system-ui'; ctx.fillText('△', x(h.x) - 6, y(h.y) + 6); });
  if (incident.last_known_point) { ctx.strokeStyle = '#c96b43'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(x(incident.last_known_point.x), y(incident.last_known_point.y), 18, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  leads.forEach(lead => { const selected = store.selected === lead.lead_id; ctx.beginPath(); ctx.arc(x(lead.x), y(lead.y), selected ? 10 : 6, 0, Math.PI * 2); ctx.fillStyle = colors[lead.status] || colors[lead.decision?.action || 'ignore']; ctx.fill(); ctx.lineWidth = selected ? 3 : 2; ctx.strokeStyle = '#fff'; ctx.stroke(); if (selected) { ctx.fillStyle = '#183f34'; ctx.font = 'bold 11px ui-monospace, monospace'; ctx.fillText(lead.lead_id, x(lead.x) + 13, y(lead.y) + 4); } });
  ctx.save(); ctx.translate(x(state.drone.x), y(state.drone.y)); ctx.fillStyle = '#233d33'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(8, 8); ctx.lineTo(0, 4); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = '#667460'; ctx.fillText('N ↑', size - 29, 18); ctx.fillText('0', x(0), size - 9); ctx.fillText(`${scene.area_m} m`, x(scene.area_m) - 29, size - 9);
}
export function pickLead(canvas: HTMLCanvasElement, event: MouseEvent): Lead | undefined {
  const s = store.snapshot; if (!s) return;
  const rect = canvas.getBoundingClientRect(), scale = (rect.width - 64) / s.scene.area_m;
  return s.leads.find(lead => Math.hypot(32 + lead.x * scale - (event.clientX - rect.left), rect.width - 32 - lead.y * scale - (event.clientY - rect.top)) < 14);
}
