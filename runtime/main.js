// Phase 1: 光点明滅の最小構成（輝度マップ方式）
// 写真1枚。個別の光点（パーティクル）は打たず、写真の輝度が高い場所を
// 検出して「輝度マップ」（重み4チャンネル＝クラスタ分）を作り、各クラスタに紐づく
// トラックのNote Onに応じて、そのクラスタの重みが乗っている場所だけ、元の写真の
// 明るさを上げ下げする。ブルームは通常のUnrealBloomPass。要件定義書 §5, §9 Phase 1 に対応。
//
// クラスタ分けは一度、動作確認を単純化するために丸ごと無くしKICK一本にしていたが、
// 明滅の土台（輝度マップ生成・MIDI連動・16:9出力）が安定して確認できたので復活させた。
// 塊（連結成分）検出は使わず、画素ごとの輝度で重みを決める設計は維持したまま、
// クラスタの割り当ては疑似深度を主軸・XY座標を従軸にしたk-means
// （clusterQualifyingPixels()）で決める（要件定義書 §4）。
//
// Phase 2: 深度による3D化（実験的、要件定義書 §5, §9 Phase 2 に対応）
// 本物の深度推定モデルはこのブラウザ環境には無いため、画素のY位置＋輝度から作る
// 「疑似深度マップ」（generatePseudoDepthGrid()）でひとまず代用している。背景メッシュを
// 細分化したジオメトリにして、疑似深度ぶんだけ頂点Zをずらし（ディスプレイスメント）、
// カメラはPerspectiveCameraにしてZ方向にゆっくり呼吸させる（dolly_in、tick()内）。
// 疑似深度は generatePseudoDepthGrid() 単体に閉じているので、将来Depth Anything V2等の
// 本物の深度マップ（batch/の出力やPNGの手動読み込み）に差し替える際もその関数の中身だけ
// 変えればよい設計にしてある。

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// 輝度マップはRGBAの4チャンネルまでしか安全に持てない（後述のDataTexture参照）ので、
// クラスタは最大4つ。config/midi-mapping.jsonの実測データも cluster: 0-3 の4つのみ使う。
const CLUSTER_COLORS = ['#ffb74d', '#ff7a59', '#6fb7e0', '#c792ea']; // R,G,B,Aチャンネルの順と対応
const CLUSTER_COUNT = CLUSTER_COLORS.length;
const MAX_BLOOM_STRENGTH = 3;
const OUTPUT_ASPECT = 16 / 9; // 出力フレームは常に16:9固定。写真は歪ませずコンテインフィット（黒帯あり、クロップ無し）。

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
  depth3dToggle: document.getElementById('depth3d-toggle'),
  depthStrength: document.getElementById('depth-strength'),
  depthStrengthVal: document.getElementById('depth-strength-val'),
  dollyAmplitude: document.getElementById('dolly-amplitude'),
  dollyAmplitudeVal: document.getElementById('dolly-amplitude-val'),
  dollyPeriod: document.getElementById('dolly-period'),
  dollyPeriodVal: document.getElementById('dolly-period-val'),
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
let clusterNoteEnvelopes = []; // mapping.notes の各エントリごとの {value, start}
// clusterEntryIndices[c] = クラスタcにマッチする mapping.notes のindex配列。
// loadMapping()（非同期）が完了する前にも tick() が clusterEntryIndices[c] を参照するので、
// 空配列ではなく最初からCLUSTER_COUNT個の空配列で初期化しておく（[c]がundefinedにならないように）。
let clusterEntryIndices = Array.from({ length: CLUSTER_COUNT }, () => []);
let kickEntryIndices = []; // name="KICK" のエントリ（デバッグボタン専用。無ければcluster0全体で代用）
let clusterEnvelope = new Float32Array(CLUSTER_COUNT); // 現在の各クラスタのエンベロープ値（複数エントリがあれば最大値）

async function loadMapping() {
  try {
    const res = await fetch('../config/midi-mapping.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mapping = await res.json();

    // role=cluster_trigger のエントリを cluster フィールドでグループ化する。
    // cluster が 0-3 の範囲外/nullなら cluster 0 にフォールバック（他のマッピング
    // ファイルでも壊れないように）。
    clusterEntryIndices = Array.from({ length: CLUSTER_COUNT }, () => []);
    mapping.notes.forEach((n, i) => {
      if (n.role !== 'cluster_trigger') return;
      const c = Number.isInteger(n.cluster) && n.cluster >= 0 && n.cluster < CLUSTER_COUNT ? n.cluster : 0;
      clusterEntryIndices[c].push(i);
    });

    // デバッグボタン用: name="KICK" のエントリを個別に探す。無ければ cluster0 全体で代用する
    // （configの実測データでは常にKICK=cluster0だが、他のマッピングファイルでも動くように）。
    kickEntryIndices = mapping.notes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.role === 'cluster_trigger' && n.name && n.name.toUpperCase() === 'KICK')
      .map(({ i }) => i);
    if (kickEntryIndices.length === 0) {
      kickEntryIndices = clusterEntryIndices[0].slice();
      if (kickEntryIndices.length > 0) {
        console.warn('config/midi-mapping.json に name="KICK" のエントリが無いため、cluster 0 全体をKICK扱いにします。');
      }
    }
    clusterNoteEnvelopes = mapping.notes.map(() => ({ value: 0, start: 0 }));
    buildMeters();
  } catch (err) {
    showToast('config/midi-mapping.json を読み込めませんでした。file:// では動かないので http(s) 経由で開いてください。', 'error');
    console.error(err);
  }
}

// ============================================================
// Cluster envelope meters (UI)
// ============================================================

let meterFills = []; // meterFills[c]
let meterVals = []; // meterVals[c]

function buildMeters() {
  els.meters.innerHTML = '';
  meterFills = [];
  meterVals = [];
  const anyEntries = clusterEntryIndices.some((arr) => arr.length > 0);
  if (!anyEntries) {
    els.meters.innerHTML = '<p class="hint">config/midi-mapping.json に cluster_trigger のマッピングがありません。</p>';
    return;
  }
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    if (clusterEntryIndices[c].length === 0) continue; // マッチするトラックが無いクラスタは表示しない
    const names = clusterEntryIndices[c].map((i) => mapping.notes[i].name).join(' / ');
    const row = document.createElement('div');
    row.className = 'meter-row';
    row.innerHTML = `
      <span class="dot" style="background:${CLUSTER_COLORS[c]}"></span>
      <span>cluster ${c}${names ? ` (${names})` : ''}</span>
      <span class="track"><span class="fill" style="background:${CLUSTER_COLORS[c]}"></span></span>
      <span class="val">0.00</span>
    `;
    els.meters.appendChild(row);
    meterFills[c] = row.querySelector('.fill');
    meterVals[c] = row.querySelector('.val');
  }
}

function updateMeters() {
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    if (!meterFills[c]) continue;
    meterFills[c].style.width = `${Math.min(100, clusterEnvelope[c] * 100).toFixed(1)}%`;
    meterVals[c].textContent = clusterEnvelope[c].toFixed(2);
  }
}

// ============================================================
// Three.js scene
// ============================================================

let renderer, camera, scene, bgMesh;
let composer, bloomPass, monoPass;
let currentAspect = 16 / 9;
let brightGainUniformValue = 1.2;
let baseLevelUniformValue = 0;

// Phase 2: 深度3D（実験的）。カメラは常にPerspectiveCameraだが、depth3dEnabled=false
// （かつ depthStrengthValue=0 相当）なら疑似深度ディスプレイスメント・ドリー移動の
// どちらも効かせず、メッシュは平面のまま静止する（Phase 1と見た目上ほぼ同じになる
// ようFOVを合わせてある。下のBASE_CAMERA_Z/FOV算出のコメント参照）。
const BASE_CAMERA_Z = 5;
let depth3dEnabled = true;
let depthStrengthValue = 0.6; // 疑似深度をどれだけ頂点Zに反映するか（ワールド単位）
let dollyAmplitudeValue = 0.3; // カメラZの呼吸振幅（ワールド単位）
let dollyPeriodValue = 8; // 呼吸1周期の秒数（要件定義書のマクロ8小節に相当する仮の時間軸。MIDI Clock同期は未実装）
let bgWidthSegments = 1, bgHeightSegments = 1;
let bgDepthValues = null; // Float32Array。頂点ごとの疑似深度(0=手前, 1=奥)。写真読み込み時のみ再計算する

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

  // 旧Phase1のOrthographicCamera（フラスタム±OUTPUT_ASPECT×±1、z=5から見る）と
  // 静止時（ドリーオフセット0・ディスプレイスメント0）にまったく同じ画角になるよう、
  // 縦半分の高さ1・距離BASE_CAMERA_ZからFOVを逆算する。depth3dEnabled=falseのときは
  // これと同じ状態になるので、Phase 1の見た目は保たれる。
  const fovDeg = 2 * Math.atan(1 / BASE_CAMERA_Z) * (180 / Math.PI);
  camera = new THREE.PerspectiveCamera(fovDeg, OUTPUT_ASPECT, 0.1, 20);
  camera.position.z = BASE_CAMERA_Z;

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
  const containerW = els.viewport.clientWidth || 1;
  const containerH = els.viewport.clientHeight || 1;

  // 出力フレームは常に16:9固定。実際のブラウザ/パネル幅がそれと違う形でも、
  // レンダラーのサイズ自体をコンテナの中に収まる最大の16:9矩形に決める
  // （#viewportがflexで中央寄せするので、余った分は上下または左右の黒帯になる）。
  let w, h;
  if (containerW / containerH > OUTPUT_ASPECT) {
    h = containerH;
    w = Math.round(h * OUTPUT_ASPECT);
  } else {
    w = containerW;
    h = Math.round(w / OUTPUT_ASPECT);
  }
  renderer.setSize(w, h);
  composer.setSize(w, h);

  // カメラのFOV/アスペクトは常に16:9固定の定数（initRendererで設定済み）で、
  // 写真側のアスペクト比にもコンテナの実際の形にも依存しない。ここでは
  // レンダラー/コンポーザーの物理サイズだけを16:9矩形に合わせる。

  if (bgMesh) {
    // "contain" fit（CSSのbackground-size:containと同じ）。写真は歪ませず、
    // 全体が必ず16:9フラスタム内に収まるように縮小するので、クロップは一切
    // 発生しない。横長の写真は上下に、縦長の写真は左右に黒帯が出る。
    const scale = Math.min(OUTPUT_ASPECT / currentAspect, 1);
    bgMesh.scale.set(scale, scale, 1);
  }
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

// maskMap のRGBA各チャンネルは、その画素がクラスタ0〜3それぞれに含まれる重み(0-1)。
// 1画素が複数クラスタに属することも許容する（重なりがあれば単純加算）。
// マップが全チャンネル0の場所は写真のまま変化しない。
// ambient breathing（MIDIが無い間の自動揺らぎ）は検証を単純化するためいったん
// オミットしている。その代わり baseLevel という定数のベースラインだけを残している:
// マイナス方向にすると、マップが乗っている場所は待機中は元の写真より暗く沈み、
// 対応するクラスタのNote Onが来たときだけそこから持ち上がる。
const bgFragmentShader = `
  precision mediump float;
  uniform sampler2D map;
  uniform sampler2D maskMap;
  uniform vec4 clusterEnvelope;
  uniform float baseLevel;
  uniform float brightGain;
  varying vec2 vUv;

  vec3 srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

  void main() {
    vec4 tex = texture2D(map, vUv);
    vec3 base = srgbToLinear(tex.rgb);
    vec4 w = texture2D(maskMap, vUv); // r,g,b,a = cluster0..3の重み

    // baseLevel（通常は0以下）は画素が属するクラスタの重み合計ぶんだけ待機中の基準を
    // 沈める。各クラスタのエンベロープ(0以上、ノートオンで立ち上がる)は、そのクラスタの
    // 重みが乗っている場所だけ加算で明るさを持ち上げる。
    float totalWeight = clamp(w.r + w.g + w.b + w.a, 0.0, 1.0);
    float envSum = dot(w, clusterEnvelope);
    float delta = totalWeight * baseLevel + envSum;

    float factor = clamp(1.0 + brightGain * delta, 0.06, 3.5);
    gl_FragColor = vec4(base * factor, tex.a);
  }
`;

// マスクは<canvas>/CanvasTextureではなく生のUint8ArrayからTHREE.DataTextureを作る。
// 2DキャンバスはGPU寄りの実装だと内部でpremultiplied alphaとして画素を保持することが
// あり、アルファ0の画素はRGBも0に潰れてしまう（このプロジェクトで実際に踏んだバグ。
// R1チャンネルだけの単一クラスタ時代はアルファを全画素255にする回避策で対処したが、
// 4クラスタ化でアルファチャンネル自体が実データ＝cluster3の重みになる今、その回避策は
// 使えない）。DataTextureは生バイト列をそのままアップロードするだけで、この往復が
// 一切発生しないため、4チャンネルとも安全にデータとして使える。
function makeMaskTexture(data, w, h) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = true; // 写真側の通常のTexture（flipY既定true）と向きを揃える
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makeEmptyMaskTexture() {
  return makeMaskTexture(new Uint8Array(4), 1, 1); // 1x1・全チャンネル0＝どこにも重みが無い
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

  // ジオメトリは写真自身のアスペクト比のまま（歪みなし）。16:9出力フレームへの
  // コンテインフィット（黒帯・クロップ無し）は resize() 側で bgMesh.scale を掛けて行う。
  // Phase 2のディスプレイスメント用に細分化する（segments=1だと頂点Zをずらせない）。
  ({ widthSegments: bgWidthSegments, heightSegments: bgHeightSegments } = computeDepthGridSegments(currentAspect));
  const geometry = new THREE.PlaneGeometry(currentAspect * 2, 2, bgWidthSegments, bgHeightSegments);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      maskMap: { value: makeEmptyMaskTexture() },
      clusterEnvelope: { value: new THREE.Vector4(0, 0, 0, 0) },
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
  regeneratePseudoDepth(source);
}

function applyMaskData(data, w, h) {
  if (!bgMesh) return;
  const tex = makeMaskTexture(data, w, h);
  bgMesh.material.uniforms.maskMap.value?.dispose();
  bgMesh.material.uniforms.maskMap.value = tex;
}

// ============================================================
// Phase 2: 疑似深度によるディスプレイスメント（実験的）
//
// 本物の深度推定（Depth Anything V2 等、要件定義書 §4）はこのブラウザ環境には無いため、
// ひとまず「画面のY位置＋輝度」から疑似的な深度勾配を作って代用している。
// - Y位置が主: 画面下ほど手前（depth小）、上ほど奥（depth大）。輝度マップのクラスタ
//   割り当て（extractLuminanceMask）と同じ向きの簡易的な「奥行きの代用」。
// - 輝度は従: 明るい画素（ネオン等）はわずかに手前へ引く（depthを少し減らす）。
// generatePseudoDepthGrid() の中身だけを本物の深度マップ（batch/の出力や手動読み込みの
// 16bit PNG）に差し替えれば、以降のジオメトリ・カメラ側は無改造で使えるように分離している。
// ============================================================

// ディスプレイスメント用メッシュの分割数。写真のアスペクト比に合わせて縦分割数を決める
// （横分割数は固定）。細かすぎると頂点コストが無駄に増えるので、荒いグリッドに留める。
const DEPTH_GRID_WIDTH_SEGMENTS = 48;

function computeDepthGridSegments(aspect) {
  const widthSegments = DEPTH_GRID_WIDTH_SEGMENTS;
  const heightSegments = Math.max(12, Math.min(64, Math.round(widthSegments / aspect)));
  return { widthSegments, heightSegments };
}

// 頂点グリッド（(widthSegments+1) × (heightSegments+1)）と同じ解像度まで写真を縮小して
// サンプリングし、各頂点に対応する疑似深度(0=手前 〜 1=奥)を1個ずつ求める。
// THREE.PlaneGeometryの頂点順序（iy=0が上端、各行はixが0→widthSegmentsの順）に
// 合わせてあるので、返した配列はそのまま position.setZ(i, ...) の添字で使える。
function generatePseudoDepthGrid(source, widthSegments, heightSegments) {
  const gw = widthSegments + 1;
  const gh = heightSegments + 1;
  const canvas = document.createElement('canvas');
  canvas.width = gw;
  canvas.height = gh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, gw, gh);
  const { data } = ctx.getImageData(0, 0, gw, gh);

  const values = new Float32Array(gw * gh);
  for (let iy = 0; iy < gh; iy++) {
    const fromBottom = 1 - iy / heightSegments; // 0(下端)〜1(上端)。extractLuminanceMaskのfromBottomと同じ向き
    for (let ix = 0; ix < gw; ix++) {
      const i = iy * gw + ix;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      // 奥行きの主成分はY位置そのもの（上ほど奥＝depth大）。輝度は従成分として、明るい画素を
      // 少しだけ手前に引く（ネオン等が浮き上がって見えるように、depthを少し減らす）。
      let d = fromBottom - luma * 0.25;
      values[i] = Math.min(1, Math.max(0, d));
    }
  }
  return values;
}

// 写真読み込み時にのみ呼ぶ（重いサンプリングを含むため）。depth-strengthスライダーや
// 3Dトグルの変更では再サンプリングせず、reapplyDepthStrength() が既存の値を使い回す。
function regeneratePseudoDepth(source) {
  if (!bgMesh) return;
  bgDepthValues = generatePseudoDepthGrid(source, bgWidthSegments, bgHeightSegments);
  reapplyDepthStrength();
}

// bgDepthValues（0=手前〜1=奥）を現在の実効ストレングスでジオメトリの頂点Zに反映する。
// カメラはZ+側を向いて原点方向を見ているので、奥に押すほどZを負方向にずらす。
// depth3dEnabled=falseのときは実効ストレングス0＝メッシュは完全に平面（Phase 1と同じ）。
function reapplyDepthStrength() {
  if (!bgMesh || !bgDepthValues) return;
  const strength = depth3dEnabled ? depthStrengthValue : 0;
  const pos = bgMesh.geometry.attributes.position;
  for (let i = 0; i < bgDepthValues.length; i++) {
    pos.setZ(i, -bgDepthValues[i] * strength);
  }
  pos.needsUpdate = true;
}

// ============================================================
// Luminance map extraction（要件定義書 §4 の簡易版・ブラウザ内実装）
// 検出した画素を4クラスタ（RGBAチャンネル）に振り分けて重みマップに書き込み、
// 各クラスタに紐づくトラックのエンベロープでそれぞれ明滅させる。
//
// 以前は連結成分（塊）検出をしてから重みを付けていたが、閾値の位置次第で
// 「塊はできるのに重みが全部0になる」「塊が画像の半分を覆う」といった
// 縮退ケースを何度も踏んだ。今は塊検出をやめ、各画素ごとに直接
// 「その画素自身の輝度」を重みにする。この式は threshold がどこに来ても
// 数学的に0除算にならず、閾値を超えた画素は必ず何らかの重みを持つ。
// クラスタの割り当ても塊検出には頼らず、閾値を超えた画素全体を対象に
// clusterQualifyingPixels() のk-meansでまとめて分ける（詳細はその関数のコメント参照）。
// ============================================================

// ============================================================
// クラスタリング（要件定義書 §4「クラスタリング軸：深度を主、画面上のXY座標を従とする」）
//
// 以前は単純に画面のY位置だけで4等分していた（画面下からの割合をそのままクラスタ番号に
// 変換するだけ）。これだとXY座標をまったく見ておらず、例えば横に並んだ光点群が同じ高さに
// あるだけで別の被写体でも1クラスタに混ざってしまう。ここでは深度（疑似）を主軸、
// 画面上のXY座標を従軸にした重み付きk-meansで、実際の光点の集まり方に沿って分ける。
// ============================================================

const CLUSTER_DEPTH_WEIGHT = 1; // 主軸
const CLUSTER_XY_WEIGHT = 0.35; // 従軸（深度より弱く効かせる）
const CLUSTER_KMEANS_ITERATIONS = 8;

// generatePseudoDepthGrid()と同じ考え方（画面下ほど手前・輝度が高いほど少し手前）を、
// クラスタリング対象の画素1つに直接適用する簡易値。ジオメトリ用のグリッドとは解像度が
// 異なるので別関数にしてあるが、式そのものは共通。
function pixelPseudoDepth(normY, luma01) {
  const fromBottom = 1 - normY;
  return Math.min(1, Math.max(0, fromBottom - luma01 * 0.25));
}

// qualifying画素（{x, y, depth}を正規化座標で持つ）をk個のクラスタに分ける。
// 乱数は使わず、深度でソートして等間隔に選んだ点を初期セントロイドにするので、
// 同じ入力なら常に同じクラスタリング結果になる（再現性のため）。
// 戻り値は points と同じ順序・長さのクラスタ番号配列（深度が浅い＝手前の群から
// 0,1,2...と振り直してあるので、cluster0が最も手前になる。config側のKICK=cluster0の
// 慣習に合わせるため）。
function clusterQualifyingPixels(points, k) {
  const n = points.length;
  if (n === 0) return new Int32Array(0);
  const kEff = Math.min(k, n);

  const sorted = points.slice().sort((a, b) => a.depth - b.depth);
  const centroids = [];
  for (let i = 0; i < kEff; i++) {
    const idx = kEff === 1 ? 0 : Math.round((i * (n - 1)) / (kEff - 1));
    const p = sorted[idx];
    centroids.push({ depth: p.depth, x: p.x, y: p.y });
  }

  const assign = new Int32Array(n);
  for (let iter = 0; iter < CLUSTER_KMEANS_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) {
      const p = points[i];
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const cc = centroids[c];
        const dd = (p.depth - cc.depth) * CLUSTER_DEPTH_WEIGHT;
        const dx = (p.x - cc.x) * CLUSTER_XY_WEIGHT;
        const dy = (p.y - cc.y) * CLUSTER_XY_WEIGHT;
        const dist = dd * dd + dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      assign[i] = best;
    }
    const sums = centroids.map(() => ({ depth: 0, x: 0, y: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]];
      s.depth += points[i].depth; s.x += points[i].x; s.y += points[i].y; s.count++;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c].count === 0) continue; // 空クラスタはセントロイドを動かさずそのまま次のイテレーションへ
      centroids[c].depth = sums[c].depth / sums[c].count;
      centroids[c].x = sums[c].x / sums[c].count;
      centroids[c].y = sums[c].y / sums[c].count;
    }
  }

  // 深度の平均が小さい順（＝手前順）に0,1,2...と振り直す。
  const order = centroids
    .map((c, idx) => ({ idx, depth: c.depth }))
    .sort((a, b) => a.depth - b.depth)
    .map((o) => o.idx);
  const remap = new Int32Array(centroids.length);
  order.forEach((origIdx, rank) => { remap[origIdx] = rank; });

  const result = new Int32Array(n);
  for (let i = 0; i < n; i++) result[i] = remap[assign[i]];
  return result;
}

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

  // RGBAの生バッファに直接書き込む（<canvas>のImageData/putImageDataは経由しない）。
  // 詳しくは makeMaskTexture() 側のコメント参照: 2Dキャンバス経由だとpremultiplied
  // alphaでRGBが消えるリスクがあるが、Uint8Arrayを直接THREE.DataTextureに渡せば
  // そのリスクが無い。
  const maskData = new Uint8Array(n * 4);

  // 閾値を超えた画素をいったん集めてから、まとめてクラスタリングする（クラスタ番号は
  // 画素ごとのY位置だけでは決まらないので、全体を見てからでないと割り当てられない）。
  const qualifyingPoints = [];
  for (let y = 0; y < h; y++) {
    const normY = y / Math.max(1, h - 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (luma[i] < threshold) continue;
      const luma01 = luma[i] / 255;
      qualifyingPoints.push({
        i,
        x: x / Math.max(1, w - 1),
        y: normY,
        depth: pixelPseudoDepth(normY, luma01),
        // 重みは画素自身の輝度（0-255を0-1に正規化）で決める。thresholdからの
        // 距離ではないので、thresholdが255付近になっても0除算的に潰れない。
        // 最低でも0.35は確保し、閾値ぎりぎりの画素も見えるようにする。
        weight: Math.min(1, Math.max(0.35, luma01)),
      });
    }
  }

  const clusterOf = clusterQualifyingPixels(qualifyingPoints, CLUSTER_COUNT);
  qualifyingPoints.forEach((p, idx) => {
    maskData[p.i * 4 + clusterOf[idx]] = Math.round(p.weight * 255);
  });

  const qualifying = qualifyingPoints.length;
  return { maskData, maskW: w, maskH: h, coveragePercent: (100 * qualifying) / n, threshold };
}

// 手作業の points.json (mask-editor/ 製) を、同じ4チャンネル(RGBA)の重みマップに焼き直す。
// mask-editor は0-7のクラスタを持てるが、輝度マップは4チャンネルしか無いので
// cluster % CLUSTER_COUNT で折り返す（mask-editor自身も色選択で同じ折り返しをしている）。
function pointsToMaskData(points, naturalW, naturalH, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));
  const maskData = new Uint8Array(w * h * 4);
  const radius = Math.max(3, Math.round(Math.min(w, h) * 0.025));

  for (const p of points) {
    const cluster = ((p.cluster ?? 0) % CLUSTER_COUNT + CLUSTER_COUNT) % CLUSTER_COUNT;
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
        const idx = (y * w + x) * 4 + cluster;
        const v = Math.round(weight * 255);
        if (v > maskData[idx]) maskData[idx] = v;
      }
    }
  }
  return { maskData, maskW: w, maskH: h };
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
  const { maskData, maskW, maskH, coveragePercent, threshold } = result;
  applyMaskData(maskData, maskW, maskH);
  lastMaskInfo = { coveragePercent, threshold };
  const ms = Math.round(performance.now() - t0);

  setExtractStatus(`検出: 画像の${coveragePercent.toFixed(1)}% (輝度閾値 ${threshold} / ${ms}ms)`, coveragePercent === 0 ? 'error' : null);
  if (!silent) showToast(`輝度マップを再生成: 画像の${coveragePercent.toFixed(1)}% (${ms}ms)`, 'ok');
}

// スマホ写真などEXIFの回転情報を持つJPEGは、<img>のnaturalWidth/naturalHeightは
// 補正後（見た目通り）の縦横になる一方、そのままWebGLテクスチャのソースに渡すと
// 補正前の生ピクセル配列がアップロードされてしまうことがあり、その場合
// 「naturalWidth/Heightから計算したアスペクト比」と「実際にGPUへ送られる画素の
// アスペクト比」がズレて、写真が変な比率に歪んで見える（横に伸びる等）。
// <canvas>にdrawImageで焼き直すと、常に見た目通り・補正後の画素で確定するので、
// このズレが原理的に起こらなくなる。
function toNormalizedCanvas(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return canvas;
}

els.photoInput.addEventListener('change', () => {
  const file = els.photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      loadedImageW = img.naturalWidth;
      loadedImageH = img.naturalHeight;
      loadedImageEl = toNormalizedCanvas(img);
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
      const { maskData, maskW, maskH } = pointsToMaskData(data.points, loadedImageW, loadedImageH, 700);
      applyMaskData(maskData, maskW, maskH);
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
// kickEntryIndices は mapping.notes と同じindex空間なので、clusterNoteEnvelopes に
// 直接書き込めば、それがどのクラスタに属していても tick() 側で自然に拾われる。
function triggerKick(velocity) {
  const now = performance.now() / 1000;
  kickEntryIndices.forEach((i) => {
    clusterNoteEnvelopes[i].value = velocity / 127;
    clusterNoteEnvelopes[i].start = now;
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
    // 全 cluster_trigger エントリを見る（kickEntryIndicesはデバッグボタン専用）。
    mapping.notes.forEach((n, i) => {
      if (n.role === 'cluster_trigger' && n.channel === ch && n.note === d1) {
        clusterNoteEnvelopes[i].value = d2 / 127;
        clusterNoteEnvelopes[i].start = performance.now() / 1000;
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

  for (let c = 0; c < CLUSTER_COUNT; c++) {
    let maxV = 0;
    clusterEntryIndices[c].forEach((i) => {
      const n = mapping.notes[i];
      const e = clusterNoteEnvelopes[i];
      if (e.start === 0) return;
      const v = e.value * Math.exp(-(now - e.start) / (n.tau || 0.15));
      if (v > maxV) maxV = v;
    });
    clusterEnvelope[c] = maxV;
  }
  updateMeters();

  // Phase 2: dolly_in（カメラZの呼吸）。MIDI Clockへの位相同期は未実装のため、
  // 単純な時間ベースのサイン波。振幅・周期はサイドバーのスライダーで調整できる
  // （振幅を上げすぎると疑似深度の粗さ・破綻が見えやすくなるので小さめが基本）。
  camera.position.z = depth3dEnabled
    ? BASE_CAMERA_Z + Math.sin((2 * Math.PI * now) / dollyPeriodValue) * dollyAmplitudeValue
    : BASE_CAMERA_Z;

  if (bgMesh) {
    bgMesh.material.uniforms.clusterEnvelope.value.set(
      clusterEnvelope[0], clusterEnvelope[1], clusterEnvelope[2], clusterEnvelope[3]
    );
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
els.depth3dToggle.checked = depth3dEnabled;
els.depth3dToggle.addEventListener('change', () => {
  depth3dEnabled = els.depth3dToggle.checked;
  reapplyDepthStrength();
});
wireSlider(els.depthStrength, els.depthStrengthVal, (v) => {
  depthStrengthValue = v;
  reapplyDepthStrength();
}, 0.6);
wireSlider(els.dollyAmplitude, els.dollyAmplitudeVal, (v) => { dollyAmplitudeValue = v; }, 0.3);
wireSlider(els.dollyPeriod, els.dollyPeriodVal, (v) => { dollyPeriodValue = v; }, 8);
loadMapping();
initMIDI();
tick();
