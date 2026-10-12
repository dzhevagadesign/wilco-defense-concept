// Wilco Defense concept: five full-screen steps, the MQ-9 changes pose on each step, leans towards the
// cursor, and its propeller spins up while the scene changes. Desktop layout from Figma; mobile (≤ 767px)
// is a portrait adaptation with its own plane poses.
import * as THREE from 'three';
import { createStage } from './scene.js';
import { arrow, underline, group, ARROWS } from './doodles.js';

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
const WHEEL_THRESHOLD = 20; // accumulated deltaY px that counts as an intent to move
const WHEEL_NEW_GESTURE_MS = 180; // a pause this long always starts a new gesture
// Input is accepted again this soon after a step; the plane's move (STEP_DURATION) is simply re-aimed if the
// next step comes before it lands. The old rule (locked for the whole move, then wait for a pause in the wheel
// stream) made continuous scrolling feel stuck.
const STEP_LOCK = 0.8; // s

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
let boostTimer = 0; // propeller boost lasts while the plane flies to the step
let lockedUntil = 0; // navigation input ignored until then
const locked = () => performance.now() < lockedUntil;
let modelReady = false;

function renderStepUI(i) {
  body.dataset.step = String(i);
  counter.textContent = String(i + 1).padStart(2, '0');
  bars.forEach((b, j) => b.classList.toggle('is-on', j <= i));
  if (overlay) overlay.style.backgroundImage = `url(${import.meta.env.BASE_URL}design/step${i + 1}.png)`;
}

// ---- Brand doodles ----
// Screens 1 and 5 underline the .mark phrase; screens 2–4 draw an arrow from the text to a point on the plane,
// each in a different hand. Desktop arrows leave the text sideways; on mobile they rise from the top of the
// text block. Built from live text rects and the projected target pose, so they fit any window size.
const PLANE_POINTS = { nose: [2.816, -0.083, 0], turret: [1.496, -0.365, 0], wingStbd: [-0.246, -0.071, 6.476] }; // model space
// Desktop arrows follow the client's sketches: `from` is relative to the last text line (left + ax × width + dx,
// bottom + dy), `to` is an offset from the projected plane point — both in mockup px (× --s).
// Mobile arrows rise from the top of the text block (x = fraction of its width); `to` offsets the plane point and
// `approach` sets the direction they arrive in (deg, 0 = right, -90 = up), so the head points at the plane.
const DOODLES = [
  { underline: 'single' },
  {
    arrow: 'dip', target: 'nose', from: { ax: 0.9, dy: 33 }, to: [-95, 47],
    mobile: { arrow: 'wave', target: 'turret', x: 0.3, flip: true, to: [-4, 24], approach: -62 },
  },
  {
    arrow: 'under', target: 'nose', from: { ax: 0, dx: 23, dy: 18 }, to: [-41, 65],
    mobile: { arrow: 'sweep', target: 'turret', x: 0.62, to: [2, 24], approach: -72 },
  },
  {
    arrow: 'loopDown', target: 'wingStbd', from: { ax: 0.56, dy: 52 }, to: [-16, 66],
    // Wing tip, as on desktop: the wing lies between the text and the turret, so the turret can't be reached cleanly.
    mobile: { arrow: 'loop', target: 'wingStbd', x: 0.12, to: [-2, 16], approach: -58 },
  },
  { underline: 'double' },
];
const DOODLE_DELAY = 0.55; // s after a screen change: right as its text starts to rise

const doodleLayer = document.querySelector('.doodles');
let doodleGroup = null;
let doodleTimer = 0;
let revealed = false; // text is laid out for real (preloader gone)

// Text rects as they will be once the reveal finishes: undo the line lift (desktop: inner line span inside
// its .ln mask; mobile: the whole slide), so doodles can be built while the text is still rising.
function settledRect(node) {
  const r = node.getBoundingClientRect();
  let dy = 0;
  const line = node.closest('.ln');
  const span = line?.firstElementChild;
  if (span && getComputedStyle(span).display !== 'inline') {
    dy += span.getBoundingClientRect().top - line.getBoundingClientRect().top;
  }
  if (mobileLayout) dy += new DOMMatrixReadOnly(getComputedStyle(node.closest('.slide')).transform).m42;
  return { left: r.left, right: r.right, width: r.width, height: r.height, top: r.top - dy, bottom: r.bottom - dy };
}

function projectOnPlane(step, name) {
  const p = poses[step];
  const v = new THREE.Vector3(...PLANE_POINTS[name]).applyQuaternion(p.quat).add(p.pos).project(camera);
  return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
}

function clearDoodles() {
  clearTimeout(doodleTimer);
  if (!doodleGroup) return;
  const old = doodleGroup;
  doodleGroup = null;
  old.classList.add('is-gone');
  setTimeout(() => old.remove(), 400);
}

function drawDoodles(step, { animate = true } = {}) {
  clearDoodles();
  const cfg = DOODLES[step];
  const slide = slides[step];
  const s = parseFloat(root.style.getPropertyValue('--s')) || 1;
  const g = group('screen');

  if (cfg.underline) {
    const mark = slide.querySelector('.mark');
    const first = mark.getClientRects()[0]; // first line if the phrase wraps (mobile)
    const box = settledRect(mark);
    const r = { left: first.left, right: first.right, height: first.height, bottom: box.top + (first.bottom - mark.getBoundingClientRect().top) };
    const fs = parseFloat(getComputedStyle(mark).fontSize);
    const w = Math.max(fs * 0.085, 3.2);
    const y = r.bottom - r.height * 0.14;
    g.append(underline(r.left - fs * 0.04, r.right + fs * 0.03, y, { width: w, seed: step + 3, rise: fs * 0.04 }));
    if (cfg.underline === 'double') {
      g.append(underline(r.left + r.width * 0.07, r.right - r.width * 0.14, y + w * 2.7, {
        width: w * 0.85, seed: step + 11, delay: 0.2, rise: -fs * 0.02,
      }));
    }
  } else {
    const a = mobileLayout ? cfg.mobile : cfg;
    const target = projectOnPlane(step, a.target);
    let start, end;
    if (mobileLayout) {
      const r = settledRect(slide);
      start = [r.left + r.width * a.x, r.top - 16 * s];
      end = [target[0] + a.to[0] * s, target[1] + a.to[1] * s];
    } else {
      const lines = slide.querySelectorAll('.ln > span');
      const r = settledRect(lines[lines.length - 1]);
      start = [r.left + r.width * a.from.ax + (a.from.dx || 0) * s, r.bottom + a.from.dy * s];
      end = [target[0] + a.to[0] * s, target[1] + a.to[1] * s];
    }
    g.append(arrow(ARROWS[a.arrow], start, end, {
      width: (mobileLayout ? 4 : 7) * s, head: (mobileLayout ? 15 : 26) * s, seed: step * 13, flip: !!a.flip,
      approach: a.approach ?? null,
    }));
  }

  doodleLayer.append(g);
  doodleGroup = g;
  if (!animate) { g.classList.add('no-anim', 'is-drawn'); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add('is-drawn')));
}

function scheduleDoodles(step, delaySec) {
  clearTimeout(doodleTimer);
  doodleTimer = setTimeout(() => drawDoodles(step), delaySec * 1000);
}

// Rebuild in place on resize (rects and the projection change); no redraw animation.
window.addEventListener('resize', () => { if (doodleGroup) drawDoodles(current, { animate: false }); });

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
  clearDoodles();
  // Arrows aim at the target pose, so they can draw while the plane is still settling in.
  if (revealed) scheduleDoodles(i, DOODLE_DELAY);

  if (instant) {
    base.pos.copy(poses[i].pos);
    base.quat.copy(poses[i].quat);
    move.t = 1;
    return;
  }
  flyTo(poses[i], STEP_DURATION, easeInOutCubic, STEP_DIP);
  if (modelReady) stage.boostStart();
  lockedUntil = performance.now() + STEP_LOCK * 1000;
  clearTimeout(boostTimer);
  boostTimer = setTimeout(stage.boostEnd, STEP_DURATION * 1000);
}

const next = () => goTo(current + 1);
const prev = () => goTo(current - 1);

// Mouse wheels send discrete notches (±100-ish, or line units): each notch past the lock is a step.
// Trackpads send a stream that ramps up and ends in a long decaying inertia tail: one step per gesture. A new
// gesture is a pause, or the stream jumping up again after it had decayed well below its peak (inertia only
// ever slows down, while the ramp-up at the start of a flick rises from the previous value, not from a lull).
let wheelAcc = 0;
let lastWheel = 0;
let gestureUsed = false;
let gesturePeak = 0;
let prevAbs = 0;
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = performance.now();
  const d = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
  const abs = Math.abs(d);
  const paused = now - lastWheel > WHEEL_NEW_GESTURE_MS;
  const restarted = abs > prevAbs * 1.5 + 4 && prevAbs < gesturePeak * 0.6;
  if (paused || restarted) { gestureUsed = false; wheelAcc = 0; gesturePeak = 0; }
  gesturePeak = Math.max(gesturePeak, abs);
  prevAbs = abs;
  lastWheel = now;
  if (locked() || !uiReady || menuOpen()) return;

  const notch = e.deltaMode !== 0 || (abs >= 50 && Number.isInteger(d));
  if (!notch && gestureUsed) return; // trackpad inertia of a gesture that already moved
  wheelAcc += d;
  if (Math.abs(wheelAcc) < WHEEL_THRESHOLD && !notch) return;
  (notch ? d : wheelAcc) > 0 ? next() : prev();
  wheelAcc = 0;
  gestureUsed = true;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
  if (locked() || !uiReady || menuOpen()) return;
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
  if (locked() || !uiReady || menuOpen() || Math.abs(dy) < SWIPE_MIN) return;
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
  if (locked()) return;
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
  revealed = true;
  scheduleDoodles(current, DOODLE_DELAY);
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
