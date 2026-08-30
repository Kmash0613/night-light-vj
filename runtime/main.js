// Phase 1: 光点明滅の最小構成
// 写真1枚 + 手作業マスク(points.json) + カメラ固定。
// MIDI Note On で対応クラスタの光点が加算合成・指数減衰で明滅し、
// 光点レイヤーのみにブルームがかかる（背景はブルームしない）。
// 要件定義書 §5, §9 Phase 1 に対応。

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const CLUSTER_COLORS = [0xffb74d, 0xff7a59, 0x6fb7e0, 0xc792ea, 0x6fcf97, 0xff8fc7, 0xf2c94c, 0x4dd0c4];
const MAX_CLUSTERS = 8;
const BLOOM_LAYER = 1;
const MAX_BLOOM_STRENGTH = 3;

const els = {
  photoInput: document.getElementById('photo-input'),
  pointsInput: document.getElementById('points-input'),
  sampleBtn: document.getElementById('sample-btn'),
  select: document.getElementById('input-select'),
  refresh: document.getElementById('refresh-btn'),
  status: document.getElementById('status'),
  statusDot: document.getElementById('status-dot'),
  meters: document.getElementById('meters'),
  extractTopPercent: document.getElementById('extract-top-percent'),
  extractMinArea: document.getElementById('extract-min-area'),
  extractMaxPoints: document.getElementById('extract-max-points'),
  extractClusterCount: document.getElementById('extract-cluster-count'),
  extractTopPercentVal: document.getElementById('extract-top-percent-val'),
  extractMinAreaVal: document.getElementById('extract-min-area-val'),
  extractMaxPointsVal: document.getElementById('extract-max-points-val'),
  extractBtn: document.getElementById('extract-btn'),
  exportPointsBtn: document.getElementById('export-points-btn'),
  pointSize: document.getElementById('point-size'),
  pointSizeVal: document.getElementById('point-size-val'),
  ambient: document.getElementById('ambient'),
  ambientVal: document.getElementById('ambient-val'),
  bgSway: document.getElementById('bg-sway'),
  bgSwayVal: document.getElementById('bg-sway-val'),
  strength: document.getElementById('strength'),
  strengthVal: document.getElementById('strength-val'),
  radius: document.getElementById('radius'),
  radiusVal: document.getElementById('radius-val'),
  threshold: document.getElementById('threshold'),
  thresholdVal: document.getElementById('threshold-val'),
  ccBloomToggle: document.getElementById('cc-bloom-toggle'),
  viewport: document.getElementById('viewport'),
  viewportEmpty: document.getElementById('viewport-empty'),
};

function showToast(text, kind) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast show ${kind || ''}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ============================================================
// Mapping config
// ============================================================

let mapping = { notes: [], control_changes: [] };
let noteEnvelopes = []; // parallel to mapping.notes: {value, start}
const clusterEnvelopes = new Float32Array(MAX_CLUSTERS);

async function loadMapping() {
  try {
    const res = await fetch('../config/midi-mapping.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mapping = await res.json();
    noteEnvelopes = mapping.notes.map(() => ({ value: 0, start: 0 }));
    buildMeters();
  } catch (err) {
    showToast('config/midi-mapping.json を読み込めませんでした。file:// では動かないので http(s) 経由で開いてください。', 'error');
    console.error(err);
  }
}

function usedClusters() {
  const set = new Set();
  for (const n of mapping.notes) {
    if (n.role === 'cluster_trigger' && n.cluster != null) set.add(n.cluster);
  }
  return [...set].sort((a, b) => a - b);
}

// ============================================================
// Cluster envelope meters (UI)
// ============================================================

const meterFills = new Map();

function buildMeters() {
  els.meters.innerHTML = '';
  const clusters = usedClusters();
  if (clusters.length === 0) {
    els.meters.innerHTML = '<p class="hint">config/midi-mapping.json に cluster_trigger のマッピングがありません。</p>';
    return;
  }
  clusters.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'meter-row';
    const color = `#${CLUSTER_COLORS[c % CLUSTER_COLORS.length].toString(16).padStart(6, '0')}`;
    row.innerHTML = `
      <span class="dot" style="background:${color}"></span>
      <span>c${c}</span>
      <span class="track"><span class="fill" style="background:${color}"></span></span>
      <span class="val">0.00</span>
    `;
    els.meters.appendChild(row);
    meterFills.set(c, { fill: row.querySelector('.fill'), val: row.querySelector('.val') });
  });
}

function updateMeters() {
  for (const [c, { fill, val }] of meterFills) {
    const v = clusterEnvelopes[c] || 0;
    fill.style.width = `${Math.min(100, v * 100).toFixed(1)}%`;
    val.textContent = v.toFixed(2);
  }
}

// ============================================================
// Three.js scene
// ============================================================

let renderer, camera, scene, bgMesh, pointsObj;
let bloomComposer, finalComposer, bloomPass;
let currentAspect = 16 / 9;
let pointSizeUniformValue = 34;
let ambientAmountUniformValue = 0.35;

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // NoToneMapping: each material's shader (background photo included) already applies
  // tone mapping in-shader when `toneMapped !== false`; adding a filmic curve here on
  // top of that (e.g. via OutputPass) double-applies it and flattens/desaturates the
  // photo. Keep raw output and let UnrealBloomPass supply the glow instead.
  renderer.toneMapping = THREE.NoToneMapping;
  els.viewport.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;

  const renderScene = new RenderPass(scene, camera);

  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.6, 0.45, 0.12);

  bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(renderScene);
  bloomComposer.addPass(bloomPass);

  const mixPass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv);
        }
      `,
    }),
    'baseTexture'
  );
  mixPass.needsSwap = true;

  finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(renderScene);
  finalComposer.addPass(mixPass);
  finalComposer.addPass(new OutputPass());

  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  const w = els.viewport.clientWidth || 1;
  const h = els.viewport.clientHeight || 1;
  renderer.setSize(w, h);
  bloomComposer.setSize(w, h);
  finalComposer.setSize(w, h);

  const viewportAspect = w / h;
  // "contain" fit: frame the photo's own aspect inside the viewport aspect.
  if (viewportAspect > currentAspect) {
    camera.top = 1;
    camera.bottom = -1;
    camera.left = -viewportAspect / currentAspect;
    camera.right = viewportAspect / currentAspect;
  } else {
    camera.left = -1;
    camera.right = 1;
    camera.top = currentAspect / viewportAspect;
    camera.bottom = -currentAspect / viewportAspect;
  }
  camera.updateProjectionMatrix();
}

// --- Darken-non-bloomed selective bloom (three.js standard technique) ---

const bloomLayer = new THREE.Layers();
bloomLayer.set(BLOOM_LAYER);
const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
const savedMaterials = new Map();

function darkenNonBloomed(obj) {
  if ((obj.isMesh || obj.isPoints) && !bloomLayer.test(obj.layers)) {
    savedMaterials.set(obj.uuid, obj.material);
    obj.material = darkMaterial;
  }
}
function restoreMaterial(obj) {
  if (savedMaterials.has(obj.uuid)) {
    obj.material = savedMaterials.get(obj.uuid);
    savedMaterials.delete(obj.uuid);
  }
}

function render() {
  scene.traverse(darkenNonBloomed);
  bloomComposer.render();
  scene.traverse(restoreMaterial);
  finalComposer.render();
}

// ============================================================
// Scene content: background photo + light points
// ============================================================

// 元の写真自体の輝度も、明るい部分（ネオン等）ほど強くゆっくり揺らす。
// 揺らぎの位相はUV座標のハッシュから作るので、画面上の場所ごとにバラバラに
// 明滅して見える（サインが個別にちらつくような効果）。
const bgVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const bgFragmentShader = `
  precision mediump float;
  uniform sampler2D map;
  uniform float time;
  uniform float swayAmount;
  varying vec2 vUv;
  vec3 srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
  void main() {
    vec4 tex = texture2D(map, vUv);
    vec3 color = srgbToLinear(tex.rgb);
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float ph = fract(sin(dot(floor(vUv * 90.0), vec2(12.9898, 78.233))) * 43758.5453);
    float sway = 1.0 + swayAmount * luma * sin(time * (0.3 + 0.3 * ph) + ph * 6.2831);
    gl_FragColor = vec4(color * sway, tex.a);
  }
`;

let bgSwayAmountUniformValue = 0.3;

function setBackground(source, width, height) {
  if (bgMesh) {
    scene.remove(bgMesh);
    bgMesh.geometry.dispose();
    bgMesh.material.uniforms.map.value?.dispose();
    bgMesh.material.dispose();
  }
  currentAspect = width / height;
  const texture = new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(currentAspect * 2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      time: { value: 0 },
      swayAmount: { value: bgSwayAmountUniformValue },
    },
    vertexShader: bgVertexShader,
    fragmentShader: bgFragmentShader,
  });
  bgMesh = new THREE.Mesh(geometry, material);
  bgMesh.position.z = 0;
  scene.add(bgMesh);
  resize();
}

// 「呼吸する街」: MIDIが鳴っていない間も光点がゼロにならないよう、
// クラスタごとのMIDIエンベロープに、点ごとに位相をずらしたゆっくりした
// アンビエントの明滅を加算する。MIDIノートはその上に重なる形で明るく光る。
const pointVertexShader = `
  attribute float cluster;
  attribute vec3 pointColor;
  attribute float phase;
  attribute float sizeScale;
  uniform float envelopes[${MAX_CLUSTERS}];
  uniform float basePointSize;
  uniform float pixelRatio;
  uniform float time;
  uniform float ambientAmount;
  varying vec3 vColor;
  varying float vEnv;
  void main() {
    int idx = int(cluster);
    float midiEnv = envelopes[idx];
    float ambient = ambientAmount * (0.5 + 0.5 * sin(time * (0.5 + 0.15 * sin(phase)) + phase * 6.2831));
    float env = clamp(midiEnv + ambient, 0.0, 1.5);
    vEnv = env;
    vColor = pointColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = basePointSize * pixelRatio * sizeScale * (0.5 + 0.9 * env);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const pointFragmentShader = `
  precision mediump float;
  varying vec3 vColor;
  varying float vEnv;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv) * 2.0; // 0 at center, 1 at edge
    float halo = pow(max(0.0, 1.0 - d), 2.2);
    float core = pow(max(0.0, 1.0 - d * 1.6), 6.0);
    float shape = halo * 0.6 + core;
    float alpha = shape * vEnv;
    if (alpha < 0.004) discard;
    vec3 hot = mix(vColor, vec3(1.0), core * 0.6); // bright core flashes toward white-hot
    gl_FragColor = vec4(hot * (0.7 + 1.8 * vEnv), alpha);
  }
`;

function setPoints(points) {
  if (pointsObj) {
    scene.remove(pointsObj);
    pointsObj.geometry.dispose();
    pointsObj.material.dispose();
  }
  const n = points.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const clusters = new Float32Array(n);
  const phases = new Float32Array(n);
  const sizeScales = new Float32Array(n);

  points.forEach((p, i) => {
    positions[i * 3 + 0] = (p.x - 0.5) * currentAspect * 2;
    positions[i * 3 + 1] = (0.5 - p.y) * 2;
    positions[i * 3 + 2] = 0.01;
    const c = p.color || [255, 220, 160];
    colors[i * 3 + 0] = c[0] / 255;
    colors[i * 3 + 1] = c[1] / 255;
    colors[i * 3 + 2] = c[2] / 255;
    clusters[i] = Math.min(MAX_CLUSTERS - 1, Math.max(0, p.cluster || 0));
    phases[i] = Math.random(); // 0-1, used as a per-point phase offset for ambient breathing
    sizeScales[i] = p.sizeScale || 1;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('pointColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('cluster', new THREE.BufferAttribute(clusters, 1));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('sizeScale', new THREE.BufferAttribute(sizeScales, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      envelopes: { value: new Float32Array(MAX_CLUSTERS) },
      basePointSize: { value: pointSizeUniformValue },
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      time: { value: 0 },
      ambientAmount: { value: ambientAmountUniformValue },
    },
    vertexShader: pointVertexShader,
    fragmentShader: pointFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  pointsObj = new THREE.Points(geometry, material);
  pointsObj.layers.enable(BLOOM_LAYER); // bloom applies to this layer only
  scene.add(pointsObj);
}

// ============================================================
// Auto point extraction (輝度ベースの自動抽出)
// 要件定義書 §4 の「光点抽出」「クラスタリング」の簡易版をブラウザ内で行う。
// 深度推定はまだ無い(Phase 2)ため、クラスタ分けは画面上のY座標(下ほど手前)と
// 面積を使ったヒューリスティックな代用。
// ============================================================

function extractPointsFromImage(source, naturalW, naturalH, opts) {
  const { topPercent, minArea, maxDim, maxPoints, clusterCount } = opts;
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const n = w * h;
  const luma = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = l;
    hist[Math.round(l)] += 1;
  }

  // Percentile threshold: brightest `topPercent`% of pixels.
  const targetCount = Math.max(1, Math.round((n * topPercent) / 100));
  let cum = 0;
  let threshold = 255;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum >= targetCount) { threshold = v; break; }
  }

  // Connected components (4-connectivity, iterative flood fill) over the threshold mask.
  const visited = new Uint8Array(n);
  const blobs = [];
  const stack = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (visited[start] || luma[start] < threshold) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let sumX = 0, sumY = 0, sumR = 0, sumG = 0, sumB = 0, count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p / w) | 0;
      sumX += px; sumY += py; count++;
      sumR += data[p * 4]; sumG += data[p * 4 + 1]; sumB += data[p * 4 + 2];
      if (px > 0 && !visited[p - 1] && luma[p - 1] >= threshold) { visited[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < w - 1 && !visited[p + 1] && luma[p + 1] >= threshold) { visited[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0 && !visited[p - w] && luma[p - w] >= threshold) { visited[p - w] = 1; stack[sp++] = p - w; }
      if (py < h - 1 && !visited[p + w] && luma[p + w] >= threshold) { visited[p + w] = 1; stack[sp++] = p + w; }
    }
    if (count >= minArea) {
      blobs.push({
        x: sumX / count / w,
        y: sumY / count / h,
        color: [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)],
        area: count,
      });
    }
  }

  // Cap to the most prominent blobs (largest area) to stay within a sane point budget.
  blobs.sort((a, b) => b.area - a.area);
  const capped = blobs.slice(0, maxPoints);

  const maxArea = capped.reduce((m, b) => Math.max(m, b.area), 1);
  for (const b of capped) {
    const areaNorm = Math.log(1 + b.area) / Math.log(1 + maxArea);
    b.sizeScale = 0.6 + 1.4 * areaNorm;
  }

  assignClustersByDepthProxy(capped, clusterCount);
  return capped;
}

function assignClustersByDepthProxy(points, clusterCount) {
  if (points.length === 0) return points;
  const maxArea = points.reduce((m, p) => Math.max(m, p.area || 1), 1);
  const scored = points.map((p) => {
    const areaNorm = Math.log(1 + (p.area || 1)) / Math.log(1 + maxArea);
    // 深度の代わりに「画面下ほど手前」+「面積が大きいほど手前」という前提で並べる。
    // 実際の深度推定はPhase 2で置き換える。
    return { p, depthScore: 0.7 * p.y + 0.3 * areaNorm };
  });
  scored.sort((a, b) => a.depthScore - b.depthScore); // ascending: low = far, high = near
  const total = scored.length;
  scored.forEach((s, i) => {
    const bucket = Math.min(clusterCount - 1, Math.floor((i / total) * clusterCount));
    s.p.cluster = clusterCount - 1 - bucket; // cluster 0 = 最前景 (config/midi-mapping.jsonの規約に合わせる)
  });
  return points;
}

// ============================================================
// Sample scene (procedural placeholder, no photo required)
// ============================================================

function buildSampleScene() {
  const w = 1280, h = 720;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#050810');
  sky.addColorStop(0.6, '#0b1220');
  sky.addColorStop(1, '#161b28');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const points = [];
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff); };

  // Skyline silhouette, three depth bands -> three clusters of light points.
  const bands = [
    { baseY: h * 0.55, count: 7, minH: 120, maxH: 260, color: '#12161f', cluster: 0, dotColor: [255, 183, 77] },
    { baseY: h * 0.62, count: 10, minH: 90, maxH: 190, color: '#171c28', cluster: 2, dotColor: [111, 183, 224] },
    { baseY: h * 0.7, count: 14, minH: 50, maxH: 120, color: '#1c2230', cluster: 3, dotColor: [199, 146, 234] },
  ];

  for (const band of bands) {
    let x = -20;
    ctx.fillStyle = band.color;
    while (x < w + 20) {
      const bw = 40 + rand() * 70;
      const bh = band.minH + rand() * (band.maxH - band.minH);
      ctx.fillRect(x, band.baseY - bh, bw, h - (band.baseY - bh));
      // Window light points on this building.
      const rows = Math.max(2, Math.round(bh / 26));
      const cols = Math.max(2, Math.round(bw / 22));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (rand() > 0.32) continue;
          const px = x + 6 + c * (bw - 12) / Math.max(1, cols - 1);
          const py = band.baseY - bh + 10 + r * (bh - 20) / Math.max(1, rows - 1);
          points.push({
            x: px / w,
            y: py / h,
            color: band.dotColor.map((v) => Math.min(255, Math.round(v + (rand() - 0.5) * 30))),
            cluster: band.cluster,
          });
        }
      }
      x += bw + 6 + rand() * 14;
    }
  }

  // A few large foreground "neon" points (cluster 1).
  for (let i = 0; i < 6; i++) {
    points.push({
      x: 0.1 + rand() * 0.8,
      y: 0.8 + rand() * 0.15,
      color: [255, 122, 89],
      cluster: 1,
    });
  }

  return { canvas, width: w, height: h, points };
}

// ============================================================
// File loading
// ============================================================

let loadedImageEl = null;
let loadedImageW = 0;
let loadedImageH = 0;
let loadedPoints = null;

function tryRenderScene() {
  if (!loadedImageEl) return;
  els.viewportEmpty.hidden = true;
  setBackground(loadedImageEl, loadedImageW, loadedImageH);
  setPoints(loadedPoints || []);
}

function currentExtractOptions() {
  return {
    topPercent: Number(els.extractTopPercent.value),
    minArea: Number(els.extractMinArea.value),
    maxPoints: Number(els.extractMaxPoints.value),
    clusterCount: Number(els.extractClusterCount.value),
    maxDim: 700,
  };
}

function runExtraction({ silent = false } = {}) {
  if (!loadedImageEl) return;
  const opts = currentExtractOptions();
  const t0 = performance.now();
  loadedPoints = extractPointsFromImage(loadedImageEl, loadedImageW, loadedImageH, opts);
  setPoints(loadedPoints);
  const ms = Math.round(performance.now() - t0);
  if (!silent) showToast(`輝度から自動抽出: ${loadedPoints.length}点 (${ms}ms)`, 'ok');
}

els.photoInput.addEventListener('change', () => {
  const file = els.photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      loadedImageEl = img;
      loadedImageW = img.naturalWidth;
      loadedImageH = img.naturalHeight;
      els.viewportEmpty.hidden = true;
      setBackground(loadedImageEl, loadedImageW, loadedImageH);
      runExtraction({ silent: true });
      showToast(`写真を読み込み、光点を自動抽出しました: ${loadedImageW}×${loadedImageH} / ${loadedPoints.length}点`, 'ok');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

els.extractBtn.addEventListener('click', () => runExtraction());

els.exportPointsBtn.addEventListener('click', () => {
  if (!loadedPoints || loadedPoints.length === 0) {
    showToast('光点がありません。先に写真を読み込んでください', 'error');
    return;
  }
  const data = {
    _comment: '輝度ベースの自動抽出結果（runtime/ で生成）。mask-editor/ で手動調整する際の下敷きにも使える。',
    generated_at: new Date().toISOString(),
    image: { width: loadedImageW, height: loadedImageH },
    points: loadedPoints,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `points-auto-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

els.pointsInput.addEventListener('change', () => {
  const file = els.pointsInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.points)) throw new Error('points配列がありません');
      loadedPoints = data.points;
      tryRenderScene();
      showToast(`光点データを読み込みました（自動抽出を上書き）: ${loadedPoints.length}点`, 'ok');
    } catch (err) {
      showToast(`points.jsonの読み込みに失敗: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
});

els.sampleBtn.addEventListener('click', () => {
  const sample = buildSampleScene();
  loadedImageEl = sample.canvas;
  loadedImageW = sample.width;
  loadedImageH = sample.height;
  loadedPoints = sample.points;
  tryRenderScene();
  showToast(`サンプルシーンを読み込みました: ${sample.points.length}点`, 'ok');
});

// ============================================================
// MIDI
// ============================================================

let midiAccess = null;
let currentInput = null;

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status-text ${kind}`;
  els.statusDot.className = `status-dot ${kind}`;
}

function onMIDIMessage(msg) {
  const data = msg.data;
  const status = data[0];
  const type = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  const d1 = data[1];
  const d2 = data[2];
  const now = performance.now() / 1000;

  if (type === 0x90 && d2 > 0) {
    mapping.notes.forEach((n, i) => {
      if (n.role === 'cluster_trigger' && n.channel === ch && n.note === d1) {
        noteEnvelopes[i].value = d2 / 127;
        noteEnvelopes[i].start = now;
      }
    });
  } else if (type === 0xb0) {
    mapping.control_changes.forEach((cc) => {
      if (cc.channel === ch && cc.cc_number === d1 && cc.target === 'bloom_amount' && els.ccBloomToggle.checked) {
        const strength = (d2 / 127) * MAX_BLOOM_STRENGTH;
        bloomPass.strength = strength;
        els.strength.value = strength.toFixed(2);
        els.strengthVal.textContent = strength.toFixed(2);
      }
    });
  }
}

function populateInputs() {
  const inputs = Array.from(midiAccess.inputs.values());
  els.select.innerHTML = '';
  if (inputs.length === 0) {
    els.select.innerHTML = '<option>MIDI入力デバイスが見つかりません</option>';
    setStatus('MIDI入力が見つかりません。SEQTRAKをUSB接続してください。', 'error');
    return;
  }
  inputs.forEach((input) => {
    const opt = document.createElement('option');
    opt.value = input.id;
    opt.textContent = `${input.name} (${input.manufacturer || 'unknown'})`;
    els.select.appendChild(opt);
  });
  connectTo(els.select.value);
}

function connectTo(inputId) {
  if (currentInput) currentInput.onmidimessage = null;
  const input = midiAccess.inputs.get(inputId);
  if (!input) return;
  currentInput = input;
  input.onmidimessage = onMIDIMessage;
  setStatus(`接続中: ${input.name}`, 'ok');
}

function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    setStatus('このブラウザは Web MIDI API に対応していません。', 'error');
    return;
  }
  navigator.requestMIDIAccess({ sysex: false }).then((access) => {
    midiAccess = access;
    populateInputs();
    access.onstatechange = () => populateInputs();
  }).catch((err) => {
    setStatus(`Web MIDI アクセスが拒否されました: ${err}`, 'error');
  });
}

els.refresh.addEventListener('click', () => initMIDI());
els.select.addEventListener('change', () => connectTo(els.select.value));

// ============================================================
// Bloom controls
// ============================================================

// Extraction sliders only update their displayed value while dragging — re-extracting
// on every input event would be wasteful, so they apply on the "再抽出" button / photo load.
function wireDisplayOnly(input, label, decimals = 0) {
  label.textContent = Number(input.value).toFixed(decimals);
  input.addEventListener('input', () => {
    label.textContent = Number(input.value).toFixed(decimals);
  });
}

function wireSlider(input, label, apply, initial) {
  input.value = initial;
  label.textContent = Number(initial).toFixed(2);
  apply(Number(initial));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    label.textContent = v.toFixed(2);
    apply(v);
  });
}

// ============================================================
// Animation loop
// ============================================================

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now() / 1000;

  clusterEnvelopes.fill(0);
  mapping.notes.forEach((n, i) => {
    if (n.role !== 'cluster_trigger' || n.cluster == null) return;
    const e = noteEnvelopes[i];
    if (e.start === 0) return;
    const v = e.value * Math.exp(-(now - e.start) / (n.tau || 0.15));
    if (v > clusterEnvelopes[n.cluster]) clusterEnvelopes[n.cluster] = v;
  });
  updateMeters();

  if (pointsObj) {
    pointsObj.material.uniforms.envelopes.value = clusterEnvelopes;
    pointsObj.material.uniforms.time.value = now;
  }
  if (bgMesh) {
    bgMesh.material.uniforms.time.value = now;
  }

  if (renderer && bgMesh) {
    render();
  }
}

// ============================================================
// Boot
// ============================================================

initRenderer();
wireDisplayOnly(els.extractTopPercent, els.extractTopPercentVal, 1);
wireDisplayOnly(els.extractMinArea, els.extractMinAreaVal, 0);
wireDisplayOnly(els.extractMaxPoints, els.extractMaxPointsVal, 0);
wireSlider(els.pointSize, els.pointSizeVal, (v) => {
  pointSizeUniformValue = v;
  if (pointsObj) pointsObj.material.uniforms.basePointSize.value = v;
}, 34);
wireSlider(els.ambient, els.ambientVal, (v) => {
  ambientAmountUniformValue = v;
  if (pointsObj) pointsObj.material.uniforms.ambientAmount.value = v;
}, 0.35);
wireSlider(els.bgSway, els.bgSwayVal, (v) => {
  bgSwayAmountUniformValue = v;
  if (bgMesh) bgMesh.material.uniforms.swayAmount.value = v;
}, 0.3);
wireSlider(els.strength, els.strengthVal, (v) => { bloomPass.strength = v; }, 1.6);
wireSlider(els.radius, els.radiusVal, (v) => { bloomPass.radius = v; }, 0.45);
wireSlider(els.threshold, els.thresholdVal, (v) => { bloomPass.threshold = v; }, 0.12);
loadMapping();
initMIDI();
tick();
