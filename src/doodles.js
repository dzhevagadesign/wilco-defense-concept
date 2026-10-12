// Brand doodles: hand-drawn orange marker strokes (underlines and arrows), generated as vector shapes.
// A stroke is a smoothed centreline turned into a filled outline whose width tapers at the ends and
// wobbles slightly, so it reads as a marker rather than a uniform SVG line. Each stroke is revealed by a
// mask that runs along the centreline, which gives the "being drawn" animation.

const NS = 'http://www.w3.org/2000/svg';
export const DOODLE_COLOR = '#f56727'; // Wilco brand orange (--_components---orange on wilco-next.webflow.io)

let uid = 0;

// Deterministic noise so a doodle looks the same every time it is rebuilt (resize, revisit).
function noise(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

// Catmull-Rom through the control points → dense polyline.
function smooth(pts, perSeg = 14) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t
        + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const f = (n) => n.toFixed(1);

// Filled marker outline around a polyline. `taper` = fraction of the length that thins at each end.
function outline(line, width, { seed = 1, taper = [0.12, 0.12], wobble = 0.14 } = {}) {
  const rnd = noise(seed);
  const knots = Array.from({ length: 9 }, () => rnd()); // slow width variation along the stroke
  const n = line.length;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = line[Math.max(i - 1, 0)], b = line[Math.min(i + 1, n - 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const k = t * (knots.length - 1), k0 = Math.floor(k), kf = k - k0;
    const wob = knots[k0] * (1 - kf) + knots[Math.min(k0 + 1, knots.length - 1)] * kf;
    const ends = Math.min(1, t / taper[0], (1 - t) / taper[1]);
    const w = (width / 2) * (0.35 + 0.65 * Math.sqrt(Math.max(ends, 0))) * (1 + wobble * wob);
    left.push([line[i][0] - dy * w, line[i][1] + dx * w]);
    right.push([line[i][0] + dy * w, line[i][1] - dx * w]);
  }
  const pts = left.concat(right.reverse());
  return `M${pts.map((p) => `${f(p[0])},${f(p[1])}`).join('L')}Z`;
}

const polyD = (line) => `M${line.map((p) => `${f(p[0])},${f(p[1])}`).join('L')}`;

function el(name, attrs) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// One revealed stroke: filled outline + a mask whose centreline stroke is animated by CSS
// (.doodle-reveal: dashoffset --gap → 0). Lengths are measured here — dash values set from CSS are px and
// ignore pathLength — and padded by the round cap so nothing peeks out before the reveal starts.
function stroke(group, line, width, opts, { delay = 0, duration = 0.7 } = {}) {
  const id = `dd${++uid}`;
  const mask = el('mask', { id, maskUnits: 'userSpaceOnUse' });
  const cap = width * 1.2 + 1; // radius of the mask stroke's round cap
  let len = 0;
  for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  const reveal = el('path', {
    d: polyD(line), fill: 'none', stroke: '#fff', 'stroke-width': width * 2.4,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'doodle-reveal',
    style: `--dash:${f(len + cap)}px;--gap:${f(len + 2 * cap)}px;transition-delay:${delay}s;transition-duration:${duration}s`,
  });
  mask.append(reveal);
  group.append(mask, el('path', { d: outline(line, width, opts), fill: DOODLE_COLOR, mask: `url(#${id})` }));
  return delay + duration;
}

// Maps a template given in a local frame (x 0→1 from start to end, y sideways as a fraction of the length)
// onto the start→end segment on screen.
function place(template, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  return template.map(([x, y]) => [start[0] + dx * x + nx * y * len, start[1] + dy * x + ny * y * len]);
}

// Three different arrows for screens 2–4, after the client's hand-drawn examples.
export const ARROWS = {
  wave: [[0, 0], [0.1, -0.12], [0.2, -0.13], [0.27, -0.03], [0.34, 0.08], [0.46, 0.09], [0.62, 0.02], [0.82, -0.02], [1, 0]],
  sweep: [[0, 0], [0.3, -0.06], [0.62, -0.07], [0.86, -0.03], [1, 0]],
  loop: [[0, 0], [0.2, 0.04], [0.36, 0.03], [0.47, -0.06], [0.45, -0.17], [0.37, -0.15], [0.36, -0.05], [0.44, 0.03], [0.62, 0.05], [0.82, 0.03], [1, 0]],
};

// Arrow from `start` to `end` (screen px) in the given template; returns the group.
// `flip` mirrors the template across the start→end line (which side the wave or loop bulges to).
export function arrow(template, start, end, { width, head, seed = 7, delay = 0, flip = false }) {
  const g = el('g', {});
  const line = smooth(place(flip ? template.map(([x, y]) => [x, -y]) : template, start, end));
  const t = stroke(g, line, width, { seed, taper: [0.1, 0.04] }, { delay, duration: 0.85 });
  // Open arrowhead: two short strokes meeting at the tip, angled off the last stretch of the line.
  const tip = line[line.length - 1];
  const back = line[Math.max(line.length - 6, 0)];
  const a = Math.atan2(tip[1] - back[1], tip[0] - back[0]);
  [0.5, -0.5].forEach((spread, i) => {
    const ang = a + Math.PI - spread;
    const from = [tip[0] + Math.cos(ang) * head, tip[1] + Math.sin(ang) * head];
    const mid = [(from[0] + tip[0]) / 2 + Math.sin(ang) * head * 0.06, (from[1] + tip[1]) / 2 - Math.cos(ang) * head * 0.06];
    stroke(g, smooth([from, mid, tip], 8), width * 0.95, { seed: seed + 10 + i, taper: [0.2, 0.08] },
      { delay: t - 0.05 + i * 0.08, duration: 0.22 });
  });
  return g;
}

// Marker underline from x0 to x1 at height y; `sag` bows it slightly downwards in the middle.
export function underline(x0, x1, y, { width, seed = 3, delay = 0, rise = 0, sag = 0.012 }) {
  const g = el('g', {});
  const len = x1 - x0;
  const pts = [[x0, y], [x0 + len * 0.3, y + len * sag], [x0 + len * 0.7, y + len * sag * 0.6 - rise / 2], [x1, y - rise]];
  stroke(g, smooth(pts, 18), width, { seed, taper: [0.08, 0.14], wobble: 0.22 }, { delay, duration: 0.6 });
  return g;
}

export function group(cls) {
  return el('g', { class: cls });
}
