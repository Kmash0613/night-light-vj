// Phase 1: 光点マスク・エディタ
// 写真をクリックして光点を手作業で配置し、points.json として書き出す。
// 画像はブラウザ内だけで処理され、どこにも送信されない。

const CLUSTER_COLORS = ['#ffb74d', '#ff7a59', '#6fb7e0', '#c792ea', '#6fcf97', '#ff8fc7', '#f2c94c', '#4dd0c4'];
const MAX_DISPLAY_WIDTH = 1000;

const els = {
  photoInput: document.getElementById('photo-input'),
  undoBtn: document.getElementById('undo-btn'),
  clearBtn: document.getElementById('clear-btn'),
  exportBtn: document.getElementById('export-btn'),
  wrap: document.getElementById('canvas-wrap'),
  empty: document.getElementById('canvas-empty'),
  stage: document.getElementById('stage'),
  clusterPicker: document.getElementById('cluster-picker'),
  countList: document.getElementById('count-list'),
};

const stageCtx = els.stage.getContext('2d');
const imageCanvas = document.createElement('canvas'); // full-resolution copy, for accurate color sampling
const imageCtx = imageCanvas.getContext('2d', { willReadFrequently: true });

let img = null;
let points = []; // {x, y, color:[r,g,b], cluster}
let activeCluster = 0;

function showToast(text, kind) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast show ${kind || ''}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// --- Cluster picker ---

function buildClusterPicker() {
  els.clusterPicker.innerHTML = '';
  CLUSTER_COLORS.forEach((color, i) => {
    const btn = document.createElement('button');
    btn.className = `cluster-btn${i === activeCluster ? ' active' : ''}`;
    btn.innerHTML = `<span class="dot" style="background:${color}"></span>cluster ${i}`;
    btn.addEventListener('click', () => {
      activeCluster = i;
      buildClusterPicker();
    });
    els.clusterPicker.appendChild(btn);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key >= '0' && e.key <= '7') {
    activeCluster = Number(e.key);
    buildClusterPicker();
  }
});

// --- Photo loading ---

els.photoInput.addEventListener('change', () => {
  const file = els.photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      img = image;
      points = [];
      imageCanvas.width = img.naturalWidth;
      imageCanvas.height = img.naturalHeight;
      imageCtx.drawImage(img, 0, 0);

      const scale = Math.min(1, MAX_DISPLAY_WIDTH / img.naturalWidth);
      els.stage.width = Math.round(img.naturalWidth * scale);
      els.stage.height = Math.round(img.naturalHeight * scale);
      els.stage.hidden = false;
      els.empty.hidden = true;
      redraw();
      renderCounts();
      showToast(`読み込みました: ${img.naturalWidth}×${img.naturalHeight}`, 'ok');
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// --- Drawing ---

function redraw() {
  if (!img) return;
  stageCtx.clearRect(0, 0, els.stage.width, els.stage.height);
  stageCtx.drawImage(img, 0, 0, els.stage.width, els.stage.height);
  for (const p of points) {
    const x = p.x * els.stage.width;
    const y = p.y * els.stage.height;
    stageCtx.beginPath();
    stageCtx.arc(x, y, 6, 0, Math.PI * 2);
    stageCtx.fillStyle = CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length];
    stageCtx.globalAlpha = 0.85;
    stageCtx.fill();
    stageCtx.globalAlpha = 1;
    stageCtx.lineWidth = 1.5;
    stageCtx.strokeStyle = 'rgba(7,9,17,0.9)';
    stageCtx.stroke();
  }
}

function renderCounts() {
  els.countList.innerHTML = '';
  const counts = new Array(CLUSTER_COLORS.length).fill(0);
  for (const p of points) counts[p.cluster % CLUSTER_COLORS.length] += 1;
  const total = points.length;
  const totalRow = document.createElement('div');
  totalRow.className = 'item';
  totalRow.innerHTML = `<span>合計</span><span class="n">${total}</span>`;
  els.countList.appendChild(totalRow);
  counts.forEach((n, i) => {
    if (n === 0) return;
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<span class="dot" style="background:${CLUSTER_COLORS[i]}"></span><span>cluster ${i}</span><span class="n">${n}</span>`;
    els.countList.appendChild(row);
  });
}

// --- Interaction ---

els.stage.addEventListener('click', (evt) => {
  if (!img) return;
  const rect = els.stage.getBoundingClientRect();
  const px = (evt.clientX - rect.left) * (els.stage.width / rect.width);
  const py = (evt.clientY - rect.top) * (els.stage.height / rect.height);
  const nx = Math.min(1, Math.max(0, px / els.stage.width));
  const ny = Math.min(1, Math.max(0, py / els.stage.height));

  const sx = Math.min(imageCanvas.width - 1, Math.round(nx * imageCanvas.width));
  const sy = Math.min(imageCanvas.height - 1, Math.round(ny * imageCanvas.height));
  const [r, g, b] = imageCtx.getImageData(sx, sy, 1, 1).data;

  points.push({ x: nx, y: ny, color: [r, g, b], cluster: activeCluster });
  redraw();
  renderCounts();
});

els.undoBtn.addEventListener('click', () => {
  points.pop();
  redraw();
  renderCounts();
});

els.clearBtn.addEventListener('click', () => {
  if (points.length && !confirm(`${points.length}個の光点をすべて削除しますか？`)) return;
  points = [];
  redraw();
  renderCounts();
});

els.exportBtn.addEventListener('click', () => {
  if (!img) {
    showToast('先に写真を読み込んでください', 'error');
    return;
  }
  const data = {
    _comment: '手作業で配置した光点マスク（Phase 1）。x/yは画像に対する相対値(0-1、左上原点)。',
    generated_at: new Date().toISOString(),
    image: { width: img.naturalWidth, height: img.naturalHeight },
    points,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `points-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`書き出しました: ${points.length}点`, 'ok');
});

buildClusterPicker();
renderCounts();
