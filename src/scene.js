// Shared render core for the site and the viewer: renderer, studio lighting, paint grade, propeller.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ---- Tunables ----
// BASE_URL is '/' in dev and '/wilco-defense-concept/' on GitHub Pages.
export const MODEL_URL = `${import.meta.env.BASE_URL}models/mq-9_reaper.glb`;
const EXPOSURE = 0.9;
const ENV_INTENSITY = 0.7; // studio env is fill only; form comes from KEY/RIM. Raised from 0.45 to offset the tint
const ENV_TINT = 0xb4cbf2; // multiplies the studio room: blue fill in shadows and blue in reflections
const ANISOTROPY = 16; // capped by the GPU; sharpens textures on surfaces seen at grazing angles

// Directional lights; position = direction the light comes from (nose +X, up +Y, wingspan Z).
// Blue grading matched to the client's hangar reference: lit tops ≈ sRGB 135/148/169, sides ≈ 103/113/126.
const KEY_LIGHT = { color: 0xf2f5ff, intensity: 1.7, from: [3, 6, 5] }; // upper front-left, cool white
const RIM_LIGHT = { color: 0xa8c4ff, intensity: 1.6, from: [-6, 2, -5] }; // behind-right, blue edge

// Runtime multipliers on the painted grey (GLB stays untouched). They multiply the textures:
// color × baseColor, roughness × ORM.G, metalness × ORM.B. Source paint is ~0.97 rough and ~0.47 metal.
// PAINT_COLOR (linear RGB) is matched to the client reference: cool mid-grey, lit tops ≈ sRGB 140/146/151.
const PAINT_COLOR = [0.24, 0.273, 0.3];
const PAINT_TWEAKS = {
  Body_mat: { color: PAINT_COLOR, roughness: 0.55, metalness: 0.2 },
  Wing_mat: { color: PAINT_COLOR, roughness: 0.55, metalness: 0.2 },
};

// Propeller: always idles, spins up on boostStart, eases back after boostEnd.
// 3 blades → the picture repeats every 120°; keep per-frame turn well under 60° (≈10 rev/s at 60 fps)
// or the prop strobes and looks like it runs backwards.
const PROP_MESHES = ['defaultMaterial_23', 'defaultMaterial_24']; // spinner, blades
const PROP_HUB = [-2.682, 0.0143, 0]; // model-space hub centre (spinner bbox centre; blades sit at 120° around it)
const PROP_AXIS = [1, 0, 0]; // model-space: fuselage axis, nose +X
const PROP_IDLE_RPS = 1.2; // revolutions per second
const PROP_BOOST_RPS = 4.5;
const PROP_SPIN_UP = 0.6; // s, time constant towards boost
const PROP_SPIN_DOWN = 1.4; // s, time constant back to idle
const PROP_BOOST_HOLD = 0.8; // s the boost lingers after boostEnd (a wheel tick starts and ends at once)

// The offline build (`npm run build:offline`) is opened straight from disk, where fetch() can't read files.
// There the GLB ships as model.js, a classic script that sets window.__WILCO_MODEL_B64, parsed from memory.
function loadGltf(onProgress) {
  if (import.meta.env.MODE !== 'offline') return new GLTFLoader().loadAsync(MODEL_URL, onProgress);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'model.js';
    script.onload = () => {
      const bin = atob(window.__WILCO_MODEL_B64);
      window.__WILCO_MODEL_B64 = null; // drop the 38 MB string once decoded
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      onProgress?.({ loaded: bytes.length, total: bytes.length, lengthComputable: true });
      new GLTFLoader().parse(bytes.buffer, '', resolve, reject);
    };
    script.onerror = () => reject(new Error('model.js not found next to index.html'));
    document.head.appendChild(script);
  });
}

export function createStage({ canvas, transparent = false, background = 0x0e0f11 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;

  const scene = new THREE.Scene();
  if (!transparent) scene.background = new THREE.Color(background);
  scene.environmentIntensity = ENV_INTENSITY;

  // Neutral studio room with every surface, light panel and light inside it multiplied by `tint`.
  function setEnvironment(tint) {
    const room = new RoomEnvironment();
    const c = new THREE.Color(tint);
    room.traverse((o) => {
      if (o.isLight) o.color.multiply(c);
      if (o.material) o.material.color.multiply(c);
    });
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment?.dispose();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    pmrem.dispose();
    room.dispose();
  }
  setEnvironment(ENV_TINT);

  const lights = {};
  for (const [name, cfg] of Object.entries({ key: KEY_LIGHT, rim: RIM_LIGHT })) {
    const light = new THREE.DirectionalLight(cfg.color, cfg.intensity);
    light.position.set(...cfg.from); // target stays at the origin
    scene.add(light);
    lights[name] = light;
  }

  // ---- Propeller ----
  // The GLB pivots every mesh at the model origin, so the prop is re-parented under a pivot at the hub.
  const prop = { pivot: null, axis: new THREE.Vector3(), rps: PROP_IDLE_RPS, pressed: false, holdLeft: 0 };

  function setupPropeller(model) {
    const meshes = PROP_MESHES.map((n) => model.getObjectByName(n)).filter(Boolean);
    if (meshes.length !== PROP_MESHES.length) return console.warn('Propeller meshes not found');
    const parent = meshes[0].parent.parent; // Collada_visual_scene_group, keeps the pivot in model space
    const pivot = new THREE.Group();
    pivot.name = 'propeller_pivot';
    parent.add(pivot);
    // Model is still at the origin with identity transform here, so model space == world space.
    pivot.position.copy(parent.worldToLocal(new THREE.Vector3(...PROP_HUB)));
    pivot.updateMatrixWorld();
    meshes.forEach((m) => pivot.attach(m)); // attach keeps world transforms
    prop.axis.set(...PROP_AXIS).transformDirection(parent.matrixWorld.clone().invert());
    prop.pivot = pivot;
  }

  function updatePropeller(dt) {
    if (!prop.pivot) return;
    prop.holdLeft = Math.max(0, prop.holdLeft - dt); // same clock as the spin, so low fps can't cut the hold short
    const boost = prop.pressed || prop.holdLeft > 0;
    const target = boost ? PROP_BOOST_RPS : PROP_IDLE_RPS;
    const tau = boost ? PROP_SPIN_UP : PROP_SPIN_DOWN;
    prop.rps += (target - prop.rps) * (1 - Math.exp(-dt / tau));
    prop.pivot.rotateOnAxis(prop.axis, prop.rps * Math.PI * 2 * dt);
  }

  const boostStart = () => { prop.pressed = true; };
  const boostEnd = () => { prop.pressed = false; prop.holdLeft = PROP_BOOST_HOLD; };

  function applyAnisotropy(model) {
    const level = Math.min(ANISOTROPY, renderer.capabilities.getMaxAnisotropy());
    model.traverse((o) => {
      if (!o.material) return;
      for (const v of Object.values(o.material)) if (v?.isTexture) v.anisotropy = level;
    });
  }

  function applyPaintTweaks(model) {
    const done = new Set();
    model.traverse((o) => {
      const m = o.material;
      const t = m && PAINT_TWEAKS[m.name];
      if (!t || done.has(m)) return;
      done.add(m);
      m.color.multiply(new THREE.Color().setRGB(...t.color, THREE.LinearSRGBColorSpace));
      m.roughness *= t.roughness;
      m.metalness *= t.metalness;
    });
  }

  // Resolves with the prepared model, not yet added to the scene.
  function loadModel(onProgress) {
    return loadGltf(onProgress).then((gltf) => {
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      applyPaintTweaks(model);
      applyAnisotropy(model);
      setupPropeller(model);
      return { gltf, model };
    });
  }

  return {
    renderer, scene, lights, prop, setEnvironment, loadModel,
    boostStart, boostEnd, update: updatePropeller,
    get materials() {
      const out = {};
      scene.traverse((o) => { if (o.material) out[o.material.name] = o.material; });
      return out;
    },
  };
}
