// Run: node test/scenery.mjs. Actual Three.js geometry, no WebGL required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Transpile the actual renderer module in memory; leave no generated source behind.
const source = readFileSync(new URL('../src/models.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source);
const resolved = js.replace(/from '([^']+)'/g, (_, name) => `from '${import.meta.resolve(name)}'`);
const { dressScene, truthVisual, loadModels, model } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));
const scene = fixture.events.find(e => e.type === 'mission.snapshot').payload.scene;
const original = JSON.stringify(scene);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
freeze(scene);
const signatures = [];
for (const seed of [0, 7, 104]) {
  const build = () => {
    const root = new THREE.Group();
    const materials = dressScene(scene, seed, root, y => 70 + 18 * Math.sin(y / 37 + seed));
    const structures = root.children.filter(c => c.userData.structure);
    assert.equal(structures.length, scene.houses.length);
    structures.forEach((group, i) => {
      const h = scene.houses[i];
      assert.deepEqual(group.position.toArray(), [h.x, 0, -h.y]);
      assert.deepEqual(group.userData.structure, h);
      const bounds = new THREE.Box3().setFromObject(group);
      assert.ok(Math.abs(bounds.min.x - (h.x - h.width / 2)) < 1e-5);
      assert.ok(Math.abs(bounds.max.x - (h.x + h.width / 2)) < 1e-5);
      assert.ok(Math.abs(bounds.min.z - (-h.y - h.height / 2)) < 1e-5);
      assert.ok(Math.abs(bounds.max.z - (-h.y + h.height / 2)) < 1e-5);
      group.traverse(o => { if (o.isMesh) assert.ok(materials.includes(o.material), 'every structure part must fade in truth mode'); });
      // A centre subject still has overhead shelter even after the roof is damaged.
      const ray = new THREE.Raycaster(new THREE.Vector3(h.x, 20, -h.y), new THREE.Vector3(0, -1, 0));
      assert.ok(ray.intersectObject(group, true).some(hit => hit.point.y > 3), 'centre retains shelter');
    });
    const debris = root.children.filter(c => c.isInstancedMesh);
    assert.equal(debris.length, 3);
    assert.ok(debris.reduce((n, d) => n + d.count, 0) > 1000);
    const matrix = new THREE.Matrix4(), pos = new THREE.Vector3();
    for (const batch of debris) for (let i = 0; i < batch.count; i++) {
      batch.getMatrixAt(i, matrix); pos.setFromMatrixPosition(matrix);
      assert.ok(scene.houses.every(h => Math.abs(pos.x - h.x) > h.width / 2 + 2 || Math.abs(-pos.z - h.y) > h.height / 2 + 2));
    }
    return JSON.stringify(debris.map(d => Array.from(d.instanceMatrix.array)));
  };
  const signature = build(); assert.equal(build(), signature, 'same seed reproduces scenery'); signatures.push(signature);
}
assert.notEqual(signatures[0], signatures[1]);
assert.equal(JSON.stringify(scene), original, 'renderer must not mutate mission data');
for (const kind of ['animal', 'warm_spot', 'debris', 'person_shaped_junk']) {
  const visual = truthVisual(kind, '#aabbcc');
  assert.deepEqual(visual.position.toArray(), [0, 0, 0], 'caller controls truth anchor');
  assert.ok(visual.children.length > 0);
}
console.log('ok — seeds 0, 7, 104: structure anchors, footprints, shelter, truth fade, decorative separation, determinism, immutable scene, truth visuals');

// GLTF assets commonly share a material/geometry across submeshes. Weather them only once.
const originalLoad = GLTFLoader.prototype.loadAsync;
GLTFLoader.prototype.loadAsync = async () => {
  const scene = new THREE.Group(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial({ color: '#ffffff' });
  scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material)); return { scene };
};
try {
  await loadModels();
  const car = model('sedan', 4); let checked = 0;
  car.traverse(o => {
    if (!o.isMesh) return;
    assert.ok(o.material.color.equals(new THREE.Color('#a1a59a')), 'shared material is tinted once');
    o.geometry.computeBoundingBox();
    assert.ok(Math.abs(o.geometry.boundingBox.max.y - .365) < 1e-6, 'shared geometry is dented once'); checked++;
  });
  assert.equal(checked, 2);
} finally { GLTFLoader.prototype.loadAsync = originalLoad; }
console.log('ok — cached shared GLTF materials and geometry are weathered once');
