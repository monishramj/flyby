// CC0 Kenney models (web/public/models/*/License.txt) and the tsunami-damage dressing built from them.
// The dressing is scenery only: seeded from the scene seed so every viewer sees the same wreckage,
// and it never feeds detection, triage, or any number shown in the panels.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Scene } from './store';

const FILES = {
  houseA: 'suburban/building-type-a', houseB: 'suburban/building-type-b', houseC: 'suburban/building-type-c',
  houseD: 'suburban/building-type-d', houseF: 'suburban/building-type-f', houseH: 'suburban/building-type-h',
  houseK: 'suburban/building-type-k', treeLarge: 'suburban/tree-large', fence: 'suburban/fence-low',
  palmTall: 'nature/tree_palmTall', palmBend: 'nature/tree_palmBend', palmShort: 'nature/tree_palmShort',
  logLarge: 'nature/log_large', log: 'nature/log', stump: 'nature/stump_old', rockLarge: 'nature/rock_largeA', rock: 'nature/rock_smallA',
  sedan: 'cars/sedan', suv: 'cars/suv', van: 'cars/van', truck: 'cars/truck', ambulance: 'cars/ambulance',
  firetruck: 'cars/firetruck', police: 'cars/police', tire: 'cars/debris-tire', door: 'cars/debris-door', plate: 'cars/debris-plate-a',
  boatFishing: 'boats/boat-fishing-small', boatRow: 'boats/boat-row-small', boatSpeed: 'boats/boat-speed-a',
  containerA: 'boats/cargo-container-a', containerB: 'boats/cargo-container-b',
  barrel: 'survival/barrel', crate: 'survival/box-large', planksPile: 'survival/resource-planks', panel: 'survival/metal-panel',
  metalRoof: 'survival/structure-metal-roof',
  dumpster: 'urban/detail-dumpster-closed', pallet: 'urban/pallet', planks: 'urban/planks', pole: 'urban/detail-light-single',
  barrier: 'urban/detail-barrier-strong-damaged',
  manA: 'people/character-male-a', womanB: 'people/character-female-b', manC: 'people/character-male-c',
} as const;
export type ModelName = keyof typeof FILES;
const cache = new Map<ModelName, THREE.Object3D>();

export async function loadModels(base = '/models/') {
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(FILES).map(async ([name, file]) => {
    try {
      const gltf = await loader.loadAsync(`${base}${file}.glb`);
      gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.shared = true; } });
      cache.set(name as ModelName, gltf.scene);
    } catch (error) { console.warn('model failed', file, error); } // skipped; the scene still renders
  }));
  return cache.size;
}

/** A clone scaled so its longest horizontal side (or its height) is `size` metres, sitting on y=0, centred. */
export function model(name: ModelName, size: number, by: 'length' | 'height' = 'length') {
  const source = cache.get(name);
  if (!source) return null;
  const inner = clone(source), box = new THREE.Box3().setFromObject(inner), dims = box.getSize(new THREE.Vector3());
  const scale = size / Math.max(by === 'height' ? dims.y : Math.max(dims.x, dims.z), 1e-3);
  inner.scale.setScalar(scale);
  inner.position.set(-(box.min.x + dims.x / 2) * scale, -box.min.y * scale, -(box.min.z + dims.z / 2) * scale);
  const outer = new THREE.Group(); outer.add(inner);
  return outer;
}

function rng(seed: number) {
  let a = (seed >>> 0) + 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const at = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

/** Mud, sediment drag lines, roads, sand and the inundation limit, painted once per scene. */
export function groundTexture(scene: Scene, seed: number, margin: number, beach: number) {
  const size = 1024, span = scene.area_m + margin * 2, px = size / span, rand = rng(seed ^ 0x51f0);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const X = (x: number) => (x + margin) * px, Y = (y: number) => size - (y + margin) * px;
  g.fillStyle = '#56603f'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${60 + rand() * 40},${70 + rand() * 40},${40 + rand() * 25},.35)`; g.beginPath(); g.arc(rand() * size, rand() * size, 4 + rand() * 22, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#5d5c55'; g.lineWidth = 7 * px;
  const roads = [[105, -margin, 105, scene.area_m + margin], [190, -margin, 190, scene.area_m + margin], [275, -margin, 275, scene.area_m + margin],
    [-margin, 100, 300, 100], [-margin, 200, 300, 200]];
  roads.forEach(([x1, y1, x2, y2]) => { g.beginPath(); g.moveTo(X(x1), Y(y1)); g.lineTo(X(x2), Y(y2)); g.stroke(); });
  // Inundation: wet sediment thickens toward the sea; the wrack line is where the surge stopped.
  const limit = (y: number) => 70 + 18 * Math.sin(y / 37 + seed) + 10 * Math.sin(y / 13 + seed * 2);
  for (let row = 0; row < size; row += 2) {
    const y = (size - row) / px - margin, from = limit(y);
    const grad = g.createLinearGradient(X(from), 0, X(scene.area_m), 0);
    grad.addColorStop(0, 'rgba(92,80,55,0)'); grad.addColorStop(0.12, 'rgba(92,80,55,.55)'); grad.addColorStop(1, 'rgba(78,66,46,.9)');
    g.fillStyle = grad; g.fillRect(X(from), row, X(scene.area_m + margin) - X(from), 2);
    g.fillStyle = 'rgba(48,40,30,.7)'; g.fillRect(X(from) - 3 * px, row, 5 * px, 2);
  }
  for (let i = 0; i < 260; i++) {
    const y = rand() * scene.area_m, x0 = limit(y) + rand() * (scene.area_m - limit(y)), len = 10 + rand() * 40;
    g.strokeStyle = `rgba(${55 + rand() * 30},${48 + rand() * 20},${35 + rand() * 15},.5)`; g.lineWidth = (0.6 + rand() * 1.5) * px;
    g.beginPath(); g.moveTo(X(x0), Y(y)); g.lineTo(X(x0 - len), Y(y + (rand() - .5) * len * .25)); g.stroke();
  }
  const sand = g.createLinearGradient(X(scene.area_m - 12), 0, X(scene.area_m + margin), 0);
  sand.addColorStop(0, 'rgba(160,146,110,0)'); sand.addColorStop(.25, '#a8997a'); sand.addColorStop(1, '#c8b98f');
  g.fillStyle = sand; g.fillRect(X(scene.area_m - 12), 0, size, size);
  g.fillStyle = '#8f8467'; g.fillRect(X(scene.area_m + beach - 5), 0, 5 * px, size);
  g.clearRect(X(scene.area_m + beach), 0, size, size); // east of the shoreline is sea
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return { tex, limit };
}

const HOUSES: ModelName[] = ['houseA', 'houseB', 'houseC', 'houseD', 'houseF', 'houseH', 'houseK'];
const CARS: ModelName[] = ['sedan', 'suv', 'van', 'truck', 'sedan', 'suv'];
const BOATS: ModelName[] = ['boatFishing', 'boatRow', 'boatSpeed', 'boatFishing'];
const SMALL: [ModelName, number][] = [['planks', 3], ['pallet', 1.3], ['barrel', 1], ['crate', 1.3], ['panel', 2.2], ['door', 1.3],
  ['plate', 1.4], ['tire', 0.8], ['log', 3.5], ['rock', 1], ['planksPile', 2.5], ['dumpster', 2.2]];

/** Damaged houses, snapped and surviving trees, and the wreckage field. Returns null until models are loaded,
 *  otherwise the houses' own (unshared) materials so the truth overlay can fade them. */
export function dressScene(scene: Scene, seed: number, root: THREE.Group, limit: (y: number) => number) {
  if (!cache.size) return null;
  const houseMats: THREE.Material[] = [];
  const rand = rng(seed), pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const area = scene.area_m, add = (o: THREE.Object3D | null, x: number, y: number, yaw = rand() * Math.PI * 2, h = 0) => {
    if (!o) return null;
    o.position.copy(at(x, y, h)); o.rotation.y = yaw; root.add(o); return o;
  };
  // Surge strength at x: 0 above the wrack line, 1 on the beach.
  const surge = (x: number, y: number) => Math.max(0, Math.min(1, (x - limit(y)) / (area - limit(y))));
  const clearOf = (x: number, y: number, pad: number) => scene.houses.every(h => Math.abs(x - h.x) > h.width / 2 + pad || Math.abs(y - h.y) > h.height / 2 + pad);

  scene.houses.forEach((h, i) => {
    const damage = surge(h.x, h.y);
    if (h.kind === 'carport') {
      const roof = model('metalRoof', Math.max(h.width, h.height));
      if (roof) { roof.scale.y = 0.6; add(roof, h.x, h.y, 0, 3.6); }
      const post = new THREE.MeshStandardMaterial({ color: '#7d7f7a', metalness: .4, roughness: .6 });
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 3.8, 8), post); p.castShadow = true;
        p.position.copy(at(h.x + dx * (h.width / 2 - 0.8), h.y + dy * (h.height / 2 - 0.8), 1.9)); root.add(p);
      }
      return;
    }
    const house = model(HOUSES[i % HOUSES.length], Math.max(h.width, h.height));
    if (!house) return;
    house.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const own = [mesh.material].flat().map(m => { const copy = m.clone(); copy.transparent = true; houseMats.push(copy); return copy; });
      mesh.material = Array.isArray(mesh.material) ? own : own[0];
      mesh.userData.shared = false;
    });
    add(house, h.x, h.y, (i % 4) * Math.PI / 2, -damage * 1.2);
    // Stronger surge leaves the house racked and sinking into the sediment.
    house.rotation.z = (rand() - .5) * damage * 0.16; house.rotation.x = (rand() - .5) * damage * 0.12;
    for (let k = 0; k < Math.round(4 + damage * 10); k++) {
      const [name, len] = pick(SMALL), a = rand() * Math.PI * 2, r = Math.max(h.width, h.height) / 2 + 1 + rand() * 6;
      const o = add(model(name, len * (0.8 + rand() * .5)), h.x - Math.abs(Math.cos(a)) * r * (0.5 + damage), h.y + Math.sin(a) * r);
      if (o) o.rotation.z = (rand() - .5) * 0.8;
    }
  });

  scene.trees.forEach(t => {
    const damage = surge(t.x, t.y), inland = damage < 0.15;
    if (!inland && rand() < damage * 0.8) {
      add(model('stump', 1.4), t.x, t.y);
      const log = add(model('logLarge', t.radius * 2.2), t.x - 4 - rand() * 8, t.y + (rand() - .5) * 6, Math.PI / 2 + (rand() - .5) * .6);
      if (log) log.rotation.z = (rand() - .5) * .2;
      return;
    }
    const tree = add(model(inland ? 'treeLarge' : pick(['palmTall', 'palmBend', 'palmShort'] as ModelName[]), t.radius * 2.4, 'height'), t.x, t.y);
    if (tree) tree.rotation.z = damage * 0.35 * (rand() < .5 ? 1 : -1);
  });

  // Surviving palms along the beach, bent landward; a few snapped.
  for (let y = 8; y < area; y += 14 + rand() * 12) {
    const x = area - 6 + rand() * 10;
    if (rand() < 0.3) { add(model('stump', 1.2), x, y); continue; }
    const palm = add(model(pick(['palmTall', 'palmBend', 'palmShort'] as ModelName[]), 8 + rand() * 5, 'height'), x, y);
    if (palm) palm.rotation.z = 0.15 + rand() * 0.25;
  }

  const scatter = (count: number, place: () => [number, number] | null, make: () => THREE.Object3D | null, tip = 0) => {
    for (let i = 0; i < count; i++) {
      const spot = place(); if (!spot) continue;
      const o = add(make(), spot[0], spot[1]);
      if (o && tip) { o.rotation.z = (rand() - .5) * tip; o.rotation.x = (rand() - .5) * tip * .5; }
    }
  };
  // Heavier objects were carried further inland only by the strongest flow; bias them toward the coast.
  const coastal = (pad: number, bias = 1.6) => () => {
    for (let tries = 0; tries < 12; tries++) {
      const y = 6 + rand() * (area - 12), from = limit(y), x = from + Math.pow(rand(), 1 / bias) * (area - 4 - from);
      if (clearOf(x, y, pad)) return [x, y] as [number, number];
    }
    return null;
  };
  scatter(14, coastal(4), () => model(pick(CARS), 4.4 + rand() * 1.2), 1.4);
  scatter(3, coastal(5), () => {
    const car = model(pick(CARS), 4.6); if (!car) return null;
    const lift = new THREE.Box3().setFromObject(car).max.y, flipped = new THREE.Group();
    car.rotation.z = Math.PI; car.position.y = lift; flipped.add(car); return flipped;
  });
  scatter(6, coastal(6, 2.6), () => model(pick(BOATS), 6 + rand() * 4), 0.8);
  scatter(4, coastal(6, 2.2), () => model(rand() < .5 ? 'containerA' : 'containerB', 6.1), 0.5);
  scatter(9, coastal(3), () => model('pole', 7, 'height'), 2.4);
  scatter(6, coastal(3), () => model('barrier', 2.5), 1);
  // Wrack line: the surge dropped the lightest debris where it stopped.
  scatter(150, () => { const y = rand() * area, x = limit(y) + (rand() - .3) * 10; return clearOf(x, y, 1) ? [x, y] : null; },
    () => { const [name, len] = pick(SMALL); return model(name, len * (0.7 + rand() * .6)); }, 1.2);
  scatter(130, coastal(1, 1.2), () => { const [name, len] = pick(SMALL); return model(name, len * (0.7 + rand() * .6)); }, 1.2);
  // Responders staging on dry ground off the west edge.
  ([['ambulance', -14, 60], ['firetruck', -16, 150], ['police', -12, 160], ['ambulance', -15, 230]] as [ModelName, number, number][])
    .forEach(([name, x, y]) => add(model(name, name === 'firetruck' ? 7.5 : 5), x, y, Math.PI / 2));
  return houseMats;
}
