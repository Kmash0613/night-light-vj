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
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

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
  extractStatus: document.getElementById('extract-status'),
  extractBtn: document.getElementById('extract-btn'),
  exportPointsBtn: document.getElementById('export-points-btn'),
  brightGain: document.getElementById('bright-gain'),
  brightGainVal: document.getElementById('bright-gain-val'),
  baseLevel: document.getElementById('base-level'),
  baseLevelVal: document.getElementById('base-level-val'),
  strength: document.getElementById('strength'),
  strengthVal: document.getElementById('strength-val'),
  radius: document.getElementById('radius'),
  radiusVal: document.getElementById('radius-val'),
  threshold: document.getElementById('threshold'),
  thresholdVal: document.getElementById('threshold-val'),
  ccBloomToggle: document.getElementById('cc-bloom-toggle'),
  monoAmount: document.getElementById('mono-amount'),
  monoAmountVal: document.getElementById('mono-amount-val'),
  debugKickBtn: document.getElementById('debug-kick-btn'),
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
let composer, bloomPass, monoPass;
let currentAspect = 16 / 9;
let brightGainUniformValue = 1.2;
let baseLevelUniformValue = 0;

// モノクロ化ポストエフェクト。OutputPass の後（＝表示直前の最終色）に掛けるので、
// bloomの輝度判定などは通常通りカラーのまま行われ、見た目だけが最後にグレースケール化される。
// amount=0で通常のカラー、1で完全なモノクロ。中間値で部分的な彩度落としもできる。
const monoShader = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      gl_FragColor = vec4(mix(color.rgb, vec3(gray), amount), color.a);
    }
  `,
};

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
  monoPass = new ShaderPass(monoShader);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(monoPass);

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
// マップが0の場所は写真のまま変化しない。
// ambient breathing（MIDIが無い間の自動揺らぎ）は検証を単純化するためいったん
// オミットしている。その代わり baseLevel という定数のベースラインだけを残している:
// マイナス方向にすると、マップが乗っている場所は待機中は元の写真より暗く沈み、
// KICKが来たときだけそこから持ち上がる（明るさの差が出て「効いている」のが見やすい）。
// 0ならこれまで通りKICKのNote Onだけが明るさを動かす最小構成に戻る。
const bgFragmentShader = `
  precision mediump float;
  uniform sampler2D map;
  uniform sampler2D maskMap;
  uniform float kickEnvelope;
  uniform float baseLevel;
  uniform float brightGain;
  varying vec2 vUv;

  vec3 srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

  void main() {
    vec4 tex = texture2D(map, vUv);
    vec3 base = srgbToLinear(tex.rgb);
    float weight = texture2D(maskMap, vUv).r;

    // baseLevel（通常は0以下）が待機中の基準を沈め、KICKのエンベロープ
    // (0以上、ノートオンで立ち上がる)がそこから明るさを持ち上げる。
    float delta = weight * (baseLevel + kickEnvelope);

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
      baseLevel: { value: baseLevelUniformValue },
      brightGain: { value: brightGainUniformValue },
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
// Luminance map extraction（要件定義書 §4 の簡易版・ブラウザ内実装）
// クラスタ分けはいったん無し。検出した画素はすべて同じ1チャンネルの重みマップに
// 書き込み、KICKトラックのエンベロープで一律に明滅させる。
//
// 以前は連結成分（塊）検出をしてから重みを付けていたが、閾値の位置次第で
// 「塊はできるのに重みが全部0になる」「塊が画像の半分を覆う」といった
// 縮退ケースを何度も踏んだ。今は塊検出をやめ、各画素ごとに直接
// 「その画素自身の輝度」を重みにする。この式は threshold がどこに来ても
// 数学的に0除算にならず、閾値を超えた画素は必ず何らかの重みを持つ。
// ============================================================

function extractLuminanceMask(source, naturalW, naturalH, opts) {
  const { topPercent, maxDim } = opts;
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
    // hist[] は丸めた輝度でバケット化するので、以降の閾値判定もこの丸めた値と
    // 揃えないと「ヒストグラム上はtargetCountを満たすはずが、実際にフィルタすると
    // 大幅に少ない画素しか残らない」というズレが起きる（単色に近い塗りつぶし領域の
    // 輝度が33.7のような閾値未満の小数だと、丸めてhist[34]に入って集計上はカウント
    // されるのに、生の値では34未満として弾かれてしまう）。luma[]自体を丸めた整数
    // として保持し、両方の判定を完全に一致させる。
    const lr = Math.round(l);
    luma[i] = lr;
    hist[lr] += 1;
  }

  // Percentile threshold: brightest `topPercent`% of pixels.
  // targetCount <= n が保証されるため、この閾値を満たす画素は必ず1個以上ある
  // （= 「0領域」は構造的に起こり得ない。以前あった0領域リトライは不要）。
  const targetCount = Math.max(1, Math.round((n * topPercent) / 100));
  let cum = 0;
  let threshold = 255;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum >= targetCount) { threshold = v; break; }
  }

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const maskCtx = maskCanvas.getContext('2d');
  const maskData = maskCtx.createImageData(w, h);
  // アルファを0のままにすると、ブラウザのcanvas内部表現（premultiplied alpha）が
  // putImageData/getImageDataの往復やWebGLへのアップロード時にRGBを0に潰してしまう
  // （alpha=0の画素は色情報が無いものとして扱われるため）。ここではRチャンネルが
  // 実データなので、全画素のアルファを255（不透明）にしてこれを防ぐ。
  for (let i = 3; i < maskData.data.length; i += 4) maskData.data[i] = 255;

  let qualifying = 0;
  for (let i = 0; i < n; i++) {
    if (luma[i] < threshold) continue;
    qualifying++;
    // 重みは画素自身の輝度（0-255を0-1に正規化）で決める。thresholdからの
    // 距離ではないので、thresholdが255付近になっても0除算的に潰れない。
    // 最低でも0.35は確保し、閾値ぎりぎりの画素も見えるようにする。
    const weight = Math.min(1, Math.max(0.35, luma[i] / 255));
    maskData.data[i * 4] = Math.round(weight * 255); // R channel
  }
  maskCtx.putImageData(maskData, 0, 0);

  return { maskCanvas, coveragePercent: (100 * qualifying) / n, threshold };
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
  // extractLuminanceMask と同じ理由で、アルファを全画素255にしてRチャンネルの
  // 重みがブラウザのpremultiplied alpha往復で消えないようにする。
  for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
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
    maxDim: 700,
  };
}

let lastMaskInfo = null; // { coveragePercent, threshold } — debug export用

// 抽出結果を常時表示するステータス行。
function setExtractStatus(text, kind) {
  if (!els.extractStatus) return;
  els.extractStatus.textContent = text;
  els.extractStatus.className = `hint${kind === 'error' ? ' extract-status-error' : ''}`;
}

function runExtraction({ silent = false } = {}) {
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
  const { maskCanvas, coveragePercent, threshold } = result;
  applyMaskCanvas(maskCanvas);
  lastMaskInfo = { coveragePercent, threshold };
  const ms = Math.round(performance.now() - t0);

  setExtractStatus(`検出: 画像の${coveragePercent.toFixed(1)}% (輝度閾値 ${threshold} / ${ms}ms)`, coveragePercent === 0 ? 'error' : null);
  if (!silent) showToast(`輝度マップを再生成: 画像の${coveragePercent.toFixed(1)}% (${ms}ms)`, 'ok');
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
      const pct = lastMaskInfo ? lastMaskInfo.coveragePercent.toFixed(1) : '?';
      showToast(`写真を読み込みました: ${loadedImageW}×${loadedImageH} / 輝度マップ ${pct}%`, 'ok');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

els.extractBtn.addEventListener('click', () => runExtraction());

els.exportPointsBtn.addEventListener('click', () => {
  if (!lastMaskInfo) {
    showToast('検出データがありません。先に写真を読み込んでください', 'error');
    return;
  }
  const data = {
    _comment: '輝度マップ生成時の統計（デバッグ用）。マップ自体は各画素ごとの重みで、個別の点としては保持していない。',
    generated_at: new Date().toISOString(),
    image: { width: loadedImageW, height: loadedImageH },
    top_percent: Number(els.extractTopPercent.value),
    threshold: lastMaskInfo.threshold,
    coverage_percent: lastMaskInfo.coveragePercent,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `luminance-map-stats-${Date.now()}.json`;
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
      setExtractStatus(`検出: 手動データ ${data.points.length}点を使用中`, null);
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
  const pct = lastMaskInfo ? lastMaskInfo.coveragePercent.toFixed(1) : '?';
  showToast(`サンプルシーンを読み込みました: 輝度マップ ${pct}%`, 'ok');
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

// Note Onを受けたのと同じ処理。実MIDIからも、下のデバッグボタンからも呼ぶ。
function triggerKick(velocity) {
  const now = performance.now() / 1000;
  kickEntryIndices.forEach((i) => {
    kickNoteEnvelopes[i].value = velocity / 127;
    kickNoteEnvelopes[i].start = now;
  });
}

function onMIDIMessage(msg) {
  const data = msg.data;
  const status = data[0];
  const type = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  const d1 = data[1];
  const d2 = data[2];

  if (type === 0x90 && d2 > 0) {
    kickEntryIndices.forEach((i) => {
      const n = mapping.notes[i];
      if (n.channel === ch && n.note === d1) {
        kickNoteEnvelopes[i].value = d2 / 127;
        kickNoteEnvelopes[i].start = performance.now() / 1000;
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

els.debugKickBtn.addEventListener('click', () => {
  if (kickEntryIndices.length === 0) {
    showToast('config/midi-mapping.json にKICK扱いのエントリがありません', 'error');
    return;
  }
  triggerKick(100);
  showToast('KICKを疑似発火しました（velocity=100）', 'ok');
});

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
    render();
  }
}

// ============================================================
// Boot
// ============================================================

initRenderer();
wireDisplayOnly(els.extractTopPercent, els.extractTopPercentVal, 1);
wireSlider(els.brightGain, els.brightGainVal, (v) => {
  brightGainUniformValue = v;
  if (bgMesh) bgMesh.material.uniforms.brightGain.value = v;
}, 1.2);
wireSlider(els.baseLevel, els.baseLevelVal, (v) => {
  baseLevelUniformValue = v;
  if (bgMesh) bgMesh.material.uniforms.baseLevel.value = v;
}, 0);
wireSlider(els.strength, els.strengthVal, (v) => { bloomPass.strength = v; }, 1.6);
wireSlider(els.radius, els.radiusVal, (v) => { bloomPass.radius = v; }, 0.45);
wireSlider(els.threshold, els.thresholdVal, (v) => { bloomPass.threshold = v; }, 0.55);
wireSlider(els.monoAmount, els.monoAmountVal, (v) => { monoPass.uniforms.amount.value = v; }, 0);
loadMapping();
initMIDI();
tick();
