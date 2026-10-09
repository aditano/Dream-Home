import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const VIEWS_URL = 'assets/viewpoints.json';
const FOREST_URL = 'assets/forest.json';
const $ = (id) => document.getElementById(id);

function isIOSDevice() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  // iPadOS 13 and later reports a desktop Macintosh user agent.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function tierReasons() {
  const reasons = [];
  if (isIOSDevice()) reasons.push('ios');
  if (matchMedia('(pointer: coarse)').matches) reasons.push('touch');
  if (matchMedia('(max-width: 820px)').matches) reasons.push('small-screen');
  if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4) reasons.push('low-memory');
  return reasons;
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (err) { return null; }
}
function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) { /* private mode has no storage */ }
}

function resolveTier() {
  const param = new URLSearchParams(location.search).get('quality');
  const saved = storageGet('dreamhome-quality');
  let choice = 'auto';
  if (param === 'mobile' || param === 'desktop' || param === 'auto') choice = param;
  else if (saved === 'mobile' || saved === 'desktop') choice = saved;
  const reasons = tierReasons();
  const mobile = choice === 'mobile' || (choice === 'auto' && reasons.length > 0);
  return { choice, mobile, reasons };
}

const tier = resolveTier();
const mobile = tier.mobile;
const MODEL_URL = mobile ? 'assets/dream_house_mobile.glb' : 'assets/dream_house.glb';
const EXPECTED_BYTES = mobile ? 8e6 : 40e6;
const ios = isIOSDevice();
const coarse = matchMedia('(pointer: coarse)').matches;
const touchLook = ios || coarse || mobile || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
// Pointer lock is not implemented on iOS Safari. Walk and fly use drag-to-look there.
const pointerLockOK = !ios && !coarse && !mobile && typeof Element.prototype.requestPointerLock === 'function';

const canvas = $('c');
const MODE_HELP = {
  orbit: touchLook ? 'Orbit: one finger rotates, pinch zooms, two fingers pan' : 'Orbit: drag to rotate, scroll to zoom, right drag to pan',
  walk: touchLook ? 'Walk: joystick to move, drag to look' : 'Walk: click to look, WASD to move, Shift to sprint, Esc to release',
  fly: touchLook ? 'Fly: joystick to move, drag to look, Up/Down buttons' : 'Fly: click to look, WASD to move, E/Space up, Q/C down',
};

function showGfxFallback(message) {
  const box = $('gfx-fallback');
  const msg = $('gfx-msg');
  if (msg && message) msg.textContent = message;
  if (box) box.classList.remove('hidden');
  const loader = $('loader');
  if (loader) loader.classList.add('done');
}

$('gfx-reload').addEventListener('click', () => location.reload());

function createRenderer() {
  try {
    const created = new THREE.WebGLRenderer({
      canvas,
      antialias: !mobile,
      alpha: false,
      stencil: false,
      powerPreference: mobile ? 'default' : 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    if (!created.getContext()) return null;
    return created;
  } catch (err) {
    console.warn('WebGL unavailable', err);
    return null;
  }
}

const renderer = createRenderer();
if (!renderer) {
  showGfxFallback('WebGL did not start on this device. Try a desktop computer for the full walkthrough.');
  window.dreamHome = {
    tier: mobile ? 'mobile' : 'desktop',
    choice: tier.choice,
    reasons: tier.reasons,
    modelUrl: MODEL_URL,
    failed: true,
    views: () => [],
    jump() { return false; },
    snapshot() { return ''; },
    ready: () => false,
    stats: () => null,
  };
} else {
  start(renderer);
}

function pixelRatioCap(sharp) {
  const dpr = window.devicePixelRatio || 1;
  if (mobile) return Math.min(dpr, sharp ? 1.5 : 1.25);
  return Math.min(dpr, sharp ? 2 : 1.25);
}

function start(renderer) {
  renderer.setPixelRatio(pixelRatioCap(false));
  renderer.toneMapping = renderer.capabilities.isWebGL2 ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, mobile ? 0.08 : 0.05, mobile ? 2500 : 4000);
  camera.position.set(15, 6, 54);

  const sky = new Sky();
  sky.scale.setScalar(3500);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(200));
  sky.material.uniforms.turbidity.value = 4;
  sky.material.uniforms.rayleigh.value = 1.4;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.mieDirectionalG.value = 0.8;
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // The procedural sky is the environment. PMREM keeps a float cubemap, which
  // is a common iOS memory spike, so phones use the hemisphere light only.
  if (!mobile) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(50);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) {
      envSky.material.uniforms[k].value = sky.material.uniforms[k].value;
    }
    envSky.material.uniforms.sunPosition.value.copy(sunDir);
    envScene.add(envSky);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(40, 24).rotateX(-Math.PI / 2).translate(0, -2, 0),
      new THREE.MeshBasicMaterial({ color: 0x4d5a3a }),
    );
    envScene.add(ground);
    scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 100).texture;
    scene.environmentIntensity = 0.6;
    pmrem.dispose();
    envSky.geometry.dispose();
    envSky.material.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
  }

  scene.fog = new THREE.Fog(0xc9d3dc, mobile ? 180 : 250, mobile ? 900 : 1600);
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x5b5040, mobile ? 1.5 : 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dc, mobile ? 2.2 : 2.6);
  sun.position.copy(sunDir).multiplyScalar(120).add(new THREE.Vector3(15, 0, 0));
  sun.target.position.set(15, 0, 0);
  const shadowSize = mobile ? 512 : 4096;
  sun.castShadow = !mobile;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 400 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = mobile ? 0.08 : 0.03;
  scene.add(sun, sun.target);
  scene.add(new THREE.AmbientLight(0xfff4e6, mobile ? 0.55 : 0.3));

  function applyShadows(on) {
    const size = mobile ? 512 : 4096;
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    sun.castShadow = on;
    renderer.shadowMap.enabled = on;
  }

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

  const loadBar = $('load-bar');
  const loadText = $('load-text');
  const loadSub = $('load-sub');
  const hudRoom = $('hud-room');
  const hudMode = $('hud-mode');
  const lockHint = $('lock-hint');
  const sidebar = $('sidebar');
  const menuBtn = $('menu-btn');

  if (mobile) loadText.textContent = 'Loading the lighter house...';
  $('quality').value = tier.choice;
  $('tier-note').textContent = mobile ? 'Lighter model for this device.' : 'Full detail model.';
  $('shadows').checked = !mobile;

  function setMenu(open) {
    sidebar.classList.toggle('open', open);
    document.body.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

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
      if (!touchLook) lockHint.classList.remove('hidden');
    } else {
      if (document.pointerLockElement) document.exitPointerLock();
      lockHint.classList.add('hidden');
      const d = new THREE.Vector3();
      camera.getWorldDirection(d);
      orbit.target.copy(camera.position).addScaledVector(d, camera.position.y > 30 ? 40 : 4);
    }
    $('joy').classList.toggle('hidden', !(fp && touchLook));
    $('flybtns').classList.toggle('hidden', !(m === 'fly' && touchLook));
  }

  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('speed').addEventListener('input', (e) => {
    speedMul = +e.target.value;
    $('speed-val').textContent = speedMul.toFixed(2).replace(/0$/, '') + 'x';
  });
  $('shadows').addEventListener('change', (e) => applyShadows(e.target.checked));
  $('hq').addEventListener('change', (e) => {
    renderer.setPixelRatio(pixelRatioCap(e.target.checked));
    resize();
  });
  $('quality').addEventListener('change', () => {
    const value = $('quality').value;
    storageSet('dreamhome-quality', value === 'auto' ? null : value);
    const url = new URL(location.href);
    url.searchParams.delete('quality');
    location.assign(url.pathname + url.search + url.hash);
  });
  menuBtn.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
  $('scrim').addEventListener('click', () => setMenu(false));

  canvas.addEventListener('click', () => {
    if (mode !== 'orbit' && pointerLockOK) canvas.requestPointerLock();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    lockHint.classList.toggle('hidden', locked || mode === 'orbit' || touchLook);
  });
  document.addEventListener('pointerlockerror', () => {
    locked = false;
    lockHint.classList.add('hidden');
  });
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    yawPitch.yaw -= e.movementX * 0.0022;
    yawPitch.pitch = THREE.MathUtils.clamp(yawPitch.pitch - e.movementY * 0.0022, -1.5, 1.5);
  });
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    keys.add(e.code);
    if (e.code === 'Digit1') setMode('orbit');
    if (e.code === 'Digit2') setMode('walk');
    if (e.code === 'Digit3') setMode('fly');
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const joy = { x: 0, y: 0, id: null };
  const joyEl = $('joy');
  const knob = $('joy-knob');
  joyEl.addEventListener('pointerdown', (e) => {
    joy.id = e.pointerId;
    joyEl.setPointerCapture(e.pointerId);
    moveJoy(e);
  });
  joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === joy.id) moveJoy(e); });
  const endJoy = () => { joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
  joyEl.addEventListener('pointerup', endJoy);
  joyEl.addEventListener('pointercancel', endJoy);
  function moveJoy(e) {
    const r = joyEl.getBoundingClientRect();
    let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
    let dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    joy.x = dx;
    joy.y = dy;
    knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
  }
  let lookTouch = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (mode === 'orbit') return;
    if (!touchLook && e.pointerType === 'mouse') return;
    lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!lookTouch || e.pointerId !== lookTouch.id) return;
    yawPitch.yaw += (e.clientX - lookTouch.x) * 0.005;
    yawPitch.pitch = THREE.MathUtils.clamp(yawPitch.pitch + (e.clientY - lookTouch.y) * 0.005, -1.5, 1.5);
    lookTouch.x = e.clientX;
    lookTouch.y = e.clientY;
  });
  const endLook = (e) => { if (!lookTouch || !e || e.pointerId === lookTouch.id) lookTouch = null; };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
  const holdBtn = (id, code) => {
    const b = $(id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); keys.add(code); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => keys.delete(code)));
  };
  holdBtn('up-btn', 'KeyE');
  holdBtn('down-btn', 'KeyQ');

  let flight = null;
  function flyTo(v) {
    const toPos = new THREE.Vector3(...v.position);
    const toTgt = new THREE.Vector3(...v.target);
    const fromTgt = mode === 'orbit'
      ? orbit.target.clone()
      : camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()));
    if (mode !== 'orbit') setMode('orbit');
    const dist = camera.position.distanceTo(toPos);
    flight = {
      t: 0,
      dur: THREE.MathUtils.clamp(dist / 40, 1.0, 2.6),
      fromPos: camera.position.clone(),
      toPos,
      fromTgt,
      toTgt,
      fromFov: camera.fov,
      toFov: v.fov || 50,
      arc: v.interior ? Math.min(dist * 0.15, 25) : Math.min(dist * 0.25, 40),
    };
    hudRoom.textContent = v.label;
    document.querySelectorAll('.room').forEach((b) => b.classList.toggle('active', b.dataset.id === v.id));
    setMenu(false);
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
      const d = new THREE.Vector3().subVectors(flight.toTgt, flight.toPos);
      if (d.length() > 3 && flight.toPos.y < 12) orbit.target.copy(flight.toPos).addScaledVector(d.normalize(), 2.5);
      flight = null;
    }
  }

  const EYE = 1.65;
  const RADIUS = 0.3;
  const STEP = 0.55;
  const tmpV = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
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
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const m3 = mv.clone();
        const f = m3.dot(fwd);
        const r = m3.dot(right);
        camera.position.addScaledVector(dir, f * speed * dt).addScaledVector(right, r * speed * dt);
      }
      if (keys.has('KeyE') || keys.has('Space')) camera.position.y += speed * dt;
      if (keys.has('KeyQ') || keys.has('KeyC')) camera.position.y -= speed * dt;
      return;
    }
    const speed = 2.2 * speedMul * sprint;
    if (mv.lengthSq()) {
      mv.normalize();
      const dist = speed * dt;
      for (const cand of [mv, new THREE.Vector3(mv.x, 0, 0), new THREE.Vector3(0, 0, mv.z)]) {
        if (!cand.lengthSq()) continue;
        const dir = cand.clone().normalize();
        if (!blocked(camera.position, dir, dist)) {
          camera.position.addScaledVector(dir, dist * cand.length());
          break;
        }
      }
    }
    const g = groundAt(camera.position);
    if (g !== null) {
      const target = g + EYE;
      if (camera.position.y > target + 0.02) {
        velY -= 9.8 * dt;
        camera.position.y = Math.max(target, camera.position.y + velY * dt);
      } else {
        velY = 0;
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, target, Math.min(1, dt * 12));
      }
    }
  }

  function thinForest(list) {
    if (!mobile) return list;
    const target = Math.min(650, Math.max(80, Math.round(list.length * 0.06)));
    const step = list.length / target;
    const out = [];
    for (let i = 0; i < target; i++) out.push(list[Math.floor(i * step)]);
    return out;
  }

  async function buildForest() {
    try {
      const raw = await (await fetch(FOREST_URL)).json();
      const data = thinForest(raw);
      const firs = data.filter((t) => t[4] === 'fir');
      const broad = data.filter((t) => t[4] !== 'fir');
      const group = new THREE.Group();
      group.name = 'forest';
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
      const firMat = new THREE.MeshStandardMaterial({ color: 0x2c4a2a, roughness: 0.95 });
      const broadMat = new THREE.MeshStandardMaterial({ color: 0x4b6433, roughness: 0.95 });
      const make = (list, geo, mat) => {
        if (!list.length) return;
        const m = new THREE.InstancedMesh(geo, mat, list.length);
        const o = new THREE.Object3D();
        const c = new THREE.Color();
        list.forEach((t, i) => {
          o.position.set(t[0], t[1], t[2]);
          o.scale.setScalar(t[3] || 1);
          o.rotation.y = (i * 2.399) % 6.283;
          o.updateMatrix();
          m.setMatrixAt(i, o.matrix);
          const r = Math.sin(i * 12.9898) * 43758.5453;
          const f = 0.8 + 0.4 * (r - Math.floor(r));
          m.setColorAt(i, c.setScalar(f));
        });
        m.castShadow = false;
        m.receiveShadow = false;
        group.add(m);
      };
      const firSeg = mobile ? 5 : 8;
      const firParts = [
        new THREE.ConeGeometry(3.2, 8, firSeg).translate(0, 7, 0),
        new THREE.ConeGeometry(2.5, 7, firSeg).translate(0, 11.5, 0),
      ];
      if (!mobile) firParts.push(new THREE.ConeGeometry(1.6, 6, firSeg).translate(0, 16, 0));
      const firGeo = mergeGeometries(firParts);
      firParts.forEach((g) => g.dispose());
      const broadParts = mobile
        ? [new THREE.IcosahedronGeometry(3.4, 0).translate(0, 9, 0)]
        : [
          new THREE.IcosahedronGeometry(3.2, 1).translate(0, 8, 0),
          new THREE.IcosahedronGeometry(2.4, 1).translate(1.8, 9.5, 0.6),
          new THREE.IcosahedronGeometry(2.2, 1).translate(-1.6, 9.8, -0.8),
          new THREE.IcosahedronGeometry(2.0, 1).translate(0.2, 11.2, 0.4),
        ];
      const broadGeo = mergeGeometries(broadParts);
      broadParts.forEach((g) => g.dispose());
      const trunk = new THREE.CylinderGeometry(0.25, 0.4, 5, mobile ? 4 : 5).translate(0, 2.5, 0);
      make(firs, firGeo, firMat);
      make(broad, broadGeo, broadMat);
      make(data, trunk, trunkMat);
      scene.add(group);
      $('trees').addEventListener('change', (e) => { group.visible = e.target.checked; });
    } catch (err) { console.warn('forest skipped', err); }
  }

  let views = [];
  async function init() {
    try {
      views = (await (await fetch(VIEWS_URL)).json()).viewpoints;
    } catch (err) { console.warn('no viewpoints', err); }
    const roomsEl = $('rooms');
    let group = null;
    for (const v of views) {
      if (v.group !== group) {
        group = v.group;
        const h = document.createElement('h3');
        h.textContent = group;
        roomsEl.appendChild(h);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'room';
      b.textContent = v.label;
      b.dataset.id = v.id;
      b.addEventListener('click', () => flyTo(v));
      roomsEl.appendChild(b);
    }
    if (views[0]) {
      camera.position.set(...views[0].position);
      orbit.target.set(...views[0].target);
      camera.fov = views[0].fov;
      camera.updateProjectionMatrix();
      hudRoom.textContent = views[0].label;
    }
    hudMode.textContent = MODE_HELP.orbit;

    let decoderReady = false;
    try {
      await MeshoptDecoder.ready;
      decoderReady = !!MeshoptDecoder.supported;
    } catch (err) {
      console.warn('meshopt decoder failed', err);
    }
    if (!decoderReady) {
      showGfxFallback('This browser could not start the model decoder. Try a desktop computer for the full walkthrough.');
      return;
    }
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(MODEL_URL, (gltf) => {
      loadText.textContent = 'Preparing walkthrough...';
      setTimeout(() => finish(gltf), 30);
    }, (e) => {
      const total = e.total || EXPECTED_BYTES;
      const p = Math.min(1, e.loaded / total);
      loadBar.style.width = (p * 100).toFixed(1) + '%';
      loadSub.textContent = `${(e.loaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(0)} MB`;
    }, (err) => {
      loadText.textContent = 'Could not load the model.';
      loadSub.textContent = 'Check the connection, or try a desktop computer.';
      console.error(err);
    });
    buildForest();
  }

  function releaseParsed(gltf) {
    const parser = gltf.parser;
    if (parser) {
      try { parser.cache?.removeAll?.(); } catch (err) { /* cache shape differs by three version */ }
      parser.json = null;
      gltf.parser = null;
    }
    gltf.cameras = null;
    gltf.animations = null;
    gltf.userData = null;
  }

  function queueColliders(meshes) {
    let index = 0;
    const step = () => {
      const end = Math.min(meshes.length, index + (mobile ? 1 : 4));
      for (; index < end; index++) {
        const mesh = meshes[index];
        if (!mesh.geometry || mesh.geometry.boundsTree) continue;
        mesh.geometry.computeBoundsTree();
        colliders.push(mesh);
      }
      if (index < meshes.length) setTimeout(step, 16);
    };
    setTimeout(step, 40);
  }

  function finish(gltf) {
    const root = gltf.scene;
    const maxAniso = mobile ? 1 : Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const candidates = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let glassy = false;
      for (const m of mats) {
        if (!m) continue;
        if (m.transmission > 0 || (m.transparent && m.opacity < 0.6) || /glass/i.test(m.name || '')) {
          glassy = true;
          m.transmission = 0;
          m.transparent = true;
          m.opacity = Math.min(m.opacity ?? 1, 0.18);
          m.depthWrite = false;
          m.roughness = Math.min(m.roughness, 0.08);
          m.metalness = 0;
          m.envMapIntensity = mobile ? 0 : 1.5;
        }
        if (mobile && m.metalness > 0.2) {
          m.metalness = Math.min(m.metalness, 0.35);
          m.roughness = Math.max(m.roughness, 0.45);
        }
        if (m.map) m.map.anisotropy = maxAniso;
        if (mobile && m.map) {
          m.map.generateMipmaps = true;
        }
      }
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const big = o.geometry.boundingSphere;
      o.castShadow = !mobile && !glassy && big.radius > 0.4;
      o.receiveShadow = !mobile;
      const skip = /curtain|towel|plant|leaves|flower|fern|shrub|tree|pillow|mat_|rug/i.test(o.name || '');
      const minR = mobile ? 2.2 : 0.4;
      if (!glassy && !skip && big.radius > minR) candidates.push(o);
    });
    scene.add(root);
    releaseParsed(gltf);
    candidates.sort((a, b) => b.geometry.boundingSphere.radius - a.geometry.boundingSphere.radius);
    queueColliders(mobile ? candidates.slice(0, 36) : candidates);
    renderer.compile(scene, camera);
    $('loader').classList.add('done');
    setTimeout(() => {
      const loaderEl = $('loader');
      if (loaderEl) loaderEl.remove();
    }, 800);
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  const clock = new THREE.Clock();
  let lostCount = 0;
  let loopOn = true;
  function frame() {
    if (!loopOn) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (flight) stepFlight(dt);
    else if (mode === 'orbit') orbit.update();
    else stepFirstPerson(dt);
    if (flight) orbit.update();
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    lostCount += 1;
    loopOn = false;
    renderer.setAnimationLoop(null);
    const again = lostCount >= 2;
    showGfxFallback(again
      ? 'Graphics reset more than once, so the walkthrough stopped. Try a desktop computer for the full model.'
      : 'The graphics context was lost. Reload to try again, or open this page on a desktop computer.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (lostCount >= 2) return;
    loopOn = true;
    renderer.setAnimationLoop(frame);
    const box = $('gfx-fallback');
    if (box) box.classList.add('hidden');
  });
  addEventListener('resize', resize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  resize();

  function textureGPUBytes(texture) {
    if (!texture || !texture.isTexture || texturesSeen.has(texture.uuid)) return 0;
    texturesSeen.add(texture.uuid);
    const image = texture.image;
    const w = image && image.width ? image.width : 0;
    const h = image && image.height ? image.height : 0;
    if (!w || !h) return 0;
    const mip = texture.generateMipmaps !== false
      && texture.minFilter !== THREE.LinearFilter
      && texture.minFilter !== THREE.NearestFilter;
    return Math.round(w * h * 4 * (mip ? 4 / 3 : 1));
  }
  const texturesSeen = new Set();
  function stats() {
    let triangles = 0;
    let meshes = 0;
    let textureBytes = 0;
    texturesSeen.clear();
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.attributes && o.geometry.attributes.position;
      if (!pos) return;
      const tris = o.geometry.index ? o.geometry.index.count / 3 : pos.count / 3;
      const copies = o.isInstancedMesh ? o.count : 1;
      triangles += tris * copies;
      meshes += 1;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'lightMap']) {
          textureBytes += textureGPUBytes(m[key]);
        }
      }
    });
    const memory = performance && performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
    } : null;
    return {
      tier: mobile ? 'mobile' : 'desktop',
      choice: tier.choice,
      reasons: tier.reasons,
      modelUrl: MODEL_URL,
      triangles: Math.round(triangles),
      meshes,
      textureCount: texturesSeen.size,
      textureBytes,
      dpr: renderer.getPixelRatio(),
      shadows: renderer.shadowMap.enabled,
      antialias: !mobile,
      heap: memory,
    };
  }

  window.dreamHome = {
    tier: mobile ? 'mobile' : 'desktop',
    choice: tier.choice,
    reasons: tier.reasons,
    modelUrl: MODEL_URL,
    failed: false,
    views: () => views,
    jump(id) {
      const v = views.find((x) => x.id === id);
      if (!v) return false;
      flight = null;
      setMode('orbit');
      camera.position.set(...v.position);
      orbit.target.set(...v.target);
      camera.fov = v.fov;
      camera.updateProjectionMatrix();
      orbit.update();
      hudRoom.textContent = v.label;
      renderer.render(scene, camera);
      return true;
    },
    snapshot() {
      renderer.render(scene, camera);
      return canvas.toDataURL('image/jpeg', 0.7);
    },
    ready: () => !document.getElementById('loader'),
    pause() {
      loopOn = false;
      renderer.setAnimationLoop(null);
    },
    resume() {
      loopOn = true;
      renderer.setAnimationLoop(frame);
    },
    stats,
  };

  init();
}
