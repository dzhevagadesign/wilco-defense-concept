// Wilco Defense concept: five full-screen steps, the MQ-9 changes pose on each step, leans towards the
// cursor, and its propeller spins up while the scene changes. Desktop layout from Figma; mobile (≤ 767px)
// is a portrait adaptation with its own plane poses.
import * as THREE from 'three';
import { createStage } from './scene.js';

// ---- Tunables ----
// Camera matches the mockups: fitting model keypoints to the five Figma frames gave the lowest error
// at a 25° vertical FOV over the 1920×1200 frame. The frame is scaled to fit the window (same --s as the UI).
const DESIGN_W = 1920;
const DESIGN_H = 1200;
const DESIGN_FOV = 25;

// Plane pose per step in camera space (camera at the origin looking down -Z).
// pos = model centre; rot = rotation vector (axis × angle, rad). All five are fitted to the mockups
// (step 1 to the client's screenshot of the frame, since the Figma frame itself has no plane layer).
const POSES = [
  { pos: [-0.049, -0.976, -19.207], rot: [0.3997, -1.5236, -0.3895] },
  { pos: [2.309, -0.143, -14.84], rot: [-0.3048, 3.659, 0.5761] },
  { pos: [-3.179, -0.207, -14.595], rot: [0.2912, -0.4185, -0.1196] },
  { pos: [2.497, -0.032, -13.734], rot: [-0.2168, -2.335, 0.3774] },
  { pos: [0.012, 0.764, -14.209], rot: [-0.1774, 1.5564, -0.1801] },
];

// Entry on the first screen: the plane starts far away above the top edge, flies nose-first towards the
// viewer while descending (growing in perspective), and levels out into the step-1 pose.
const ENTRY_FROM = { pos: [0, 22, -85], tiltDeg: [-50, 0, 0] }; // tilt is applied on top of the first pose
const ENTRY_DURATION = 3; // s

// Mobile: the UI is drawn in a 390×844 frame scaled to fit the screen (--s), and the camera keeps a fixed
// horizontal FOV across that frame, so the plane fits the width on any phone and stays in scale on tablets. Poses give the screen position of the model centre
// (ndc, -1..1, +y up) and its distance; rotations are the desktop ones, so both layouts tell the same story.
const MOBILE_MAX = 767; // px; portrait screens up to TABLET_MAX also get the mobile layout (same as site.css)
const TABLET_MAX = 1024;
const MOBILE_FRAME_W = 390;
const MOBILE_FRAME_H = 844;
const MOBILE_HFOV = 32; // deg
const POSES_MOBILE = [
  { ndc: [0, 0.02], dist: 15, rot: POSES[0].rot },
  { ndc: [0.04, 0.17], dist: 13, rot: POSES[1].rot },
  { ndc: [0.06, 0.17], dist: 12, rot: POSES[2].rot },
  { ndc: [0.04, 0.17], dist: 12.5, rot: POSES[3].rot },
  { ndc: [0, 0.3], dist: 12, rot: POSES[4].rot },
];
const ENTRY_FROM_MOBILE = { ndc: [0, 1.35], dist: 85, tiltDeg: [-50, 0, 0] };

// Swipe (finger, or mouse drag in the mobile layout): a vertical drag longer than this changes the step.
const SWIPE_MIN = 40; // px

const STEP_DURATION = 1.6; // s, camera move between steps
const STEP_DIP = 1.8; // world units the plane drifts away mid-move, for depth

// Cursor response around the plane's own centre: small enough to keep the pose, big enough to notice.
const HOVER_YAW_DEG = 6;
const HOVER_PITCH_DEG = 4;
const HOVER_SHIFT = 0.18; // world units
const HOVER_TAU = 0.45; // s, smoothing

// Wheel: one step per gesture. Trackpads keep sending inertia events after the move ends,
// so a new step needs a pause in the wheel stream first.
const WHEEL_THRESHOLD = 30; // accumulated deltaY px
const WHEEL_QUIET_MS = 220;

const STEPS = POSES.length;

// ---- Setup ----
const params = new URLSearchParams(location.search);
const root = document.documentElement;
const body = document.body;
const canvas = document.querySelector('.stage');

const stage = createStage({ canvas, transparent: true });
const { renderer, scene } = stage;
const camera = new THREE.PerspectiveCamera(DESIGN_FOV, 1, 0.1, 400);
const rig = new THREE.Group();
scene.add(rig);

// Desktop poses are camera-space positions; mobile ones are screen positions, resolved with the current FOV.
function toPosition({ pos, ndc, dist }) {
  if (pos) return new THREE.Vector3(...pos);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return new THREE.Vector3(ndc[0] * dist * tanV * camera.aspect, ndc[1] * dist * tanV, -dist);
}
const toPose = (p) => {
  const v = new THREE.Vector3(...p.rot);
  const angle = v.length();
  return { pos: toPosition(p), quat: new THREE.Quaternion().setFromAxisAngle(v.normalize(), angle) };
};
const toEntry = (cfg, first) => ({
  pos: toPosition(cfg),
  quat: new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(...cfg.tiltDeg.map(THREE.MathUtils.degToRad)))
    .multiply(first.quat),
});

let poses = [];
let entryPose = null;
let base = null; // current pose before the cursor tilt; created after the first layout
let parked = true; // plane waits at the entry pose until the preloader leaves
let mobileLayout = false;

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const mobile = w <= MOBILE_MAX || (h >= w && w <= TABLET_MAX);
  const s = mobile ? Math.min(w / MOBILE_FRAME_W, h / MOBILE_FRAME_H) : Math.min(w / DESIGN_W, h / DESIGN_H);
  root.style.setProperty('--s', s);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  if (mobile) {
    const tanH = Math.tan(THREE.MathUtils.degToRad(MOBILE_HFOV / 2)) * (w / (MOBILE_FRAME_W * s));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanH / camera.aspect));
  } else {
    // Keep the design frame (1920×1200 × s, centred) at the design FOV; the rest of the window is extra view.
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(DESIGN_FOV / 2)) * (h / (DESIGN_H * s));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHalf));
  }
  camera.updateProjectionMatrix();
  mobileLayout = mobile;

  poses = (mobile ? POSES_MOBILE : POSES).map(toPose);
  entryPose = toEntry(mobile ? ENTRY_FROM_MOBILE : ENTRY_FROM, poses[0]);
  if (!base) return;
  // Re-aim at the poses of the new layout (rotating a phone, resizing across the breakpoint).
  if (parked) { base.pos.copy(entryPose.pos); base.quat.copy(entryPose.quat); }
  else if (move.t < 1) move.to = poses[current];
  else { base.pos.copy(poses[current].pos); base.quat.copy(poses[current].quat); }
}
layout();
window.addEventListener('resize', layout);

// ---- Plane motion ----
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

base = { pos: entryPose.pos.clone(), quat: entryPose.quat.clone() };
const move = { from: null, to: null, t: 1, duration: 1, ease: easeInOutCubic, dip: 0 };

function flyTo(pose, duration, ease, dip = 0) {
  move.from = { pos: base.pos.clone(), quat: base.quat.clone() };
  move.to = pose;
  move.t = 0;
  move.duration = duration;
  move.ease = ease;
  move.dip = dip;
}

function updateMove(dt) {
  if (move.t >= 1) return;
  move.t = Math.min(1, move.t + dt / move.duration);
  const k = move.ease(move.t);
  base.pos.lerpVectors(move.from.pos, move.to.pos, k);
  base.pos.z -= move.dip * Math.sin(Math.PI * k);
  base.quat.slerpQuaternions(move.from.quat, move.to.quat, k);
}

const pointer = { x: 0, y: 0 }; // -1..1, 0 when the cursor is outside the window
const hover = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
});
document.addEventListener('pointerleave', () => { pointer.x = 0; pointer.y = 0; });
// A finger has no hover: let the plane settle back once it lifts.
const releaseTouch = (e) => { if (e.pointerType === 'touch') { pointer.x = 0; pointer.y = 0; } };
window.addEventListener('pointerup', releaseTouch);
window.addEventListener('pointercancel', releaseTouch);

const hoverQuat = new THREE.Quaternion();
const hoverEuler = new THREE.Euler();
function updateRig(dt) {
  const k = 1 - Math.exp(-dt / HOVER_TAU);
  hover.x += (pointer.x - hover.x) * k;
  hover.y += (pointer.y - hover.y) * k;
  hoverEuler.set(
    THREE.MathUtils.degToRad(HOVER_PITCH_DEG) * hover.y,
    THREE.MathUtils.degToRad(HOVER_YAW_DEG) * hover.x,
    0,
  );
  hoverQuat.setFromEuler(hoverEuler);
  rig.quaternion.copy(hoverQuat).multiply(base.quat); // camera-space tilt about the plane's own centre
  rig.position.copy(base.pos);
  rig.position.x += hover.x * HOVER_SHIFT;
  rig.position.y -= hover.y * HOVER_SHIFT;
}

// ---- Steps ----
const slides = [...document.querySelectorAll('.slide')];
const bars = [...document.querySelectorAll('.progress__bars span')];
const counter = document.querySelector('.progress__now');
const overlay = params.has('overlay') ? document.body.appendChild(document.createElement('div')) : null;
if (overlay) overlay.className = 'overlay';

let current = 0;
let uiReady = false; // wheel/keys wait for the UI intro
let busy = false;
let busyTimer = 0;
let modelReady = false;

function renderStepUI(i) {
  body.dataset.step = String(i);
  counter.textContent = String(i + 1).padStart(2, '0');
  bars.forEach((b, j) => b.classList.toggle('is-on', j <= i));
  if (overlay) overlay.style.backgroundImage = `url(${import.meta.env.BASE_URL}design/step${i + 1}.png)`;
}

function goTo(i, { instant = false } = {}) {
  if (i === current || i < 0 || i >= STEPS) return;
  const dir = i > current ? 1 : -1;
  const leaving = slides[current];
  const entering = slides[i];

  // Park the incoming lines on the correct side before they animate in.
  body.style.setProperty('--dir', dir);
  entering.style.transition = 'none';
  entering.querySelectorAll('.ln > span').forEach((s) => { s.style.transition = 'none'; });
  void entering.offsetWidth;
  entering.style.transition = '';
  entering.querySelectorAll('.ln > span').forEach((s) => { s.style.transition = ''; });

  leaving.classList.remove('is-active');
  leaving.classList.add('is-leaving');
  setTimeout(() => leaving.classList.remove('is-leaving'), 1000);
  entering.classList.add('is-active');

  current = i;
  renderStepUI(i);

  if (instant) {
    base.pos.copy(poses[i].pos);
    base.quat.copy(poses[i].quat);
    move.t = 1;
    return;
  }
  flyTo(poses[i], STEP_DURATION, easeInOutCubic, STEP_DIP);
  if (modelReady) stage.boostStart();
  busy = true;
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { busy = false; stage.boostEnd(); }, STEP_DURATION * 1000);
}

const next = () => goTo(current + 1);
const prev = () => goTo(current - 1);

let wheelAcc = 0;
let lastWheel = 0;
let needQuiet = false;
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = performance.now();
  const quiet = now - lastWheel > WHEEL_QUIET_MS;
  lastWheel = now;
  if (busy || !uiReady || menuOpen()) { needQuiet = true; wheelAcc = 0; return; }
  if (needQuiet && !quiet) return; // inertia tail of the gesture that started the last move
  needQuiet = false;
  if (quiet) wheelAcc = 0;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < WHEEL_THRESHOLD) return;
  wheelAcc > 0 ? next() : prev();
  wheelAcc = 0;
  needQuiet = true;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
  if (busy || !uiReady || menuOpen()) return;
  if (['ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
  if (['ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
  if (e.key === 'Home') goTo(0);
  if (e.key === 'End') goTo(STEPS - 1);
});

// Pointer events cover real touch and the mouse in a desktop browser's responsive mode.
let dragY = null;
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' || mobileLayout) dragY = e.clientY;
});
window.addEventListener('pointerup', (e) => {
  if (dragY === null) return;
  const dy = dragY - e.clientY;
  dragY = null;
  if (busy || !uiReady || menuOpen() || Math.abs(dy) < SWIPE_MIN) return;
  dy > 0 ? next() : prev();
});
window.addEventListener('pointercancel', () => { dragY = null; });

const burger = document.querySelector('.burger');
const menuOpen = () => root.classList.contains('menu-open');
function setMenu(open) {
  root.classList.toggle('menu-open', open);
  burger.setAttribute('aria-expanded', String(open));
}
burger.addEventListener('click', () => setMenu(!menuOpen()));
document.querySelectorAll('.mmenu a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
window.addEventListener('resize', () => { if (!mobileLayout) setMenu(false); });

document.querySelector('.cue').addEventListener('click', () => {
  if (busy) return;
  current === STEPS - 1 ? goTo(0) : next();
});

// ---- Intro ----
const startStep = Math.min(Math.max(parseInt(params.get('step'), 10) - 1 || 0, 0), STEPS - 1);
if (startStep) { parked = false; goTo(startStep, { instant: true }); }
renderStepUI(current);

// Preloader: download is 0–85 %, parsing 85–90 %, GPU warm-up 90–100 %. The page intro and the
// entry flight start together as it leaves, so nothing is revealed half-ready.
const MODEL_BYTES = 28476756; // fallback when the server hides Content-Length (e.g. gzip on Pages)
const LOADER_SMOOTH = 0.25; // s, how fast the shown percentage chases the real one
const loader = {
  el: document.querySelector('.loader'),
  fill: document.querySelector('.loader__fill'),
  num: document.querySelector('.loader__num'),
  target: 0,
  shown: 0,
  onFull: null,
};
const setLoad = (v) => { loader.target = Math.max(loader.target, Math.min(v, 1)); };

function updateLoader(dt) {
  if (!loader.el) return;
  loader.shown += (loader.target - loader.shown) * (1 - Math.exp(-dt / LOADER_SMOOTH));
  if (loader.target === 1 && loader.shown > 0.995) loader.shown = 1;
  const pct = Math.round(loader.shown * 100);
  loader.fill.style.transform = `scaleX(${loader.shown})`;
  loader.num.textContent = pct;
  loader.el.setAttribute('aria-valuenow', pct);
  if (loader.shown === 1 && loader.onFull) { loader.onFull(); loader.onFull = null; }
}
const loaderFull = new Promise((r) => { loader.onFull = r; });
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const fontsReady = Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);

rig.visible = false;
const modelLoad = stage.loadModel((e) => {
  const total = e.lengthComputable && e.total >= e.loaded ? e.total : Math.max(MODEL_BYTES, e.loaded);
  setLoad(0.85 * (e.loaded / total));
}).then(async ({ model }) => {
  setLoad(0.9);
  rig.add(model);
  if (startStep) parked = false;
  else {
    base.pos.copy(entryPose.pos); // parked above the frame for the entry flight
    base.quat.copy(entryPose.quat);
  }
  rig.visible = true;
  await nextFrame(); // let the bar paint 90 % before the blocking upload
  // Upload the textures (~590 MB with mips) and compile shaders now; otherwise that multi-second
  // stall lands on the first frames of the entry flight.
  model.traverse((o) => {
    if (o.material) for (const v of Object.values(o.material)) if (v?.isTexture) renderer.initTexture(v);
  });
  await renderer.compileAsync(scene, camera);
  modelReady = true;
  return true;
}).catch((err) => {
  console.error('GLB load failed:', err);
  return false; // reveal the page anyway
});

Promise.all([fontsReady, modelLoad]).then(async ([, ok]) => {
  setLoad(1);
  await loaderFull;
  loader.el.classList.add('is-done');
  setTimeout(() => loader.el.remove(), 1200);
  await new Promise((r) => setTimeout(r, 350)); // content has lifted off; start the page under the fade
  root.classList.remove('is-loading');
  parked = false;
  if (ok && !startStep) { // deep link (?step=N) shows the pose straight away
    flyTo(poses[current], ENTRY_DURATION, easeOutCubic);
    stage.boostStart();
    setTimeout(stage.boostEnd, ENTRY_DURATION * 700);
  }
  setTimeout(() => {
    uiReady = true;
    // Stagger delays are for the intro only; hover states must react immediately.
    document.querySelectorAll('.intro').forEach((el) => el.classList.remove('intro'));
  }, 1600);
});

// ---- Loop ----
let lastTime = null;
renderer.setAnimationLoop((time) => {
  const dt = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, 0.1); // clamp: no jump after a hidden tab
  lastTime = time;
  updateLoader(dt);
  updateMove(dt);
  updateRig(dt);
  stage.update(dt);
  renderer.render(scene, camera);
});

// Tuning from devtools: __site.poses[1].pos.x = 2.5, __site.goTo(2) …
window.__site = { stage, camera, rig, base, goTo, get poses() { return poses; }, get step() { return current; } };
