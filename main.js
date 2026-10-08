import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MODEL_URL = 'assets/dream_house.glb';
const VIEWS_URL = 'assets/viewpoints.json';
const FOREST_URL = 'assets/forest.json';
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------- renderer / scene ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 4000);
camera.position.set(15, 6, 54);


const sky = new Sky();
sky.scale.setScalar(3500);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(200));
Object.assign(sky.material.uniforms, {});
sky.material.uniforms.turbidity.value = 4;
sky.material.uniforms.rayleigh.value = 1.4;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.8;
sky.material.uniforms.sunPosition.value.copy(sunDir);
scene.add(sky);
// image based lighting from the same sky, so glass and metal reflect sky instead of a studio box
const pmrem = new THREE.PMREMGenerator(renderer);
{
  const envScene = new THREE.Scene();
  const envSky = new Sky(); envSky.scale.setScalar(50);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) envSky.material.uniforms[k].value = sky.material.uniforms[k].value;
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envScene.add(envSky);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 24).rotateX(-Math.PI / 2).translate(0, -2, 0), new THREE.MeshBasicMaterial({ color: 0x4d5a3a }));
  envScene.add(ground);
  scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 100).texture;
  scene.environmentIntensity = 0.6;
}
scene.fog = new THREE.Fog(0xc9d3dc, 250, 1600);

scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x5b5040, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.copy(sunDir).multiplyScalar(120).add(new THREE.Vector3(15, 0, 0));
sun.target.position.set(15, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 400 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
// soft fill inside so rooms are readable without baked lights
const fill = new THREE.AmbientLight(0xfff4e6, 0.3);
scene.add(fill);

// ---------- controls ----------
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.maxDistance = 900;
orbit.minDistance = 0.3;
orbit.target.set(15, 5, 7);

let mode = 'orbit';
let speedMul = 1;
const keys = new Set();
const yawPitch = { yaw: 0, pitch: 0 };
let locked = false;
let velY = 0;
const colliders = [];
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;

// ---------- UI helpers ----------
const $ = (id) => document.getElementById(id);
const loadBar = $('load-bar'), loadText = $('load-text'), loadSub = $('load-sub');
const hudRoom = $('hud-room'), hudMode = $('hud-mode'), lockHint = $('lock-hint');
const MODE_HELP = {
  orbit: isTouch ? 'Orbit: one finger rotates, pinch zooms, two fingers pan' : 'Orbit: drag to rotate, scroll to zoom, right drag to pan',
  walk: isTouch ? 'Walk: joystick to move, drag to look' : 'Walk: click to look, WASD to move, Shift to sprint, Esc to release',
  fly: isTouch ? 'Fly: joystick to move, drag to look, Up/Down buttons' : 'Fly: click to look, WASD to move, E/Space up, Q/C down',
};

function setMode(m) {
  mode = m;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  hudMode.textContent = MODE_HELP[m];
  const fp = m !== 'orbit';
  orbit.enabled = !fp;
  if (fp) {
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    yawPitch.yaw = Math.atan2(-d.x, -d.z);
    yawPitch.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    velY = 0;
    if (!isTouch) lockHint.classList.remove('hidden');
  } else {
    if (document.pointerLockElement) document.exitPointerLock();
    lockHint.classList.add('hidden');
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    orbit.target.copy(camera.position).addScaledVector(d, camera.position.y > 30 ? 40 : 4);
  }
  $('joy').classList.toggle('hidden', !(fp && isTouch));
  $('flybtns').classList.toggle('hidden', !(m === 'fly' && isTouch));
}
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('speed').addEventListener('input', (e) => { speedMul = +e.target.value; $('speed-val').textContent = speedMul.toFixed(2).replace(/0$/, '') + 'x'; });
$('shadows').addEventListener('change', (e) => { sun.castShadow = e.target.checked; });
$('hq').addEventListener('change', (e) => { renderer.setPixelRatio(e.target.checked ? Math.min(devicePixelRatio, 2) : Math.min(devicePixelRatio, 1.25)); });
$('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// pointer lock look (desktop)
canvas.addEventListener('click', () => { if (mode !== 'orbit' && !isTouch) canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  lockHint.classList.toggle('hidden', locked || mode === 'orbit');
});
document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  yawPitch.yaw -= e.movementX * 0.0022;
  yawPitch.pitch = THREE.MathUtils.clamp(yawPitch.pitch - e.movementY * 0.0022, -1.5, 1.5);
});
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'Digit1') setMode('orbit');
  if (e.code === 'Digit2') setMode('walk');
  if (e.code === 'Digit3') setMode('fly');
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// touch look + joystick
const joy = { x: 0, y: 0, id: null };
const joyEl = $('joy'), knob = $('joy-knob');
joyEl.addEventListener('pointerdown', (e) => { joy.id = e.pointerId; joyEl.setPointerCapture(e.pointerId); moveJoy(e); });
joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === joy.id) moveJoy(e); });
const endJoy = () => { joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
joyEl.addEventListener('pointerup', endJoy);
joyEl.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  const r = joyEl.getBoundingClientRect();
  let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
  const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
  joy.x = dx; joy.y = dy;
  knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
}
let lookTouch = null;
canvas.addEventListener('pointerdown', (e) => { if (mode !== 'orbit' && e.pointerType !== 'mouse') lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointermove', (e) => {
  if (!lookTouch || e.pointerId !== lookTouch.id) return;
  yawPitch.yaw += (e.clientX - lookTouch.x) * 0.005;
  yawPitch.pitch = THREE.MathUtils.clamp(yawPitch.pitch + (e.clientY - lookTouch.y) * 0.005, -1.5, 1.5);
  lookTouch.x = e.clientX; lookTouch.y = e.clientY;
});
canvas.addEventListener('pointerup', () => { lookTouch = null; });
const holdBtn = (id, code) => {
  const b = $(id);
  b.addEventListener('pointerdown', () => keys.add(code));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => keys.delete(code)));
};
holdBtn('up-btn', 'KeyE'); holdBtn('down-btn', 'KeyQ');

// ---------- camera flights ----------
let flight = null;
function flyTo(v) {
  const toPos = new THREE.Vector3(...v.position), toTgt = new THREE.Vector3(...v.target);
  const fromTgt = mode === 'orbit' ? orbit.target.clone() : camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()));
  if (mode !== 'orbit') setMode('orbit');
  const dist = camera.position.distanceTo(toPos);
  flight = { t: 0, dur: THREE.MathUtils.clamp(dist / 40, 1.0, 2.6), fromPos: camera.position.clone(), toPos, fromTgt, toTgt,
    fromFov: camera.fov, toFov: v.fov || 50, arc: v.interior ? Math.min(dist * 0.15, 25) : Math.min(dist * 0.25, 40) };
  hudRoom.textContent = v.label;
  document.querySelectorAll('.room').forEach((b) => b.classList.toggle('active', b.dataset.id === v.id));
  $('sidebar').classList.remove('open');
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function stepFlight(dt) {
  if (!flight) return;
  flight.t = Math.min(1, flight.t + dt / flight.dur);
  const k = ease(flight.t);
  camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
  camera.position.y += Math.sin(Math.PI * k) * flight.arc * (flight.toPos.y < 12 && flight.fromPos.y < 12 && flight.arc < 6 ? 0 : 1);
  orbit.target.lerpVectors(flight.fromTgt, flight.toTgt, k);
  camera.fov = THREE.MathUtils.lerp(flight.fromFov, flight.toFov, k);
  camera.updateProjectionMatrix();
  if (flight.t >= 1) {
    // keep a short orbit radius so orbiting inside a room stays inside it
    const d = new THREE.Vector3().subVectors(flight.toTgt, flight.toPos);
    if (d.length() > 3 && flight.toPos.y < 12) orbit.target.copy(flight.toPos).addScaledVector(d.normalize(), 2.5);
    flight = null;
  }
}

// ---------- first person movement ----------
const EYE = 1.65, RADIUS = 0.3, STEP = 0.55;
const tmpV = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
function groundAt(pos) {
  ray.set(tmpV.set(pos.x, pos.y - EYE + STEP + 0.05, pos.z), down);
  ray.far = 60;
  const h = ray.intersectObjects(colliders, false)[0];
  return h ? h.point.y : null;
}
function blocked(from, dir, dist) {
  for (const hgt of [-0.9, -0.3, 0.1]) {
    ray.set(tmpV.set(from.x, from.y + hgt, from.z), dir);
    ray.far = dist + RADIUS;
    if (ray.intersectObjects(colliders, false).length) return true;
  }
  return false;
}
function stepFirstPerson(dt) {
  camera.quaternion.setFromEuler(new THREE.Euler(yawPitch.pitch, yawPitch.yaw, 0, 'YXZ'));
  const fwd = new THREE.Vector3(-Math.sin(yawPitch.yaw), 0, -Math.cos(yawPitch.yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const mv = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) mv.add(fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) mv.sub(fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) mv.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mv.sub(right);
  if (joy.id !== null) mv.addScaledVector(fwd, -joy.y).addScaledVector(right, joy.x);
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1;
  if (mode === 'fly') {
    const speed = 12 * speedMul * sprint;
    if (mv.lengthSq()) {
      const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
      const m3 = mv.clone(); // move along view direction for forward/back
      const f = m3.dot(fwd), r = m3.dot(right);
      camera.position.addScaledVector(dir, f * speed * dt).addScaledVector(right, r * speed * dt);
    }
    if (keys.has('KeyE') || keys.has('Space')) camera.position.y += speed * dt;
    if (keys.has('KeyQ') || keys.has('KeyC')) camera.position.y -= speed * dt;
    return;
  }
  // walk
  const speed = 2.2 * speedMul * sprint;
  if (mv.lengthSq()) {
    mv.normalize();
    const dist = speed * dt;
    // slide along walls: try full move, then each axis
    for (const cand of [mv, new THREE.Vector3(mv.x, 0, 0), new THREE.Vector3(0, 0, mv.z)]) {
      if (!cand.lengthSq()) continue;
      const dir = cand.clone().normalize();
      if (!blocked(camera.position, dir, dist)) { camera.position.addScaledVector(dir, dist * cand.length()); break; }
    }
  }
  const g = groundAt(camera.position);
  if (g !== null) {
    const target = g + EYE;
    if (camera.position.y > target + 0.02) { velY -= 9.8 * dt; camera.position.y = Math.max(target, camera.position.y + velY * dt); }
    else { velY = 0; camera.position.y = THREE.MathUtils.lerp(camera.position.y, target, Math.min(1, dt * 12)); }
  }
}

// ---------- forest (cheap instanced trees from the Blender forest layout) ----------
async function buildForest() {
  try {
    const data = await (await fetch(FOREST_URL)).json();
    const firs = data.filter((t) => t[4] === 'fir'), broad = data.filter((t) => t[4] !== 'fir');
    const group = new THREE.Group(); group.name = 'forest';
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
    const firMat = new THREE.MeshStandardMaterial({ color: 0x2c4a2a, roughness: 0.95 });
    const broadMat = new THREE.MeshStandardMaterial({ color: 0x4b6433, roughness: 0.95 });
    const make = (list, geo, mat, h, castShadow) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      const o = new THREE.Object3D();
      const c = new THREE.Color();
      list.forEach((t, i) => {
        o.position.set(t[0], t[1], t[2]); o.scale.setScalar(t[3] || 1); o.rotation.y = (i * 2.399) % 6.283; o.updateMatrix(); m.setMatrixAt(i, o.matrix);
        const r = Math.sin(i * 12.9898) * 43758.5453; const f = 0.8 + 0.4 * (r - Math.floor(r));
        m.setColorAt(i, c.setScalar(f));
      });
      m.castShadow = castShadow; m.receiveShadow = false; group.add(m);
    };
    const firGeo = mergeGeometries([
      new THREE.ConeGeometry(3.2, 8, 8).translate(0, 7, 0),
      new THREE.ConeGeometry(2.5, 7, 8).translate(0, 11.5, 0),
      new THREE.ConeGeometry(1.6, 6, 8).translate(0, 16, 0)]);
    const broadGeo = mergeGeometries([
      new THREE.IcosahedronGeometry(3.2, 1).translate(0, 8, 0),
      new THREE.IcosahedronGeometry(2.4, 1).translate(1.8, 9.5, 0.6),
      new THREE.IcosahedronGeometry(2.2, 1).translate(-1.6, 9.8, -0.8),
      new THREE.IcosahedronGeometry(2.0, 1).translate(0.2, 11.2, 0.4)]);
    const trunk = new THREE.CylinderGeometry(0.25, 0.4, 5, 5).translate(0, 2.5, 0);
    make(firs, firGeo, firMat, 16, false); make(broad, broadGeo, broadMat, 10, false); make(data, trunk, trunkMat, 5, false);
    scene.add(group);
    $('trees').addEventListener('change', (e) => { group.visible = e.target.checked; });
  } catch (err) { console.warn('forest skipped', err); }
}

// ---------- load ----------
let views = [];
async function init() {
  try { views = (await (await fetch(VIEWS_URL)).json()).viewpoints; } catch (e) { console.warn('no viewpoints', e); }
  const roomsEl = $('rooms');
  let group = null;
  for (const v of views) {
    if (v.group !== group) { group = v.group; const h = document.createElement('h3'); h.textContent = group; roomsEl.appendChild(h); }
    const b = document.createElement('button'); b.className = 'room'; b.textContent = v.label; b.dataset.id = v.id;
    b.addEventListener('click', () => flyTo(v)); roomsEl.appendChild(b);
  }
  if (views[0]) { camera.position.set(...views[0].position); orbit.target.set(...views[0].target); camera.fov = views[0].fov; camera.updateProjectionMatrix(); hudRoom.textContent = views[0].label; }
  hudMode.textContent = MODE_HELP.orbit;

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(MODEL_URL, (gltf) => {
    loadText.textContent = 'Preparing walkthrough...';
    setTimeout(() => finish(gltf), 30);
  }, (e) => {
    const total = e.total || 40e6;
    const p = Math.min(1, e.loaded / total);
    loadBar.style.width = (p * 100).toFixed(1) + '%';
    loadSub.textContent = `${(e.loaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(0)} MB`;
  }, (err) => { loadText.textContent = 'Could not load the model. Try refreshing.'; console.error(err); });
  buildForest();
}

function finish(gltf) {
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    let glassy = false;
    for (const m of mats) {
      if (m.transmission > 0 || (m.transparent && m.opacity < 0.6) || /glass/i.test(m.name)) {
        // cheap glass: skip the transmission pass, keep a light tint and reflections
        glassy = true;
        m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity ?? 1, 0.18);
        m.depthWrite = false; m.roughness = Math.min(m.roughness, 0.08); m.metalness = 0; m.envMapIntensity = 1.5;
      }
      if (m.map) m.map.anisotropy = 4;
    }
    const big = o.geometry.boundingSphere || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere);
    o.castShadow = !glassy && big.radius > 0.4;
    o.receiveShadow = true;
    if (!glassy && !/curtain|towel|plant|leaves|flower|fern|shrub|tree|pillow|mat_|rug/i.test(o.name)) {
      o.geometry.computeBoundsTree();
      colliders.push(o);
    }
  });
  scene.add(root);
  renderer.compile(scene, camera);
  $('loader').classList.add('done');
  setTimeout(() => $('loader').remove(), 800);
}

// ---------- loop ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (flight) stepFlight(dt);
  else if (mode === 'orbit') {
    // WASD pans in orbit mode too, for quick nudges
    orbit.update();
  } else stepFirstPerson(dt);
  if (flight) orbit.update();
  renderer.render(scene, camera);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
init();

// small hook for automated checks: window.dreamHome.jump('kitchen_dining')
window.dreamHome = {
  views: () => views,
  jump(id) { const v = views.find((x) => x.id === id); if (!v) return false; flight = null; setMode('orbit');
    camera.position.set(...v.position); orbit.target.set(...v.target); camera.fov = v.fov; camera.updateProjectionMatrix(); orbit.update(); return true; },
  snapshot() { renderer.render(scene, camera); return canvas.toDataURL('image/jpeg', 0.85); },
  ready: () => !document.getElementById('loader'),
};
