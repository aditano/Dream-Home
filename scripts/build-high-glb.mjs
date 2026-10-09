// Build the High and Balanced phone models from assets/dream_house.glb.
// High keeps the house shell and large-surface textures, and sheds the maps
// and triangles that blow the iOS GPU budget. Balanced is the same geometry
// with smaller textures and no extra maps, so a crash can step down for real.
// KTX2 is not used. Safari decodes WebP itself.
import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  cloneDocument,
  dedup,
  getGLPrimitiveCount,
  getSceneVertexCount,
  meshopt,
  prune,
  simplifyPrimitive,
  VertexCountMethod,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(rootDir, 'assets/dream_house.glb');
const SHELL_OUT = path.join(rootDir, 'assets/dream_house_high_shell.glb');
const PROPS_OUT = path.join(rootDir, 'assets/dream_house_high_props.glb');
const BALANCED_OUT = path.join(rootDir, 'assets/dream_house_balanced.glb');
const REPORT_OUT = path.join(rootDir, 'assets/tier-report.json');

const TRI_TARGET = 1400000;
const TRI_HARD = 1500000;
const HIGH_FILE_BUDGET = 25 * 1024 * 1024;
const BALANCED_FILE_BUDGET = 20 * 1024 * 1024;
const HIGH_GPU_BUDGET = 380 * 1024 * 1024;

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

const HERO = new Set([
  'brick', 'limestone', 'fieldstone', 'roof', 'wood', 'woodfloor', 'walnut',
  'tile', 'marble_floor', 'marble_back', 'marble_front', 'concrete', 'paving',
  'deck', 'asphalt', 'grass', 'counter', 'subway', 'subway_sage', 'bathfloor',
  'hexfloor', 'carriage', 'porchceil', 'mulch', 'linen2', 'jacquard',
  'rug_wool', 'rug_herr',
]);

const NORMAL_HERO = new Set([
  'brick', 'limestone', 'fieldstone', 'roof', 'wood', 'woodfloor', 'walnut',
  'paving', 'grass', 'marble_floor', 'tile', 'subway', 'subway_sage', 'concrete', 'deck',
]);

const MR_HERO = new Set([
  'brick', 'limestone', 'fieldstone', 'roof', 'wood', 'woodfloor', 'walnut',
  'paving', 'marble_floor', 'tile', 'grass', 'concrete',
]);

const SHELL_MATS = new Set([
  'brick', 'limestone', 'fieldstone', 'grass', 'asphalt', 'paving', 'concrete',
  'deck', 'roof', 'carriage', 'porchceil', 'mulch', 'woodfloor',
]);

const SHELL_RE = /accent_wall|apron_medallion|cheek_wall|terrain|gate_apron|carport_roof|carport_pad|porch_can|porch_deck|eyebrow_brace|eyebrow_soffit|balcony_door|bed_mulch|glan_glass|attic_floor|(?:^|\s)apron(?:\s|$)/;

const PROTECT_RE = /accent_wall|apron_medallion|cheek_wall|gate_apron|carport_roof|carport_pad|porch_can|porch_deck|eyebrow_brace|eyebrow_soffit|balcony_door|bed_mulch|glan_glass|attic_floor|(?:^|\s)apron(?:\s|$)/;

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
console.log('source drawn tris', Math.round(drawnTris(doc)));

for (const mat of doc.getRoot().listMaterials()) {
  for (const extName of PHYSICAL) {
    const ext = mat.getExtension(extName);
    if (!ext) continue;
    const glass = extName === 'KHR_materials_transmission';
    ext.dispose();
    if (glass && mat.getAlphaMode() === 'OPAQUE') {
      mat.setAlphaMode('BLEND');
      mat.setAlpha(Math.min(mat.getAlpha() || 1, 0.22));
    }
  }
}

function drawnTris(document) {
  const scene = document.getRoot().listScenes()[0];
  if (!scene) return 0;
  return getSceneVertexCount(scene, VertexCountMethod.RENDER) / 3;
}

function meshTris(mesh) {
  let tris = 0;
  for (const prim of mesh.listPrimitives()) tris += getGLPrimitiveCount(prim);
  return tris;
}

function asFloat(accessor) {
  const array = accessor.getArray();
  if (!array) return new Float32Array();
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

function weldPositions(prim) {
  const document = Document.fromGraph(prim.getGraph());
  const position = prim.getAttribute('POSITION');
  const index = prim.getIndices();
  if (!position || !index || !document) return null;
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
  const grid = Math.min(0.02, Math.max(0.0015, extent * 0.0012));
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
    if (!src) continue;
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

const meshLabels = new Map();
{
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const mats = mesh.listPrimitives().map((prim) => prim.getMaterial()?.getName() || '').join(' ');
      const prev = meshLabels.get(mesh) || '';
      meshLabels.set(mesh, `${prev} ${node.getName() || ''} ${mesh.getName() || ''} ${mats}`.toLowerCase());
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const child of doc.getRoot().listScenes()[0].listChildren()) visit(child);
}

function simplifyOpts(label, tris) {
  const n = label || '';
  if (PROTECT_RE.test(n)) return null;
  if (/island_tree/.test(n)) return { ratio: 0.42, error: 0.035 };
  if (/terrain/.test(n)) return { ratio: 0.22, error: 0.08 };
  if (/tree|shrub|fern|plant|flower|leaves|hedge|ivy|foliage|bush|gazania|periwinkle/.test(n)) {
    return { ratio: 0.14, error: 0.35 };
  }
  if (/book/.test(n)) return { ratio: 0.1, error: 0.045 };
  if (/apple|bowl|vase|candle|pillow|cushion|towel|basket|clock|food/.test(n)) {
    return { ratio: 0.3, error: 0.08 };
  }
  if (/chair|sofa|shelf|bookshelf|lamp|table|frame|bench|bed|duvet|curtain|pendant/.test(n)) {
    return { ratio: 0.42, error: 0.045 };
  }
  if (tris > 20000) return { ratio: 0.35, error: 0.05 };
  if (tris > 8000) return { ratio: 0.5, error: 0.04 };
  return null;
}

for (const mesh of [...doc.getRoot().listMeshes()]) {
  const label = meshLabels.get(mesh) || mesh.getName() || '';
  const opts = simplifyOpts(label, meshTris(mesh));
  if (opts) simplifyMesh(mesh, opts);
}
await doc.transform(prune());
console.log('drawn tris after first pass', Math.round(drawnTris(doc)));

let guard = 0;
while (drawnTris(doc) > TRI_TARGET && guard < 5) {
  guard += 1;
  const ranked = doc.getRoot().listMeshes()
    .map((mesh) => ({ mesh, tris: meshTris(mesh), label: meshLabels.get(mesh) || mesh.getName() || '' }))
    .filter((row) => row.tris > 2500 && !PROTECT_RE.test(row.label))
    .sort((a, b) => b.tris - a.tris)
    .slice(0, 8);
  if (!ranked.length) break;
  console.log('extra pass', guard, 'drawn', Math.round(drawnTris(doc)), 'cutting', ranked[0].label.trim().slice(0, 60), ranked[0].tris);
  for (const row of ranked) simplifyMesh(row.mesh, { ratio: 0.55, error: 0.2 });
  await doc.transform(prune());
}

await doc.transform(prune(), dedup());
console.log('drawn tris after mesh passes', Math.round(drawnTris(doc)));

function nodeLabel(node) {
  const mesh = node.getMesh();
  const mats = mesh ? mesh.listPrimitives().map((prim) => prim.getMaterial()?.getName() || '').join(' ') : '';
  return `${node.getName() || ''} ${mesh?.getName() || ''} ${mats}`.toLowerCase();
}

function isFoliageLabel(label) {
  return /tree|shrub|fern|plant|flower|leaves|hedge|ivy|foliage|bush|gazania|periwinkle/.test(label);
}

function isShellNode(node) {
  const label = nodeLabel(node);
  if (SHELL_RE.test(label)) return true;
  const mesh = node.getMesh();
  if (!mesh) return false;
  const mats = mesh.listPrimitives()
    .map((prim) => (prim.getMaterial()?.getName() || '').toLowerCase())
    .filter(Boolean);
  return mats.length > 0 && mats.every((name) => SHELL_MATS.has(name));
}

function transformPoint(x, y, z, wm) {
  return [
    wm[0] * x + wm[4] * y + wm[8] * z + wm[12],
    wm[1] * x + wm[5] * y + wm[9] * z + wm[13],
    wm[2] * x + wm[6] * y + wm[10] * z + wm[14],
  ];
}

function transformNormal(nx, ny, nz, wm) {
  const sx = Math.hypot(wm[0], wm[1], wm[2]) || 1;
  const x = (wm[0] * nx + wm[4] * ny + wm[8] * nz) / sx;
  const y = (wm[1] * nx + wm[5] * ny + wm[9] * nz) / sx;
  const z = (wm[2] * nx + wm[6] * ny + wm[10] * nz) / sx;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function bakeAO(document) {
  const min = [-20, -3, -30];
  const max = [60, 24, 110];
  const cell = 0.42;
  const nx = Math.ceil((max[0] - min[0]) / cell);
  const ny = Math.ceil((max[1] - min[1]) / cell);
  const nz = Math.ceil((max[2] - min[2]) / cell);
  const grid = new Uint8Array(nx * ny * nz);
  const indexOf = (p) => {
    const ix = Math.floor((p[0] - min[0]) / cell);
    const iy = Math.floor((p[1] - min[1]) / cell);
    const iz = Math.floor((p[2] - min[2]) / cell);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return -1;
    return ix + nx * (iy + ny * iz);
  };
  const mark = (p) => {
    const id = indexOf(p);
    if (id >= 0) grid[id] = 1;
  };

  const scene = document.getRoot().listScenes()[0];
  const meshNodes = [];
  const visit = (node) => {
    if (node.getMesh()) meshNodes.push(node);
    for (const child of node.listChildren()) visit(child);
  };
  for (const child of scene.listChildren()) visit(child);

  for (const node of meshNodes) {
    if (node.getExtension('EXT_mesh_gpu_instancing')) continue;
    const label = nodeLabel(node);
    if (isFoliageLabel(label)) continue;
    const mesh = node.getMesh();
    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      if (!position || !indices) continue;
      const pos = asFloat(position);
      const src = indices.getArray();
      for (let i = 0; i < src.length; i += 3) {
        for (const v of [src[i], src[i + 1], src[i + 2]]) {
          mark(transformPoint(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], wm));
        }
      }
    }
  }

  const dirs = [
    [0, 1, 0],
    [0.55, 0.75, 0],
    [-0.55, 0.75, 0],
    [0, 0.75, 0.55],
    [0, 0.75, -0.55],
  ];

  let baked = 0;
  for (const node of meshNodes) {
    if (node.getExtension('EXT_mesh_gpu_instancing')) continue;
    const label = nodeLabel(node);
    if (isFoliageLabel(label) || /terrain/.test(label)) continue;
    const mesh = node.getMesh();
    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      const normal = prim.getAttribute('NORMAL');
      if (!position || !normal) continue;
      const pos = asFloat(position);
      const nrm = asFloat(normal);
      const count = (pos.length / 3) | 0;
      if (!count || count > 800000) continue;
      const colors = new Uint8Array(count * 3);
      for (let v = 0; v < count; v++) {
        const p = transformPoint(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], wm);
        const n = transformNormal(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2], wm);
        const up = Math.abs(n[1]) < 0.85 ? [0, 1, 0] : [1, 0, 0];
        let tx = up[1] * n[2] - up[2] * n[1];
        let ty = up[2] * n[0] - up[0] * n[2];
        let tz = up[0] * n[1] - up[1] * n[0];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const bx = n[1] * tz - n[2] * ty;
        const by = n[2] * tx - n[0] * tz;
        const bz = n[0] * ty - n[1] * tx;
        let hits = 0;
        for (const d of dirs) {
          const dx = tx * d[0] + bx * d[2] + n[0] * d[1];
          const dy = ty * d[0] + by * d[2] + n[1] * d[1];
          const dz = tz * d[0] + bz * d[2] + n[2] * d[1];
          const len = Math.hypot(dx, dy, dz) || 1;
          let hit = false;
          for (let step = 1; step <= 4; step++) {
            const dist = 0.38 + step * 0.42;
            const id = indexOf([p[0] + (dx / len) * dist, p[1] + (dy / len) * dist, p[2] + (dz / len) * dist]);
            if (id >= 0 && grid[id]) { hit = true; break; }
          }
          if (hit) hits++;
        }
        const ao = 1 - 0.62 * (hits / dirs.length);
        const byte = Math.max(48, Math.min(255, Math.round(ao * 255)));
        colors[v * 3] = byte;
        colors[v * 3 + 1] = byte;
        colors[v * 3 + 2] = byte;
      }
      const graphDoc = Document.fromGraph(prim.getGraph());
      const acc = graphDoc.createAccessor().setType('VEC3').setArray(colors).setNormalized(true);
      prim.setAttribute('COLOR_0', acc);
      baked += 1;
    }
  }
  console.log('ao primitives', baked, 'grid', `${nx}x${ny}x${nz}`);
}

const aoStart = Date.now();
bakeAO(doc);
console.log('ao seconds', ((Date.now() - aoStart) / 1000).toFixed(1));

function baseLimit(name, tier) {
  const n = (name || '').toLowerCase();
  if (n.startsWith('palette')) return 512;
  if (/plant|fern|shrub|flower|leaves|foliage|gazania|periwinkle|ivy|hedge/.test(n)) return 128;
  if (/candle|vase|apple|bowl|basket|clock|food|pot_enamel|brass_vase/.test(n)) return tier === 'high' ? 256 : 128;
  if (HERO.has(n)) return tier === 'high' ? 1024 : 512;
  if (/artwork|picture|pillow|linen|jacquard|rug|towel|fabric/.test(n)) return tier === 'high' ? 512 : 256;
  return tier === 'high' ? 512 : 256;
}

const factorCache = new Map();
async function mrFactors(tex) {
  if (factorCache.has(tex)) return factorCache.get(tex);
  const image = tex.getImage();
  if (!image) return { rough: 0.7, metal: 0 };
  const small = await sharp(Buffer.from(image), { failOn: 'none' }).resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  let g = 0;
  let b = 0;
  const n = small.length / 3;
  for (let i = 0; i < small.length; i += 3) {
    g += small[i + 1];
    b += small[i + 2];
  }
  const out = { rough: g / n / 255, metal: b / n / 255 };
  factorCache.set(tex, out);
  return out;
}

async function resizeTexture(tex, limit, quality) {
  const size = tex.getSize();
  const image = tex.getImage();
  if (!image || !size) return;
  const maxEdge = Math.max(size[0], size[1]);
  if (maxEdge <= limit) return;
  const next = new Uint8Array(await sharp(Buffer.from(image), { failOn: 'none' })
    .resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4, alphaQuality: Math.min(quality, 80) })
    .toBuffer());
  tex.setImage(next);
  tex.setMimeType('image/webp');
}

function bump(map, tex, limit) {
  if (!tex) return;
  map.set(tex, Math.max(map.get(tex) || 0, limit));
}

async function applyTextures(document, tier) {
  const baseLimits = new Map();
  const mrLimits = new Map();
  const norLimits = new Map();
  for (const mat of document.getRoot().listMaterials()) {
    const name = mat.getName() || '';
    bump(baseLimits, mat.getBaseColorTexture(), baseLimit(name, tier));
    if (tier === 'high' && MR_HERO.has(name.toLowerCase())) bump(mrLimits, mat.getMetallicRoughnessTexture(), 512);
    if (tier === 'high' && NORMAL_HERO.has(name.toLowerCase())) bump(norLimits, mat.getNormalTexture(), 512);
  }
  for (const mat of document.getRoot().listMaterials()) {
    const mr = mat.getMetallicRoughnessTexture();
    if (mr && !mrLimits.has(mr)) {
      const factors = await mrFactors(mr);
      mat.setRoughnessFactor(Math.min(1, Math.max(0.08, factors.rough || 0.65)));
      mat.setMetallicFactor(Math.min(1, Math.max(0, factors.metal || 0)));
      mat.setMetallicRoughnessTexture(null);
    }
    const nor = mat.getNormalTexture();
    if (nor && !norLimits.has(nor)) mat.setNormalTexture(null);
    const occ = mat.getOcclusionTexture();
    if (occ) mat.setOcclusionTexture(null);
  }
  const emissiveLimit = tier === 'high' ? 256 : 128;
  for (const mat of document.getRoot().listMaterials()) {
    const tex = mat.getBaseColorTexture();
    if (tex && baseLimits.has(tex)) {
      const hero = HERO.has((mat.getName() || '').toLowerCase());
      await resizeTexture(tex, baseLimits.get(tex), hero && tier === 'high' ? 78 : 68);
    }
    const mr = mat.getMetallicRoughnessTexture();
    if (mr && mrLimits.has(mr)) await resizeTexture(mr, mrLimits.get(mr), 70);
    const nor = mat.getNormalTexture();
    if (nor && norLimits.has(nor)) await resizeTexture(nor, norLimits.get(nor), 74);
    const em = mat.getEmissiveTexture();
    if (em) await resizeTexture(em, emissiveLimit, 70);
  }
  await document.transform(prune(), dedup());
}

function estimateGPU(document) {
  let bytes = 0;
  let count = 0;
  for (const tex of document.getRoot().listTextures()) {
    const size = tex.getSize();
    if (!size) continue;
    const mip = Math.max(size[0], size[1]) > 8;
    bytes += Math.round(size[0] * size[1] * 4 * (mip ? 4 / 3 : 1));
    count += 1;
  }
  return { bytes, count };
}

function listMeshNodes(document) {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.listChildren()) visit(child);
  };
  for (const child of document.getRoot().listScenes()[0].listChildren()) visit(child);
  return nodes;
}

function dropNodes(document, keepShell) {
  const scene = document.getRoot().listScenes()[0];
  const drop = listMeshNodes(document).filter((node) => node.getMesh() && isShellNode(node) !== keepShell);
  for (const node of drop) {
    const parent = node.getParentNode();
    if (parent) parent.removeChild(node);
    else scene.removeChild(node);
    node.dispose();
  }
  return drop.length;
}

async function writePart(document, file, label) {
  await document.transform(
    prune(),
    dedup(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(file, document);
  const bytes = statSync(file).size;
  const check = await io.read(file);
  const tris = Math.round(drawnTris(check));
  const gpu = estimateGPU(check);
  let prims = 0;
  for (const mesh of check.getRoot().listMeshes()) prims += mesh.listPrimitives().length;
  console.log(label, JSON.stringify({ tris, bytes, gpuBytes: gpu.bytes, textures: gpu.count, prims }));
  return { label, file: path.basename(file), tris, bytes, gpuBytes: gpu.bytes, textures: gpu.count, prims };
}

console.log('applying high textures');
await applyTextures(doc, 'high');
const highGPU = estimateGPU(doc);
console.log('high gpu before split', highGPU);

const propsDoc = cloneDocument(doc);
const balancedDoc = cloneDocument(doc);

const shellDropped = dropNodes(doc, true);
const propsDropped = dropNodes(propsDoc, false);
console.log('dropped from shell', shellDropped, 'dropped from props', propsDropped);

const shellReport = await writePart(doc, SHELL_OUT, 'high-shell');
const propsReport = await writePart(propsDoc, PROPS_OUT, 'high-props');

console.log('applying balanced textures');
await applyTextures(balancedDoc, 'balanced');
const balancedReport = await writePart(balancedDoc, BALANCED_OUT, 'balanced');

const highBytes = shellReport.bytes + propsReport.bytes;
const highTris = shellReport.tris + propsReport.tris;
const highGpuBytes = shellReport.gpuBytes + propsReport.gpuBytes;
const report = {
  high: {
    files: [shellReport, propsReport],
    triangles: highTris,
    fileBytes: highBytes,
    textureBytes: highGpuBytes,
    textures: shellReport.textures + propsReport.textures,
    primitives: shellReport.prims + propsReport.prims,
  },
  balanced: balancedReport,
  notes: {
    low: 'assets/dream_house_mobile.glb is the existing low tier and is not rebuilt here.',
    ao: 'Vertex colors on the non-instanced shell and furniture store a coarse corner darkening.',
    textures: 'Big surfaces stay at the source 1024. Props step down. High keeps a few 512 normal and roughness maps.',
  },
};
writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (highTris > TRI_HARD) {
  console.error('triangle budget missed', highTris);
  process.exit(1);
}
if (highBytes > HIGH_FILE_BUDGET) {
  console.error('high file budget missed', highBytes);
  process.exit(1);
}
if (balancedReport.bytes > BALANCED_FILE_BUDGET) {
  console.error('balanced file budget missed', balancedReport.bytes);
  process.exit(1);
}
if (highGpuBytes > HIGH_GPU_BUDGET) {
  console.error('high texture budget missed', highGpuBytes);
  process.exit(1);
}
if (shellReport.tris < 1000 || propsReport.tris < 1000) {
  console.error('split looks empty', shellReport.tris, propsReport.tris);
  process.exit(1);
}
