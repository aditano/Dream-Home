// Build assets/dream_house_mobile.glb from assets/dream_house.glb.
// KTX2/Basis is not used. The transcoder needs a large WASM heap and a worker,
// and iOS Safari is unreliable on that path (OffscreenCanvas in workers starts
// in iOS 17). WebP is decoded by Safari itself.
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  getGLPrimitiveCount,
  getSceneVertexCount,
  instance,
  meshopt,
  prune,
  simplifyPrimitive,
  textureCompress,
  VertexCountMethod,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets/dream_house.glb');
const DST = path.join(root, 'assets/dream_house_mobile.glb');
const TRI_BUDGET = 700000;
const FILE_BUDGET = 12 * 1024 * 1024;

const PHYSICAL = [
  'KHR_materials_transmission',
  'KHR_materials_clearcoat',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_volume',
  'KHR_materials_sheen',
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_materials_dispersion',
];

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

const doc = await io.read(SRC);
console.log('source drawn tris', Math.round(drawnTris()));

for (const mat of doc.getRoot().listMaterials()) {
  mat.setNormalTexture(null);
  mat.setOcclusionTexture(null);
  if (mat.getMetallicRoughnessTexture()) {
    const name = (mat.getName() || '').toLowerCase();
    const metal = /brass|chrome|steel|metal|copper|aluminum|aluminium/.test(name);
    mat.setMetallicRoughnessTexture(null);
    mat.setMetallicFactor(metal ? 0.85 : 0);
    const rough = mat.getRoughnessFactor();
    mat.setRoughnessFactor(metal ? 0.35 : Math.min(Math.max(rough || 0.75, 0.45), 0.95));
  }
  let glass = false;
  for (const extName of PHYSICAL) {
    const ext = mat.getExtension(extName);
    if (!ext) continue;
    if (extName === 'KHR_materials_transmission') glass = true;
    ext.dispose();
  }
  if (glass && mat.getAlphaMode() === 'OPAQUE') {
    mat.setAlphaMode('BLEND');
    mat.setAlpha(Math.min(mat.getAlpha() || 1, 0.22));
  }
}
await doc.transform(prune());

function drawnTris() {
  return getSceneVertexCount(doc.getRoot().listScenes()[0], VertexCountMethod.RENDER) / 3;
}

function meshTris(mesh) {
  let tris = 0;
  for (const prim of mesh.listPrimitives()) tris += getGLPrimitiveCount(prim);
  return tris;
}

function asFloat(accessor) {
  const array = accessor.getArray();
  if (array instanceof Float32Array) return array;
  const out = new Float32Array(array.length);
  if (!accessor.getNormalized()) {
    out.set(array);
    return out;
  }
  const type = accessor.getComponentType();
  const max = type === 5123 ? 65535 : type === 5122 || type === 5120 ? 32767 : type === 5121 ? 255 : 127;
  for (let i = 0; i < array.length; i++) out[i] = array[i] / max;
  return out;
}

// Flat shading gives every corner its own vertex, so the simplifier has no
// edges to collapse. Snap positions onto a small grid and merge those vertices.
function weldPositions(prim) {
  const document = Document.fromGraph(prim.getGraph());
  const position = prim.getAttribute('POSITION');
  const index = prim.getIndices();
  if (!position || !index) return null;
  const pos = asFloat(position);
  const srcIndex = index.getArray();
  const vertCount = (pos.length / 3) | 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const grid = Math.min(0.025, Math.max(0.0015, extent * 0.0012));
  const remap = new Uint32Array(vertCount);
  const map = new Map();
  const reps = [];
  for (let v = 0; v < vertCount; v++) {
    const ix = Math.round(pos[v * 3] / grid);
    const iy = Math.round(pos[v * 3 + 1] / grid);
    const iz = Math.round(pos[v * 3 + 2] / grid);
    const key = (BigInt(ix + 0x100000) << 42n) | (BigInt(iy + 0x100000) << 21n) | BigInt(iz + 0x100000);
    let id = map.get(key);
    if (id === undefined) {
      id = reps.length;
      map.set(key, id);
      reps.push(v);
    }
    remap[v] = id;
  }
  const semantics = prim.listSemantics();
  const attributes = prim.listAttributes();
  for (let s = 0; s < semantics.length; s++) {
    const acc = attributes[s];
    const src = acc.getArray();
    const itemSize = acc.getElementSize();
    const dst = new src.constructor(reps.length * itemSize);
    for (let i = 0; i < reps.length; i++) {
      const from = reps[i] * itemSize;
      dst.set(src.subarray(from, from + itemSize), i * itemSize);
    }
    const next = document.createAccessor().setType(acc.getType()).setArray(dst);
    if (acc.getNormalized()) next.setNormalized(true);
    prim.setAttribute(semantics[s], next);
  }
  const dstIndex = new Uint32Array(srcIndex.length);
  let w = 0;
  for (let i = 0; i < srcIndex.length; i += 3) {
    const a = remap[srcIndex[i]];
    const b = remap[srcIndex[i + 1]];
    const c = remap[srcIndex[i + 2]];
    if (a === b || b === c || a === c) continue;
    dstIndex[w++] = a;
    dstIndex[w++] = b;
    dstIndex[w++] = c;
  }
  prim.setIndices(document.createAccessor().setArray(dstIndex.subarray(0, w)));
  return w / 3;
}

function simplifyMesh(mesh, opts) {
  for (const prim of [...mesh.listPrimitives()]) {
    if (prim.getMode() !== 4) continue;
    if (!prim.getIndices() || !prim.getAttribute('POSITION')) continue;
    if (getGLPrimitiveCount(prim) < 80) continue;
    try {
      weldPositions(prim);
      if (getGLPrimitiveCount(prim) < 80) continue;
      simplifyPrimitive(prim, {
        simplifier: MeshoptSimplifier,
        ratio: opts.ratio,
        error: opts.error,
        lockBorder: false,
        cleanup: false,
      });
    } catch (err) {
      console.warn('simplify skipped', mesh.getName(), err.message);
    }
  }
}

function profile(name, tris) {
  const n = (name || '').toLowerCase();
  if (/tree|shrub|fern|plant|flower|leaves|hedge|ivy|grass|foliage|bush/.test(n)) {
    return { ratio: 0.06, error: 0.6 };
  }
  if (/curtain|towel|pillow|duvet|rug|cushion|fabric|cloth|blanket/.test(n)) {
    return { ratio: 0.25, error: 0.4 };
  }
  if (/terrain|ground/.test(n)) return { ratio: 0.1, error: 0.35 };
  if (tris > 80000) return { ratio: 0.07, error: 0.45 };
  if (tris > 15000) return { ratio: 0.12, error: 0.4 };
  if (tris > 4000) return { ratio: 0.22, error: 0.35 };
  if (tris > 800) return { ratio: 0.4, error: 0.35 };
  return null;
}

for (const mesh of [...doc.getRoot().listMeshes()]) {
  const opts = profile(mesh.getName(), meshTris(mesh));
  if (opts) simplifyMesh(mesh, opts);
}
console.log('drawn tris after first pass', Math.round(drawnTris()));

let guard = 0;
while (drawnTris() > TRI_BUDGET && guard < 6) {
  guard += 1;
  const ranked = doc.getRoot().listMeshes()
    .map((mesh) => ({ mesh, tris: meshTris(mesh) }))
    .filter((row) => row.tris > 2000)
    .sort((a, b) => b.tris - a.tris)
    .slice(0, 10);
  if (!ranked.length) break;
  console.log('extra pass', guard, 'drawn', Math.round(drawnTris()), 'cutting', ranked[0].mesh.getName(), ranked[0].tris);
  for (const row of ranked) simplifyMesh(row.mesh, { ratio: 0.5, error: 1 });
}

await doc.transform(prune(), dedup(), instance({ min: 2 }), prune());
const tris = Math.round(drawnTris());
console.log('drawn tris after mesh passes', tris);

function normDiv(accessor) {
  if (!accessor.getNormalized()) return 1;
  const type = accessor.getComponentType();
  if (type === 5122 || type === 5120) return 32767;
  if (type === 5123) return 65535;
  if (type === 5121) return 255;
  return 127;
}

function columnScale(matrix) {
  return [
    Math.hypot(matrix[0], matrix[1], matrix[2]),
    Math.hypot(matrix[4], matrix[5], matrix[6]),
    Math.hypot(matrix[8], matrix[9], matrix[10]),
  ];
}

const spanByMesh = new Map();
{
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const scale = columnScale(node.getWorldMatrix());
      let span = 0;
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const min = pos.getMin([0, 0, 0]);
        const max = pos.getMax([0, 0, 0]);
        const div = normDiv(pos);
        const dx = Math.abs(max[0] - min[0]) / div * scale[0];
        const dy = Math.abs(max[1] - min[1]) / div * scale[1];
        const dz = Math.abs(max[2] - min[2]) / div * scale[2];
        span = Math.max(span, dx, dy, dz);
      }
      spanByMesh.set(mesh, Math.max(spanByMesh.get(mesh) || 0, span));
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const child of doc.getRoot().listScenes()[0].listChildren()) visit(child);
}
const rankedTex = [];
for (const mat of doc.getRoot().listMaterials()) {
  const tex = mat.getBaseColorTexture();
  if (!tex) continue;
  let span = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    if (mesh.listPrimitives().some((prim) => prim.getMaterial() === mat)) {
      span = Math.max(span, spanByMesh.get(mesh) || 0);
    }
  }
  const prev = rankedTex.find((row) => row.tex === tex);
  if (prev) prev.span = Math.max(prev.span, span);
  else rankedTex.push({ tex, span });
}
rankedTex.sort((a, b) => b.span - a.span);
// Surfaces about 8 meters and up keep a 512 texture. Smaller props use 256
// so decoded RGBA stays in a range an iPhone can keep on the GPU.
const heroes = new Set(rankedTex.filter((row) => row.span >= 8).slice(0, 28).map((row) => row.tex));
console.log('texture spans', rankedTex.slice(0, 6).map((row) => Number(row.span.toFixed(1))), 'heroes', heroes.size);

let gpuBytes = 0;
let texCount = 0;
for (const tex of doc.getRoot().listTextures()) {
  const image = tex.getImage();
  const size = tex.getSize();
  if (!image || !size) continue;
  const limit = heroes.has(tex) ? 512 : 256;
  if (Math.max(size[0], size[1]) > limit) {
    const next = new Uint8Array(await sharp(Buffer.from(image))
      .resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: heroes.has(tex) ? 70 : 62, effort: 4 })
      .toBuffer());
    tex.setImage(next);
    tex.setMimeType('image/webp');
  }
  const outSize = tex.getSize() || [limit, limit];
  gpuBytes += outSize[0] * outSize[1] * 4;
  texCount += 1;
}
console.log('textures', texCount, 'heroes', heroes.size, 'rgba bytes', gpuBytes);

await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 68, effort: 4 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);

await io.write(DST, doc);
const outDoc = await io.read(DST);
const outTris = Math.round(getSceneVertexCount(outDoc.getRoot().listScenes()[0], VertexCountMethod.RENDER) / 3);
const bytes = statSync(DST).size;
console.log(JSON.stringify({ outTris, bytes, gpuBytes, texCount, heroes: heroes.size }, null, 2));
if (outTris > 900000) {
  console.error('triangle budget missed', outTris);
  process.exit(1);
}
if (bytes > FILE_BUDGET) {
  console.error('file budget missed', bytes);
  process.exit(1);
}
