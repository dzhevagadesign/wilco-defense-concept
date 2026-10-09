import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ---- Tunables ----
const MODEL_URL = '/models/mq-9_reaper.glb';
const BG_COLOR = 0x0e0f11;
const EXPOSURE = 0.9;
const ENV_INTENSITY = 0.45; // studio env is now fill only; form comes from KEY/RIM
const FOV = 35;
const FIT_MARGIN = 1.15; // >1 leaves air around the bounding sphere
const ANISOTROPY = 16; // capped by the GPU; sharpens textures on surfaces seen at grazing angles

// Directional lights; position = direction the light comes from (nose +X, up +Y, wingspan Z).
const KEY_LIGHT = { color: 0xfff4e8, intensity: 1.7, from: [3, 6, 5] }; // upper front-left, slightly warm
const RIM_LIGHT = { color: 0xdde8ff, intensity: 1.4, from: [-6, 2, -5] }; // behind-right, cool edge

// Runtime multipliers on the painted grey (GLB stays untouched). They multiply the textures:
// color × baseColor, roughness × ORM.G, metalness × ORM.B. Source paint is ~0.97 rough and ~0.47 metal.
// PAINT_COLOR (linear RGB) is matched to the client reference: cool mid-grey, lit tops ≈ sRGB 140/146/151.
const PAINT_COLOR = [0.24, 0.273, 0.3];
const PAINT_TWEAKS = {
  Body_mat: { color: PAINT_COLOR, roughness: 0.55, metalness: 0.2 },
  Wing_mat: { color: PAINT_COLOR, roughness: 0.55, metalness: 0.2 },
};

// ---- Renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.body.appendChild(renderer.domElement);

// ---- Scene: solid background, neutral studio environment as fill, key + rim ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = ENV_INTENSITY;
pmrem.dispose();

const lights = {};
for (const [name, cfg] of Object.entries({ key: KEY_LIGHT, rim: RIM_LIGHT })) {
  const light = new THREE.DirectionalLight(cfg.color, cfg.intensity);
  light.position.set(...cfg.from); // target stays at the origin = model centre
  scene.add(light);
  lights[name] = light;
}

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- Load + fit ----
new GLTFLoader().load(MODEL_URL, (gltf) => {
  const model = gltf.scene;
  scene.add(model);
  model.updateMatrixWorld(true);
  applyPaintTweaks(model);
  applyAnisotropy(model);

  const box = new THREE.Box3().setFromObject(model);
  fitCamera(model, box);

  // Log after the first frame so renderer.info reflects real uploads/draws.
  requestAnimationFrame(() => report(gltf, box));
}, undefined, (err) => console.error('GLB load failed:', err));

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

// Live tuning from devtools: __debug.lights.key.intensity = 3, __debug.materials.Body_mat.roughness = 0.4 …
window.__debug = { scene, renderer, camera, lights, get materials() {
  const out = {};
  scene.traverse((o) => { if (o.material) out[o.material.name] = o.material; });
  return out;
} };

const VIEW_DIR = new THREE.Vector3(1, 0.45, 1.25).normalize(); // 3/4 view from the front, slightly above

function fitCamera(model, box) {
  // Distance at which every vertex fits the frustum along VIEW_DIR. A bounding sphere or
  // bbox corners leave the thin, wide drone tiny in a 3/4 view; vertices are exact.
  const center = box.getCenter(new THREE.Vector3());
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanH = tanV * camera.aspect;

  camera.position.copy(center).add(VIEW_DIR);
  camera.lookAt(center);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

  let dist = 0;
  const p = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(center);
      const toward = p.dot(VIEW_DIR); // how far the vertex sticks out towards the camera
      dist = Math.max(dist, Math.abs(p.dot(right)) / tanH + toward, Math.abs(p.dot(up)) / tanV + toward);
    }
  });
  dist *= FIT_MARGIN;

  const radius = box.getSize(p).length() / 2;
  camera.position.copy(center).addScaledVector(VIEW_DIR, dist);
  camera.near = radius / 100;
  camera.far = dist * 4 + radius * 2;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.minDistance = radius * 0.3;
  controls.maxDistance = dist * 4;
  controls.update();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---- Diagnostics (console only) ----
function report(gltf, box) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const f = (v) => v.toFixed(3);

  // 1. Bounding box. glTF units are metres by spec; node transforms are already applied.
  const rootScale = new THREE.Vector3();
  gltf.scene.children[0]?.getWorldScale(rootScale);
  console.log(
    '%c1. BOUNDING BOX', 'font-weight:bold',
    `\n  size  X ${f(size.x)} × Y ${f(size.y)} × Z ${f(size.z)}  (glTF units, nominally metres)` +
    `\n  center ${f(center.x)}, ${f(center.y)}, ${f(center.z)}` +
    `\n  min ${f(box.min.x)}, ${f(box.min.y)}, ${f(box.min.z)}   max ${f(box.max.x)}, ${f(box.max.y)}, ${f(box.max.z)}` +
    `\n  cumulative scale of root node: ${f(rootScale.x)}, ${f(rootScale.y)}, ${f(rootScale.z)}` +
    ` (Sketchfab normalises raw geometry to ±1 and scales the root — the size is not real-world)`
  );

  // 2. Node tree
  const lines = [];
  const walk = (o, depth) => {
    let line = `${'  '.repeat(depth)}${o.name || '(unnamed)'}  [${o.type}]`;
    if (o.isMesh) {
      const g = o.geometry;
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      line += `  tris=${tris}  mat=${mats.map((m) => m.name).join(',')}`;
    }
    lines.push(line);
    o.children.forEach((c) => walk(c, depth + 1));
  };
  walk(gltf.scene, 0);
  console.log('%c2. NODE TREE', 'font-weight:bold', `\n${lines.join('\n')}`);

  // 3. Materials + maps
  const materials = new Map();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!materials.has(m)) materials.set(m, []);
      materials.get(m).push(o.name);
    });
  });
  const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap'];
  const texName = (t) => `${t.image?.width}×${t.image?.height} uv${t.channel}`;
  const matRows = [];
  for (const [m, users] of materials) {
    const row = { name: m.name, type: m.type };
    for (const slot of MAP_SLOTS) if (m[slot]) row[slot] = texName(m[slot]);
    row.metalRough_sameTex = m.metalnessMap && m.metalnessMap === m.roughnessMap;
    row.ao_sharesORM = !!m.aoMap && m.aoMap === m.roughnessMap;
    row.metalness = m.metalness;
    row.roughness = m.roughness;
    row.transparent = m.transparent;
    row.side = m.side === THREE.DoubleSide ? 'double' : 'front';
    row.meshes = users.length;
    matRows.push(row);
  }
  console.log('%c3. MATERIALS', 'font-weight:bold');
  console.table(matRows);

  // AO check: occlusion lives in the R channel of the ORM texture. Sample it to see whether it carries data.
  const aoStats = matRows.map((row) => {
    const m = [...materials.keys()].find((x) => x.name === row.name);
    if (!m.aoMap) return { name: row.name, ao: 'none' };
    const s = channelStats(m.aoMap.image);
    return { name: row.name, ao: 'yes (R of ORM)', R_min: s.r.min, R_mean: s.r.mean, R_max: s.r.max, G_mean: s.g.mean, B_mean: s.b.mean };
  });
  console.log('%c3b. OCCLUSION (aoMap) — R channel stats, 255 = no occlusion', 'font-weight:bold');
  console.table(aoStats);

  // 4. Triangles + texture memory
  let triangles = 0;
  gltf.scene.traverse((o) => {
    if (o.isMesh) triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  const textures = new Set();
  for (const m of materials.keys()) for (const slot of MAP_SLOTS) if (m[slot]) textures.add(m[slot]);
  const images = new Set([...textures].map((t) => t.image));
  let bytes = 0;
  const texRows = [];
  for (const img of images) {
    const b = img.width * img.height * 4 * (4 / 3); // RGBA8 + full mip chain
    bytes += b;
    texRows.push({ size: `${img.width}×${img.height}`, MB: +(b / 2 ** 20).toFixed(1) });
  }
  const MB = (bytes / 2 ** 20).toFixed(1);
  console.log(
    '%c4. TOTALS', 'font-weight:bold',
    `\n  triangles: ${triangles}` +
    `\n  textures: ${textures.size} (unique images: ${images.size})` +
    `\n  GPU texture memory (RGBA8 + mipmaps, uncompressed): ~${MB} MB` +
    `\n  renderer.info: ${JSON.stringify(renderer.info.memory)}  render.triangles: ${renderer.info.render.triangles}`
  );
  console.table(texRows);

  window.__report = { size: size.toArray(), center: center.toArray(), tree: lines, materials: matRows, ao: aoStats, triangles, textures: texRows, textureMB: +MB };
}

function channelStats(image, sample = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = sample;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, sample, sample);
  const d = ctx.getImageData(0, 0, sample, sample).data;
  const acc = { r: [255, 0, 0], g: [255, 0, 0], b: [255, 0, 0] };
  for (let i = 0; i < d.length; i += 4) {
    ['r', 'g', 'b'].forEach((k, j) => {
      const v = d[i + j];
      acc[k][0] = Math.min(acc[k][0], v);
      acc[k][1] = Math.max(acc[k][1], v);
      acc[k][2] += v;
    });
  }
  const n = d.length / 4;
  const out = {};
  for (const k in acc) out[k] = { min: acc[k][0], max: acc[k][1], mean: Math.round(acc[k][2] / n) };
  return out;
}
