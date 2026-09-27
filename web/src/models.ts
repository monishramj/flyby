// CC0 Kenney models (web/public/models/*/License.txt) and the tsunami-damage dressing built from them.
// The dressing is scenery only: seeded from the scene seed so every viewer sees the same wreckage,
// and it never feeds detection, triage, or any number shown in the panels.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Scene } from './store';

const FILES = {
  log: 'nature/log', rock: 'nature/rock_smallA',
  sedan: 'cars/sedan', suv: 'cars/suv', van: 'cars/van', truck: 'cars/truck', ambulance: 'cars/ambulance',
  firetruck: 'cars/firetruck', police: 'cars/police', tire: 'cars/debris-tire', door: 'cars/debris-door', plate: 'cars/debris-plate-a',
  boatFishing: 'boats/boat-fishing-small', boatRow: 'boats/boat-row-small', boatSpeed: 'boats/boat-speed-a',
  containerA: 'boats/cargo-container-a', containerB: 'boats/cargo-container-b',
  barrel: 'survival/barrel', crate: 'survival/box-large', planksPile: 'survival/resource-planks', panel: 'survival/metal-panel',
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
      const styled = new Set<THREE.Material>(), dented = new Set<THREE.BufferGeometry>();
      gltf.scene.traverse(o => {
        if (!(o as THREE.Mesh).isMesh) return;
        o.castShadow = o.receiveShadow = true; o.userData.shared = true;
        const geometry = (o as THREE.Mesh).geometry;
        if (['sedan', 'suv', 'van', 'truck'].includes(name) && !dented.has(geometry)) {
          dented.add(geometry);
          geometry.computeBoundingBox(); const bounds = geometry.boundingBox!;
          const vertices = geometry.getAttribute('position'), height = bounds.max.y - bounds.min.y;
          // Crush upper bodywork in the cached decorative wrecks; emergency vehicles stay intact.
          for (let i = 0; i < vertices.count; i++) {
            const y = vertices.getY(i), upper = Math.max(0, y - bounds.min.y - height * .55);
            vertices.setY(i, y - upper * .3);
            vertices.setX(i, vertices.getX(i) + Math.sin(vertices.getZ(i) * 7) * upper * .12);
          }
          vertices.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
        }
        for (const mat of [(o as THREE.Mesh).material].flat()) {
          if (styled.has(mat)) continue; styled.add(mat);
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.color.multiply(new THREE.Color('#a1a59a'));
            mat.roughness = .86; mat.metalness = .08;
          }
        }
      });
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
  const size = 2048, span = scene.area_m + margin * 2, px = size / span, rand = rng(seed ^ 0x51f0);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const X = (x: number) => (x + margin) * px, Y = (y: number) => size - (y + margin) * px;
  g.fillStyle = '#666b5e'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 1400; i++) {
    const x = rand() * size, y = rand() * size, r = 8 + rand() * 80;
    const patch = g.createRadialGradient(x, y, 0, x, y, r);
    patch.addColorStop(0, rand() < .5 ? 'rgba(40,47,37,.12)' : 'rgba(169,163,140,.15)');
    patch.addColorStop(1, 'rgba(100,105,88,0)'); g.fillStyle = patch; g.fillRect(x-r, y-r, r*2, r*2);
  }
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
    g.fillStyle = 'rgba(48,40,30,.18)'; g.fillRect(X(from) - px, row, 2 * px, 2);
  }
  for (let i = 0; i < 260; i++) {
    const y = rand() * scene.area_m, x0 = limit(y) + rand() * (scene.area_m - limit(y)), len = 10 + rand() * 40;
    g.strokeStyle = `rgba(${55 + rand() * 30},${48 + rand() * 20},${35 + rand() * 15},.5)`; g.lineWidth = (0.6 + rand() * 1.5) * px;
    g.beginPath(); g.moveTo(X(x0), Y(y)); g.lineTo(X(x0 - len), Y(y + (rand() - .5) * len * .25)); g.stroke();
  }
  // Beach: dry pale sand grading to dark wet sand at the waterline, with grain, wind ripples and a strandline of weed.
  const shoreX = X(scene.area_m + beach), sandFrom = X(scene.area_m - 12), dryEnd = X(scene.area_m + beach - 16);
  const sand = g.createLinearGradient(sandFrom, 0, shoreX, 0);
  sand.addColorStop(0, 'rgba(176,160,120,0)'); sand.addColorStop(.18, '#8f8b76'); sand.addColorStop(.62, '#a7a18c'); sand.addColorStop(.86, '#a89870'); sand.addColorStop(1, '#6f6248');
  g.fillStyle = sand; g.fillRect(sandFrom, 0, size, size);
  const wet = g.createLinearGradient(dryEnd, 0, shoreX, 0);
  wet.addColorStop(0, 'rgba(70,60,42,0)'); wet.addColorStop(1, 'rgba(58,50,36,.55)');
  g.fillStyle = wet; g.fillRect(dryEnd, 0, size, size);
  for (let i = 0; i < 16000; i++) {
    const x = sandFrom + rand() * (shoreX - sandFrom), light = rand() < .5;
    g.fillStyle = light ? `rgba(240,228,196,${.1 + rand() * .2})` : `rgba(90,78,56,${.08 + rand() * .18})`;
    g.fillRect(x, rand() * size, 1 + rand() * 1.6, 1 + rand() * 1.2);
  }
  g.lineWidth = Math.max(1, .5 * px);
  for (let i = 0; i < 220; i++) {  // ripples run along the shore (north-south), longer where the sand is drier
    const x = sandFrom + rand() * (dryEnd - sandFrom), y = rand() * size, len = (8 + rand() * 30) * px;
    g.strokeStyle = `rgba(${rand() < .5 ? '120,106,78' : '236,224,190'},${.12 + rand() * .14})`; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - .5) * 3, y + len); g.stroke();
  }
  for (let i = 0; i < 260; i++) {  // strandline: dark weed and shell flecks where the last tide stopped
    const x = dryEnd - 4 * px + (rand() - .5) * 8 * px, y = rand() * size;
    g.fillStyle = rand() < .8 ? `rgba(${40 + rand() * 25},${44 + rand() * 20},${28},.7)` : 'rgba(245,238,222,.8)';
    g.beginPath(); g.ellipse(x, y, (1 + rand() * 3) * px, (.5 + rand() * 1.2) * px, rand() * 3, 0, Math.PI * 2); g.fill();
  }
  // Silt grain, cracks and drainage streaks keep the ground readable at low camera heights.
  for (let i = 0; i < 26000; i++) {
    g.fillStyle = i % 2 ? 'rgba(30,34,30,.12)' : 'rgba(194,187,163,.13)';
    g.fillRect(rand() * shoreX, rand() * size, 1 + rand() * 3, 1 + rand() * 2);
  }
  for (let i = 0; i < 180; i++) {
    const x = 80 + rand() * 210, y = rand() * scene.area_m;
    g.strokeStyle = 'rgba(39,43,39,.3)'; g.lineWidth = .15 * px;
    g.beginPath(); g.moveTo(X(x), Y(y));
    g.lineTo(X(x - 3), Y(y + 1)); g.lineTo(X(x - 7), Y(y + .4)); g.stroke();
  }
  g.clearRect(shoreX, 0, size, size); // east of the shoreline is sea
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return { tex, limit };
}


const CARS: ModelName[] = ['sedan', 'suv', 'van', 'truck', 'sedan', 'suv'];
const BOATS: ModelName[] = ['boatFishing', 'boatRow', 'boatSpeed', 'boatFishing'];
const SMALL: [ModelName, number][] = [['planks', 3], ['pallet', 1.3], ['barrel', 1], ['crate', 1.3], ['panel', 2.2], ['door', 1.3],
  ['plate', 1.4], ['tire', 0.8], ['log', 3.5], ['rock', 1], ['planksPile', 2.5], ['dumpster', 2.2]];

/** Geometry and textures here are visual only; no simulation RNG or truth data is consumed. */
function weatherMaterial(color: string, seed: number, metalness = 0) {
  const rand = rng(seed), n = 128, bytes = new Uint8Array(n * n * 4);
  const base = new THREE.Color(color);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const damp = y > n * .65 ? .58 : 1;
    const grain = (.88 + rand() * .16) * damp * (x % 23 < 2 ? .72 : 1);
    const i = (y * n + x) * 4;
    bytes[i] = THREE.MathUtils.clamp(base.r * grain, 0, 1) * 255;
    bytes[i + 1] = THREE.MathUtils.clamp(base.g * grain, 0, 1) * 255;
    bytes[i + 2] = THREE.MathUtils.clamp(base.b * grain, 0, 1) * 255; bytes[i + 3] = 255;
  }
  const map = new THREE.DataTexture(bytes, n, n); map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter; map.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map, roughness: metalness ? .68 : .94, metalness, transparent: true });
}

/** All pieces stay inside the original footprint, including an intact shelter at its centre. */
function damagedBuilding(h: Scene['houses'][number], index: number, seed: number) {
  const group = new THREE.Group(); group.name = `structure-${index}`;
  group.position.copy(at(h.x, h.y)); group.userData.structure = { ...h };
  const rand = rng(seed ^ (index * 7919)), w = h.width, d = h.height;
  const wall = weatherMaterial(['#a9a69a', '#969f9b', '#b5aa91'][index % 3], seed + index);
  const timber = weatherMaterial('#665345', seed + index + 1);
  const roof = weatherMaterial('#626e71', seed + index + 2, .35);
  const concrete = weatherMaterial('#74766d', seed + index + 3);
  const mats = [wall, timber, roof, concrete];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const piece = (x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(box, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz);
    m.castShadow = m.receiveShadow = true; group.add(m); return m;
  };
  piece(0, .15, 0, w, .3, d, concrete);
  const height = h.kind === 'carport' ? 3.8 : 5.5;
  for (const x of [-w / 2 + .25, w / 2 - .25]) for (const z of [-d / 2 + .25, d / 2 - .25])
    piece(x, height / 2, z, .35, height, .35, concrete);
  if (h.kind !== 'carport') {
    // Broken wall bays leave real openings and a ragged silhouette instead of tilting whole houses.
    for (const side of [-1, 1]) {
      const bays = Math.ceil(w / 3), bw = (w - .5) / bays;
      for (let j = 0; j < bays; j++) {
        const x = -w / 2 + .25 + bw * (j + .5), tall = j % 3 === 0 ? height : .8 + rand() * 1.4;
        piece(x, tall / 2 + .3, side * (d / 2 - .2), bw - .12, tall, .3, wall);
        piece(x - bw / 2 + .12, height / 2, side * (d / 2 - .25), .14, height, .16, timber);
        if (j % 3 !== 0) piece(x, height - .4, side * (d / 2 - .2), bw, .6, .3, wall);
      }
      piece(side * (w / 2 - .2), 1.3, 0, .3, 2.6, d - .5, wall);
      piece(side * (w / 2 - .2), height - .3, 0, .3, .6, d - .5, timber);
    }
  }
  // Roof ribs remain visible through missing sheets. Centre cover preserves under-structure shelter.
  const ribs = Math.ceil(w / 2);
  for (let j = 0; j <= ribs; j++) {
    const x = -w / 2 + .25 + (w - .5) * j / ribs;
    piece(x, height, 0, .16, .22, d - .4, timber);
  }
  piece(0, height + .2, 0, .4, .18, d - .4, roof);
  for (let j = 0; j < 6; j++) {
    if (j === 0 || j === 5) continue;
    const x = (j - 2.5) * (w - .6) / 6;
    const sheet = piece(x, height + .18, 0, (w - .6) / 6 - .05, .14, d * (j === 2 || j === 3 ? .96 : .65), roof);
    sheet.rotation.x = j === 1 ? .08 : 0;
    for (let k = 0; k < 4; k++) piece(x + (k - 1.5) * (w - .6) / 24, height + .28, 0, .045, .045, d * .62, roof);
  }
  // Static structure pieces need only one draw call per material, including shadow passes.
  for (const mat of mats) {
    const pieces = group.children.filter(o => (o as THREE.Mesh).material === mat) as THREE.Mesh[];
    if (!pieces.length) continue;
    const geometries = pieces.map(m => { m.updateMatrix(); return m.geometry.clone().applyMatrix4(m.matrix); });
    const geometry = mergeGeometries(geometries)!;
    geometries.forEach(g => g.dispose()); pieces.forEach(m => group.remove(m));
    const mesh = new THREE.Mesh(geometry, mat); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  }
  box.dispose();
  return { group, mats };
}

/** Structures are always available, even when optional CC0 prop assets cannot load. */
export function dressScene(scene: Scene, seed: number, root: THREE.Group, limit: (y: number) => number) {
  const houseMats: THREE.Material[] = [];
  const rand = rng(seed ^ 0x731a), pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const area = scene.area_m, add = (o: THREE.Object3D | null, x: number, y: number, yaw = rand() * Math.PI * 2, h = 0) => {
    if (!o) return null;
    o.position.copy(at(x, y, h)); o.rotation.y = yaw; root.add(o); return o;
  };
  const surge = (x: number, y: number) => Math.max(0, Math.min(1, (x - limit(y)) / (area - limit(y))));
  const clearOf = (x: number, y: number, pad: number) => scene.houses.every(h => Math.abs(x - h.x) > h.width / 2 + pad || Math.abs(y - h.y) > h.height / 2 + pad);
  scene.houses.forEach((h, i) => {
    const { group, mats } = damagedBuilding(h, i, seed); root.add(group); houseMats.push(...mats);
  });

  // Small wreckage uses three draw calls, allowing dense deposits without hundreds of extra meshes.
  const debrisRand = rng(seed ^ 0xdeb715), transform = new THREE.Object3D();
  for (const [kind, color] of [['timber', '#75614b'], ['masonry', '#969085'], ['sheet', '#647276']]) {
    const mat = weatherMaterial(color, seed + kind.length, kind === 'sheet' ? .45 : 0);
    const debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 520);
    debris.name = `decorative-${kind}`; debris.castShadow = debris.receiveShadow = true;
    let count = 0;
    for (let i = 0; i < 520; i++) {
      const y = debrisRand() * area;
      const x = i < 210 ? limit(y) + (debrisRand() - .25) * 17 : 70 + debrisRand() * (area - 70);
      if (!clearOf(x, y, 2)) continue;
      transform.position.copy(at(x, y, .16 + debrisRand() * .38));
      transform.rotation.set((debrisRand() - .5) * .3, Math.PI / 2 + (debrisRand() - .5) * 1.4, (debrisRand() - .5) * .22);
      transform.scale.set(kind === 'timber' ? 1.5 + debrisRand() * 4 : .4 + debrisRand() * 1.8,
        kind === 'masonry' ? .3 + debrisRand() * .5 : .08 + debrisRand() * .14,
        kind === 'timber' ? .13 + debrisRand() * .25 : .4 + debrisRand() * 1.1);
      transform.updateMatrix(); debris.setMatrixAt(count++, transform.matrix);
    }
    debris.count = count; root.add(debris);
  }

  const bark = weatherMaterial('#635d4b', seed + 71);
  const foliage = new THREE.MeshStandardMaterial({ color: '#535e45', roughness: .95, side: THREE.DoubleSide });
  const palm = (x: number, y: number, height: number, broken: boolean) => {
    const tree = new THREE.Group();
    const points = [new THREE.Vector3(), new THREE.Vector3(-.4, height * .35, 0), new THREE.Vector3(-1.2, height * .7, .15), new THREE.Vector3(-2, height, .4)];
    const curve = new THREE.CatmullRomCurve3(points);
    const trunk = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, .2, 7, false), bark); trunk.castShadow = true; tree.add(trunk);
    if (!broken) for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4, vertices: number[] = [];
      for (let j = 0; j < 8; j++) {
        const t = j / 7, radius = t * 4.5, width = Math.sin(t * Math.PI) * .45;
        for (const side of [-1, 1]) vertices.push(-2 + Math.cos(angle) * radius + Math.sin(angle) * width * side,
          height + Math.sin(t * Math.PI) * .6 - t * t * 1.8, .4 + Math.sin(angle) * radius - Math.cos(angle) * width * side);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      const indices: number[] = []; for (let j = 0; j < 7; j++) { const n = j * 2; indices.push(n,n+1,n+2,n+1,n+3,n+2); }
      geo.setIndex(indices); geo.computeVertexNormals();
      const frond = new THREE.Mesh(geo, foliage); frond.castShadow = true; tree.add(frond);
    }
    add(tree, x, y, 0);
  };
  scene.trees.forEach(t => {
    const damage = surge(t.x, t.y), broken = rand() < .25 + damage * .65;
    palm(t.x, t.y, broken ? 2 + rand() * 3 : 8 + rand() * 3, broken);
    if (broken) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(.15, .28, 5 + rand() * 3, 8), bark);
      log.rotation.z = Math.PI / 2; log.castShadow = true; add(log, t.x - 5, t.y + 2, .2, .3);
    }
  });
  for (let y = 8; y < area; y += 16 + rand() * 12) palm(area - 5 + rand() * 8, y, 5 + rand() * 6, rand() < .4);

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

/** Truth visuals are created only by the truth overlay, never by the decorative scatter. */
export function truthVisual(kind: string, color: string) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: .85 });
  const dark = new THREE.MeshStandardMaterial({ color: '#343c3e', roughness: .9 });
  const part = (geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, material); m.position.set(x, y, z); m.castShadow = true; group.add(m); return m;
  };
  if (kind === 'animal') {
    part(new THREE.CapsuleGeometry(.2, .55, 4, 8), dark, 0, .45, 0).rotation.z = Math.PI / 2;
    part(new THREE.SphereGeometry(.18, 8, 6), dark, .4, .62, 0);
    for (const x of [-.25, .25]) for (const z of [-.13, .13]) part(new THREE.CylinderGeometry(.04, .04, .3, 6), dark, x, .15, z);
  } else if (kind === 'warm_spot') {
    part(new THREE.SphereGeometry(.65, 10, 6), mat, 0, .12, 0).scale.set(1, .25, .8);
  } else {
    for (let i = 0; i < 4; i++) part(new THREE.BoxGeometry(1.4, .15, .3), i % 2 ? mat : dark, (i % 2) * .3, .12 + i * .13, 0).rotation.y = i * .65;
  }
  return group;
}
