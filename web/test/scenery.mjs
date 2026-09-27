// Runs on Node 22.18+ (native TypeScript stripping); no browser or downloaded models needed.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { batchScenery } from '../src/models.ts';

const root = new THREE.Group();
root.position.set(8, 2, -9); root.rotation.y = .3;
const geometry = new THREE.BoxGeometry(1, 2, 3);
const material = new THREE.MeshStandardMaterial();
const originals = [];
for (let i = 0; i < 24; i++) {
  const parent = new THREE.Group(); parent.position.set(i * 3, 0, -i);
  parent.rotation.y = i / 5; parent.scale.setScalar(.5 + i / 20);
  const mesh = new THREE.Mesh(geometry, material); mesh.userData.shared = true;
  mesh.position.set(2, 3, 4); mesh.rotation.z = .2;
  parent.add(mesh); root.add(parent); originals.push(mesh);
}
const house = new THREE.Mesh(geometry, material.clone());
house.userData.sharedGeometry = true; root.add(house);
const unique = new THREE.Mesh(new THREE.SphereGeometry(), material);
unique.userData.shared = true; root.add(unique);
root.updateMatrixWorld(true);
const expected = originals.map(mesh => mesh.matrixWorld.clone());
batchScenery(root);
root.updateMatrixWorld(true);
const batches = root.children.filter(o => o.isInstancedMesh);
assert.equal(batches.length, 1, 'all repeated geometry/material pairs become one draw');
const batch = batches[0];
assert.equal(batch.count, 24);
assert.equal(batch.geometry, geometry, 'reuse cached geometry');
assert.equal(batch.material, material, 'reuse cached material');
assert.equal(batch.userData.shared, true, 'reset must not dispose cache-owned resources');
assert.equal(house.parent, root, 'independent house materials remain available for truth fading');
assert.equal(unique.parent, root, 'unique mesh stays intact');
for (let i = 0; i < 24; i++) {
  const actual = new THREE.Matrix4(); batch.getMatrixAt(i, actual); actual.premultiply(batch.matrixWorld);
  assert.ok(actual.elements.every((v, k) => Math.abs(v - expected[i].elements[k]) < 1e-5), `instance ${i} retains nested transforms`);
}
console.log('Scenery batching: 24 → 1 draw, transforms and resource ownership preserved.');
