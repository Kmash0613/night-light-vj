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

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  els.viewport.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;

  const renderScene = new RenderPass(scene, camera);

  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.2, 0.4, 0.1);

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

function setBackground(source, width, height) {
  if (bgMesh) {
    scene.remove(bgMesh);
    bgMesh.geometry.dispose();
    bgMesh.material.map?.dispose();
    bgMesh.material.dispose();
  }
  currentAspect = width / height;
  const texture = new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(currentAspect * 2, 2);
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: true });
  bgMesh = new THREE.Mesh(geometry, material);
  bgMesh.position.z = 0;
  scene.add(bgMesh);
  resize();
}

const pointVertexShader = `
  attribute float cluster;
  attribute vec3 pointColor;
  uniform float envelopes[${MAX_CLUSTERS}];
  uniform float basePointSize;
  uniform float pixelRatio;
  varying vec3 vColor;
  varying float vEnv;
  void main() {
    int idx = int(cluster);
    float env = envelopes[idx];
    vEnv = env;
    vColor = pointColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = basePointSize * pixelRatio * (0.35 + 0.9 * env);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const pointFragmentShader = `
  precision mediump float;
  varying vec3 vColor;
  varying float vEnv;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    float alpha = smoothstep(0.5, 0.0, d) * vEnv;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor * (0.6 + 1.6 * vEnv), alpha);
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

  points.forEach((p, i) => {
    positions[i * 3 + 0] = (p.x - 0.5) * currentAspect * 2;
    positions[i * 3 + 1] = (0.5 - p.y) * 2;
    positions[i * 3 + 2] = 0.01;
    const c = p.color || [255, 220, 160];
    colors[i * 3 + 0] = c[0] / 255;
    colors[i * 3 + 1] = c[1] / 255;
    colors[i * 3 + 2] = c[2] / 255;
    clusters[i] = Math.min(MAX_CLUSTERS - 1, Math.max(0, p.cluster || 0));
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('pointColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('cluster', new THREE.BufferAttribute(clusters, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      envelopes: { value: new Float32Array(MAX_CLUSTERS) },
      basePointSize: { value: 26 },
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
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
let loadedPoints = null;

function tryRenderScene() {
  if (!loadedImageEl) return;
  els.viewportEmpty.hidden = true;
  setBackground(loadedImageEl, loadedImageEl.naturalWidth || loadedImageEl.width, loadedImageEl.naturalHeight || loadedImageEl.height);
  setPoints(loadedPoints || []);
}

els.photoInput.addEventListener('change', () => {
  const file = els.photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      loadedImageEl = img;
      tryRenderScene();
      showToast(`写真を読み込みました: ${img.naturalWidth}×${img.naturalHeight}`, 'ok');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
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
      showToast(`光点データを読み込みました: ${loadedPoints.length}点`, 'ok');
    } catch (err) {
      showToast(`points.jsonの読み込みに失敗: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
});

els.sampleBtn.addEventListener('click', () => {
  const sample = buildSampleScene();
  loadedImageEl = sample.canvas;
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

function wireSlider(input, label, apply, initial) {
  input.value = initial;
  label.textContent = Number(initial).toFixed(2);
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
  }

  if (renderer && bgMesh) {
    render();
  }
}

// ============================================================
// Boot
// ============================================================

initRenderer();
wireSlider(els.strength, els.strengthVal, (v) => { bloomPass.strength = v; }, 1.2);
wireSlider(els.radius, els.radiusVal, (v) => { bloomPass.radius = v; }, 0.4);
wireSlider(els.threshold, els.thresholdVal, (v) => { bloomPass.threshold = v; }, 0.1);
loadMapping();
initMIDI();
tick();
