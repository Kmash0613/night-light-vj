// Phase 1: 光点明滅の最小構成（輝度マップ方式・簡易版）
// 写真1枚 + カメラ固定。個別の光点（パーティクル）は打たず、写真の輝度が高い場所を
// 検出して「輝度マップ」（重み1チャンネル）を作り、KICKトラックのNote Onに応じて
// そのマップの値が乗っている場所だけ、元の写真の明るさを上げ下げする。
// クラスタ分け（トラックごとに別々の場所を光らせる）はいったん無くし、
// 全ての光る場所がKICKに連動する最小構成にしている。ブルームは通常のUnrealBloomPass。
// 要件定義書 §5, §9 Phase 1 に対応。

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const KICK_COLOR = 0xffb74d;
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
  extractTopPercentVal: document.getElementById('extract-top-percent-val'),
  extractMinArea: document.getElementById('extract-min-area'),
  extractMinAreaVal: document.getElementById('extract-min-area-val'),
  extractMaxPoints: document.getElementById('extract-max-points'),
  extractMaxPointsVal: document.getElementById('extract-max-points-val'),
  extractStatus: document.getElementById('extract-status'),
  extractBtn: document.getElementById('extract-btn'),
  exportPointsBtn: document.getElementById('export-points-btn'),
  brightGain: document.getElementById('bright-gain'),
  brightGainVal: document.getElementById('bright-gain-val'),
  ambient: document.getElementById('ambient'),
  ambientVal: document.getElementById('ambient-val'),
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
let kickNoteEnvelopes = []; // KICKにマッチしたnote entryごとの {value, start}（通常は1個）
let kickEntryIndices = []; // mapping.notes の中で「KICK」とみなすエントリのindex
let kickEnvelope = 0; // 現在のKICKエンベロープ値（複数エントリがあれば最大値）

async function loadMapping() {
  try {
    const res = await fetch('../config/midi-mapping.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mapping = await res.json();

    // 「すべてKICKに連動」: role=cluster_trigger かつ name が KICK のエントリを探す。
    // 見つからない場合は cluster_trigger 全体をKICK扱いにフォールバックする。
    kickEntryIndices = mapping.notes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.role === 'cluster_trigger' && n.name && n.name.toUpperCase() === 'KICK')
      .map(({ i }) => i);
    if (kickEntryIndices.length === 0) {
      kickEntryIndices = mapping.notes
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => n.role === 'cluster_trigger')
        .map(({ i }) => i);
      if (kickEntryIndices.length > 0) {
        console.warn('config/midi-mapping.json に name="KICK" のエントリが無いため、cluster_trigger 全体をKICK扱いにします。');
      }
    }
    kickNoteEnvelopes = mapping.notes.map(() => ({ value: 0, start: 0 }));
    buildMeters();
  } catch (err) {
    showToast('config/midi-mapping.json を読み込めませんでした。file:// では動かないので http(s) 経由で開いてください。', 'error');
    console.error(err);
  }
}

// ============================================================
// Kick envelope meter (UI)
// ============================================================

let meterFill = null;
let meterVal = null;

function buildMeters() {
  els.meters.innerHTML = '';
  if (kickEntryIndices.length === 0) {
    els.meters.innerHTML = '<p class="hint">config/midi-mapping.json に cluster_trigger のマッピングがありません。</p>';
    meterFill = null;
    meterVal = null;
    return;
  }
  const color = `#${KICK_COLOR.toString(16).padStart(6, '0')}`;
  const row = document.createElement('div');
  row.className = 'meter-row';
  row.innerHTML = `
    <span class="dot" style="background:${color}"></span>
    <span>KICK</span>
    <span class="track"><span class="fill" style="background:${color}"></span></span>
    <span class="val">0.00</span>
  `;
  els.meters.appendChild(row);
  meterFill = row.querySelector('.fill');
  meterVal = row.querySelector('.val');
}

function updateMeters() {
  if (!meterFill) return;
  meterFill.style.width = `${Math.min(100, kickEnvelope * 100).toFixed(1)}%`;
  meterVal.textContent = kickEnvelope.toFixed(2);
}

// ============================================================
// Three.js scene
// ============================================================

let renderer, camera, scene, bgMesh;
let composer, bloomPass;
let currentAspect = 16 / 9;
let brightGainUniformValue = 1.2;
let ambientAmountUniformValue = 0.35;

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // NoToneMapping: our background shader already outputs linear color that OutputPass
  // converts to sRGB; adding a filmic curve on top would double-apply and flatten it.
  renderer.toneMapping = THREE.NoToneMapping;
  els.viewport.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;

  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.6, 0.45, 0.55);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  const w = els.viewport.clientWidth || 1;
  const h = els.viewport.clientHeight || 1;
  renderer.setSize(w, h);
  composer.setSize(w, h);

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

function render() {
  composer.render();
}

// ============================================================
// Background: photo + luminance map -> per-pixel brightness up/down
// ============================================================

const bgVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// maskMap の r チャンネルは、その画素が輝度マップに含まれる重み(0-1)。
// マップが0の場所は写真のまま変化しない。MIDIが無くてもambientの分だけ
// 0を中心に上下し、そこにKICKのエンベロープが加算される。
const bgFragmentShader = `
  precision mediump float;
  uniform sampler2D map;
  uniform sampler2D maskMap;
  uniform float kickEnvelope;
  uniform float ambientAmount;
  uniform float brightGain;
  uniform float time;
  varying vec2 vUv;

  vec3 srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    vec4 tex = texture2D(map, vUv);
    vec3 base = srgbToLinear(tex.rgb);
    float weight = texture2D(maskMap, vUv).r;

    // 位置ごとにバラバラの位相で明滅する「呼吸」のベースライン。
    // -ambientAmount 〜 +ambientAmount を往復する符号付きサイン波なので、
    // MIDIが無い間も明るくなる方向・暗くなる方向の両方にはっきり振れる。
    float ph = hash21(floor(vUv * 60.0));
    float ambient = ambientAmount * sin(time * (0.4 + 0.25 * ph) + ph * 6.2831);

    // KICKのエンベロープ(0以上、ノートオンで加算)はその上に乗る＝暗くはせず明るさを追加する。
    float delta = weight * (kickEnvelope + ambient);

    float factor = clamp(1.0 + brightGain * delta, 0.06, 3.5);
    gl_FragColor = vec4(base * factor, tex.a);
  }
`;

function makeEmptyMaskTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 2;
  const tex = new THREE.CanvasTexture(c);
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function setBackground(source, width, height) {
  if (bgMesh) {
    scene.remove(bgMesh);
    bgMesh.geometry.dispose();
    bgMesh.material.uniforms.map.value?.dispose();
    bgMesh.material.uniforms.maskMap.value?.dispose();
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
      maskMap: { value: makeEmptyMaskTexture() },
      kickEnvelope: { value: 0 },
      ambientAmount: { value: ambientAmountUniformValue },
      brightGain: { value: brightGainUniformValue },
      time: { value: 0 },
    },
    vertexShader: bgVertexShader,
    fragmentShader: bgFragmentShader,
  });
  bgMesh = new THREE.Mesh(geometry, material);
  bgMesh.position.z = 0;
  scene.add(bgMesh);
  resize();
}

function applyMaskCanvas(maskCanvas) {
  if (!bgMesh) return;
  const tex = new THREE.CanvasTexture(maskCanvas);
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  bgMesh.material.uniforms.maskMap.value?.dispose();
  bgMesh.material.uniforms.maskMap.value = tex;
}

// ============================================================
// Luminance map extraction (要件定義書 §4 の簡易版・ブラウザ内実装)
// クラスタ分けはいったん無し。検出した領域はすべて同じ1チャンネルの重みマップに
// 書き込み、KICKトラックのエンベロープで一律に明滅させる。
// ============================================================

function extractLuminanceMask(source, naturalW, naturalH, opts) {
  const { topPercent, minArea, maxDim, maxRegions } = opts;
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.drawImage(source, 0, 0, w, h);
  const { data } = srcCtx.getImageData(0, 0, w, h);

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
  const stack = new Int32Array(n);
  const blobs = []; // {pixels:number[], area, x, y, color}

  for (let start = 0; start < n; start++) {
    if (visited[start] || luma[start] < threshold) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    const pixels = [start];
    let sumX = 0, sumY = 0, sumR = 0, sumG = 0, sumB = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p / w) | 0;
      sumX += px; sumY += py;
      sumR += data[p * 4]; sumG += data[p * 4 + 1]; sumB += data[p * 4 + 2];
      if (px > 0 && !visited[p - 1] && luma[p - 1] >= threshold) { visited[p - 1] = 1; stack[sp++] = p - 1; pixels.push(p - 1); }
      if (px < w - 1 && !visited[p + 1] && luma[p + 1] >= threshold) { visited[p + 1] = 1; stack[sp++] = p + 1; pixels.push(p + 1); }
      if (py > 0 && !visited[p - w] && luma[p - w] >= threshold) { visited[p - w] = 1; stack[sp++] = p - w; pixels.push(p - w); }
      if (py < h - 1 && !visited[p + w] && luma[p + w] >= threshold) { visited[p + w] = 1; stack[sp++] = p + w; pixels.push(p + w); }
    }
    const area = pixels.length;
    if (area >= minArea) {
      blobs.push({
        pixels,
        area,
        x: sumX / area / w,
        y: sumY / area / h,
        color: [Math.round(sumR / area), Math.round(sumG / area), Math.round(sumB / area)],
      });
    }
  }

  // Cap to the most prominent blobs (largest area) to stay within a sane budget.
  blobs.sort((a, b) => b.area - a.area);
  const capped = blobs.slice(0, maxRegions);

  // Paint the mask: single-channel weight map (stored in the R channel).
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const maskCtx = maskCanvas.getContext('2d');
  const maskData = maskCtx.createImageData(w, h); // transparent black by default

  for (const blob of capped) {
    for (const idx of blob.pixels) {
      const weight = Math.min(1, Math.max(0, (luma[idx] - threshold) / Math.max(1, 255 - threshold)));
      const di = idx * 4; // R channel
      const v = Math.round(weight * 255);
      if (v > maskData.data[di]) maskData.data[di] = v;
    }
  }
  maskCtx.putImageData(maskData, 0, 0);

  const exportBlobs = capped.map((b) => ({ x: b.x, y: b.y, color: b.color, area: b.area }));
  return { maskCanvas, regionCount: capped.length, exportBlobs };
}

// 手作業の points.json (mask-editor/ 製) を、同じ1チャンネルの重みマップに焼き直す。
// points.jsonのcluster値は今は無視し、全ての点を同じ重みマップに含める。
function pointsToMaskCanvas(points, naturalW, naturalH, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);
  const radius = Math.max(3, Math.round(Math.min(w, h) * 0.025));

  for (const p of points) {
    const cx = p.x * w, cy = p.y * h;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(h - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d > 1) continue;
        const weight = Math.pow(1 - d, 1.5);
        const idx = (y * w + x) * 4; // R channel
        const v = Math.round(weight * 255);
        if (v > imgData.data[idx]) imgData.data[idx] = v;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
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

  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff); };

  const bands = [
    { baseY: h * 0.55, minH: 120, maxH: 260, color: '#12161f', dot: 'rgba(255,183,77,' },
    { baseY: h * 0.62, minH: 90, maxH: 190, color: '#171c28', dot: 'rgba(111,183,224,' },
    { baseY: h * 0.7, minH: 50, maxH: 120, color: '#1c2230', dot: 'rgba(199,146,234,' },
  ];

  for (const band of bands) {
    let x = -20;
    ctx.fillStyle = band.color;
    while (x < w + 20) {
      const bw = 40 + rand() * 70;
      const bh = band.minH + rand() * (band.maxH - band.minH);
      ctx.fillRect(x, band.baseY - bh, bw, h - (band.baseY - bh));
      const rows = Math.max(2, Math.round(bh / 26));
      const cols = Math.max(2, Math.round(bw / 22));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (rand() > 0.32) continue;
          const px = x + 6 + c * (bw - 12) / Math.max(1, cols - 1);
          const py = band.baseY - bh + 10 + r * (bh - 20) / Math.max(1, rows - 1);
          ctx.fillStyle = `${band.dot}${(0.8 + rand() * 0.2).toFixed(2)})`;
          ctx.fillRect(px - 2, py - 2, 4, 4);
          ctx.fillStyle = band.color;
        }
      }
      x += bw + 6 + rand() * 14;
    }
  }

  // A few large foreground "neon" highlights near the bottom.
  for (let i = 0; i < 6; i++) {
    const x = w * (0.1 + rand() * 0.8);
    const y = h * (0.8 + rand() * 0.15);
    ctx.fillStyle = 'rgba(255,122,89,1)';
    ctx.fillRect(x - 4, y - 4, 8, 8);
  }

  return { canvas, width: w, height: h };
}

// ============================================================
// File loading
// ============================================================

let loadedImageEl = null;
let loadedImageW = 0;
let loadedImageH = 0;

function currentExtractOptions() {
  return {
    topPercent: Number(els.extractTopPercent.value),
    minArea: Number(els.extractMinArea.value),
    maxRegions: Number(els.extractMaxPoints.value),
    maxDim: 700,
  };
}

let lastExportBlobs = [];

// 抽出結果を常時表示するステータス行。0領域のまま気づかない、というのを防ぐ。
function setExtractStatus(text, kind) {
  if (!els.extractStatus) return;
  els.extractStatus.textContent = text;
  els.extractStatus.className = `hint${kind === 'error' ? ' extract-status-error' : ''}`;
}

function runExtraction({ silent = false, _retried = false } = {}) {
  if (!loadedImageEl) return;
  const opts = currentExtractOptions();
  const t0 = performance.now();
  let result;
  try {
    result = extractLuminanceMask(loadedImageEl, loadedImageW, loadedImageH, opts);
  } catch (err) {
    console.error('extractLuminanceMask failed', err);
    showToast(`輝度マップの生成に失敗しました: ${err.message}`, 'error');
    setExtractStatus(`検出: エラー (${err.message})`, 'error');
    return;
  }
  const { maskCanvas, regionCount, exportBlobs } = result;
  applyMaskCanvas(maskCanvas);
  lastExportBlobs = exportBlobs;
  const ms = Math.round(performance.now() - t0);

  // 0領域のまま気づかず「全く明滅しない」状態になるのを防ぐため、top %を上げて自動的に1回だけ再試行する。
  if (regionCount === 0 && !_retried && opts.topPercent < 40) {
    const bumped = Math.min(40, opts.topPercent * 2);
    els.extractTopPercent.value = bumped;
    els.extractTopPercentVal.textContent = bumped.toFixed(1);
    showToast(`0領域だったため top % を ${bumped.toFixed(1)}% に上げて再試行します`, 'error');
    runExtraction({ silent, _retried: true });
    return;
  }

  setExtractStatus(`検出: ${regionCount}領域 (top ${opts.topPercent}% / ${ms}ms)`, regionCount === 0 ? 'error' : null);
  if (!silent) showToast(`輝度マップを再生成: ${regionCount}領域 (${ms}ms)`, 'ok');
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
      showToast(`写真を読み込みました: ${loadedImageW}×${loadedImageH} / ${lastExportBlobs.length}領域`, 'ok');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

els.extractBtn.addEventListener('click', () => runExtraction());

els.exportPointsBtn.addEventListener('click', () => {
  if (!lastExportBlobs.length) {
    showToast('検出データがありません。先に写真を読み込んでください', 'error');
    return;
  }
  const data = {
    _comment: '輝度マップ生成時に検出された領域（デバッグ用/mask-editorとの互換用）。',
    generated_at: new Date().toISOString(),
    image: { width: loadedImageW, height: loadedImageH },
    points: lastExportBlobs,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `luminance-regions-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

els.pointsInput.addEventListener('change', () => {
  const file = els.pointsInput.files[0];
  if (!file) return;
  if (!loadedImageEl) {
    showToast('先に写真を読み込んでください', 'error');
    els.pointsInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.points)) throw new Error('points配列がありません');
      const maskCanvas = pointsToMaskCanvas(data.points, loadedImageW, loadedImageH, 700);
      applyMaskCanvas(maskCanvas);
      lastExportBlobs = data.points;
      showToast(`光点データからマップを生成しました（自動抽出を上書き）: ${data.points.length}点`, 'ok');
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
  els.viewportEmpty.hidden = true;
  setBackground(loadedImageEl, loadedImageW, loadedImageH);
  runExtraction({ silent: true });
  showToast(`サンプルシーンを読み込みました: ${lastExportBlobs.length}領域`, 'ok');
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
    kickEntryIndices.forEach((i) => {
      const n = mapping.notes[i];
      if (n.channel === ch && n.note === d1) {
        kickNoteEnvelopes[i].value = d2 / 127;
        kickNoteEnvelopes[i].start = now;
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
// Slider helpers
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

  kickEnvelope = 0;
  kickEntryIndices.forEach((i) => {
    const n = mapping.notes[i];
    const e = kickNoteEnvelopes[i];
    if (e.start === 0) return;
    const v = e.value * Math.exp(-(now - e.start) / (n.tau || 0.15));
    if (v > kickEnvelope) kickEnvelope = v;
  });
  updateMeters();

  if (bgMesh) {
    bgMesh.material.uniforms.kickEnvelope.value = kickEnvelope;
    bgMesh.material.uniforms.time.value = now;
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
wireSlider(els.brightGain, els.brightGainVal, (v) => {
  brightGainUniformValue = v;
  if (bgMesh) bgMesh.material.uniforms.brightGain.value = v;
}, 1.2);
wireSlider(els.ambient, els.ambientVal, (v) => {
  ambientAmountUniformValue = v;
  if (bgMesh) bgMesh.material.uniforms.ambientAmount.value = v;
}, 0.35);
wireSlider(els.strength, els.strengthVal, (v) => { bloomPass.strength = v; }, 1.6);
wireSlider(els.radius, els.radiusVal, (v) => { bloomPass.radius = v; }, 0.45);
wireSlider(els.threshold, els.thresholdVal, (v) => { bloomPass.threshold = v; }, 0.55);
loadMapping();
initMIDI();
tick();
