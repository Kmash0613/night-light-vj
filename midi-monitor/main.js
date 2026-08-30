// Phase 0: SEQTRAK MIDI Monitor
// Web MIDI API で受信した全メッセージをログ出力し、チャンネル/ノート/CC番号を実測する。
// 要件定義書 §9 Phase 0 に対応。

const els = {
  select: document.getElementById('input-select'),
  refresh: document.getElementById('refresh-btn'),
  status: document.getElementById('status'),
  clear: document.getElementById('clear-btn'),
  exportLog: document.getElementById('export-log-btn'),
  exportCsv: document.getElementById('export-csv-btn'),
  exportMapping: document.getElementById('export-mapping-btn'),
  pauseClock: document.getElementById('pause-clock'),
  pauseLog: document.getElementById('pause-log'),
  count: document.getElementById('msg-count'),
  log: document.getElementById('log'),
  summaryBody: document.querySelector('#summary-table tbody'),
};

let midiAccess = null;
let currentInput = null;
const rawLog = []; // {t, ch, type, data1, data2, raw}
// key -> { type, ch, num, count, min, max, last, trackName }
const summary = new Map();

const MAX_LOG_LINES = 4000;

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status status-${kind}`;
}

function noteName(n) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(n / 12) - 1;
  return `${names[n % 12]}${octave}`;
}

function classify(status) {
  const hi = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  switch (status) {
    case 0xf8: return { type: 'clock', ch: null };
    case 0xfa: return { type: 'start', ch: null };
    case 0xfb: return { type: 'continue', ch: null };
    case 0xfc: return { type: 'stop', ch: null };
    case 0xf2: return { type: 'spp', ch: null };
    case 0xf1: return { type: 'mtc', ch: null };
    case 0xf6: return { type: 'tune_request', ch: null };
  }
  switch (hi) {
    case 0x80: return { type: 'note_off', ch };
    case 0x90: return { type: 'note_on', ch };
    case 0xa0: return { type: 'poly_at', ch };
    case 0xb0: return { type: 'cc', ch };
    case 0xc0: return { type: 'program_change', ch };
    case 0xd0: return { type: 'channel_at', ch };
    case 0xe0: return { type: 'pitch_bend', ch };
    default: return { type: 'other', ch };
  }
}

function summaryKey(type, ch, num) {
  return `${type}|${ch}|${num}`;
}

function updateSummary(entry) {
  const { type, ch, data1, data2 } = entry;
  // Only summarize per-note/per-CC message types; transport/clock skipped.
  if (!['note_on', 'note_off', 'cc', 'poly_at'].includes(type)) return;
  const num = data1;
  const val = data2 ?? 0;
  const key = summaryKey(type, ch, num);
  let row = summary.get(key);
  if (!row) {
    row = { type, ch, num, count: 0, min: val, max: val, last: entry.t, trackName: '' };
    summary.set(key, row);
  }
  row.count += 1;
  row.min = Math.min(row.min, val);
  row.max = Math.max(row.max, val);
  row.last = entry.t;
  renderSummaryRow(key, row);
}

let summaryRows = new Map(); // key -> <tr>

function renderSummaryRow(key, row) {
  let tr = summaryRows.get(key);
  if (!tr) {
    tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="c-type"></td>
      <td class="c-ch"></td>
      <td class="c-num"></td>
      <td class="c-count"></td>
      <td class="c-min"></td>
      <td class="c-max"></td>
      <td class="c-last"></td>
      <td><input type="text" class="c-name" placeholder="例: KICK"></td>
    `;
    const nameInput = tr.querySelector('.c-name');
    nameInput.addEventListener('input', () => {
      row.trackName = nameInput.value;
    });
    els.summaryBody.appendChild(tr);
    summaryRows.set(key, tr);
  }
  const numLabel = row.type === 'note_on' || row.type === 'note_off' || row.type === 'poly_at'
    ? `${row.num} (${noteName(row.num)})`
    : `CC${row.num}`;
  tr.querySelector('.c-type').textContent = row.type;
  tr.querySelector('.c-ch').textContent = row.ch;
  tr.querySelector('.c-num').textContent = numLabel;
  tr.querySelector('.c-count').textContent = row.count;
  tr.querySelector('.c-min').textContent = row.min;
  tr.querySelector('.c-max').textContent = row.max;
  tr.querySelector('.c-last').textContent = row.last.toFixed(2) + 's';
}

function appendLogLine(entry) {
  if (els.pauseLog.checked) return;
  if (entry.type === 'clock' && els.pauseClock.checked) return;

  const div = document.createElement('div');
  div.className = `line ${cssClassFor(entry.type)}`;
  div.textContent = formatLine(entry);
  els.log.appendChild(div);

  while (els.log.children.length > MAX_LOG_LINES) {
    els.log.removeChild(els.log.firstChild);
  }
  els.log.scrollTop = els.log.scrollHeight;
}

function cssClassFor(type) {
  if (type === 'note_on') return 'note-on';
  if (type === 'note_off') return 'note-off';
  if (type === 'cc') return 'cc';
  if (type === 'clock') return 'clock';
  if (['start', 'stop', 'continue'].includes(type)) return 'transport';
  if (type === 'spp') return 'spp';
  return 'other';
}

function formatLine(entry) {
  const t = entry.t.toFixed(3).padStart(8, ' ');
  const ch = entry.ch != null ? `ch${String(entry.ch).padStart(2, '0')}` : '   -';
  let detail;
  switch (entry.type) {
    case 'note_on':
      detail = `NOTE ON  ${entry.data1} (${noteName(entry.data1)})  vel=${entry.data2}`;
      break;
    case 'note_off':
      detail = `NOTE OFF ${entry.data1} (${noteName(entry.data1)})  vel=${entry.data2}`;
      break;
    case 'cc':
      detail = `CC       #${entry.data1}  val=${entry.data2}`;
      break;
    case 'poly_at':
      detail = `POLY AT  ${entry.data1}  val=${entry.data2}`;
      break;
    case 'program_change':
      detail = `PROG CHG ${entry.data1}`;
      break;
    case 'channel_at':
      detail = `CHAN AT  ${entry.data1}`;
      break;
    case 'pitch_bend':
      detail = `PITCH BEND  ${(entry.data2 << 7) | entry.data1}`;
      break;
    case 'clock':
      detail = 'CLOCK';
      break;
    case 'start':
      detail = 'START';
      break;
    case 'stop':
      detail = 'STOP';
      break;
    case 'continue':
      detail = 'CONTINUE';
      break;
    case 'spp':
      detail = `SONG POSITION  ${((entry.data2 << 7) | entry.data1)}`;
      break;
    case 'mtc':
      detail = 'MTC QUARTER FRAME';
      break;
    default:
      detail = `RAW [${entry.raw.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`;
  }
  return `${t}  ${ch}  ${detail}`;
}

const t0 = performance.now();

function onMIDIMessage(msg) {
  const data = msg.data;
  const status = data[0];
  const { type, ch } = classify(status);
  const entry = {
    t: (performance.now() - t0) / 1000,
    type,
    ch,
    data1: data.length > 1 ? data[1] : null,
    data2: data.length > 2 ? data[2] : null,
    raw: Array.from(data),
  };
  rawLog.push(entry);
  els.count.textContent = `${rawLog.length} messages`;
  updateSummary(entry);
  appendLogLine(entry);
}

function populateInputs() {
  const inputs = Array.from(midiAccess.inputs.values());
  els.select.innerHTML = '';
  if (inputs.length === 0) {
    els.select.innerHTML = '<option>MIDI入力デバイスが見つかりません</option>';
    setStatus('MIDI入力が見つかりません。SEQTRAK をUSB接続し、Yamaha Steinberg USB Driver がインストール済みか確認してください。', 'error');
    return;
  }
  inputs.forEach((input, i) => {
    const opt = document.createElement('option');
    opt.value = input.id;
    opt.textContent = `${input.name} (${input.manufacturer || 'unknown'})`;
    els.select.appendChild(opt);
  });
  connectTo(els.select.value);
}

function connectTo(inputId) {
  if (currentInput) {
    currentInput.onmidimessage = null;
  }
  const input = midiAccess.inputs.get(inputId);
  if (!input) return;
  currentInput = input;
  input.onmidimessage = onMIDIMessage;
  setStatus(`接続中: ${input.name}`, 'ok');
}

function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    setStatus('このブラウザは Web MIDI API に対応していません。Chrome を使用してください。', 'error');
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

// --- Export helpers ---

function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportLogJSON() {
  download(`midi-log-${Date.now()}.json`, JSON.stringify(rawLog, null, 2));
}

function exportLogCSV() {
  const header = 't,type,channel,data1,data2,note_name';
  const rows = rawLog.map((e) => [
    e.t.toFixed(4),
    e.type,
    e.ch ?? '',
    e.data1 ?? '',
    e.data2 ?? '',
    (e.type === 'note_on' || e.type === 'note_off') && e.data1 != null ? noteName(e.data1) : '',
  ].join(','));
  download(`midi-log-${Date.now()}.csv`, [header, ...rows].join('\n'), 'text/csv');
}

function exportMappingDraft() {
  // config/midi-mapping.schema.json のスキーマに沿った下書きを、実測データから生成する。
  const tracks = [];
  for (const [, row] of summary) {
    if (row.type !== 'note_on') continue;
    tracks.push({
      name: row.trackName || `track_ch${row.ch}_note${row.num}`,
      channel: row.ch,
      note: row.num,
      velocity_range: [row.min, row.max],
      cluster: null,
      role: null,
      _measured_count: row.count,
    });
  }
  const ccs = [];
  for (const [, row] of summary) {
    if (row.type !== 'cc') continue;
    ccs.push({
      name: row.trackName || `cc_ch${row.ch}_${row.num}`,
      channel: row.ch,
      cc_number: row.num,
      value_range: [row.min, row.max],
      target: null,
      _measured_count: row.count,
    });
  }
  const draft = {
    _comment: 'Phase 0 実測から自動生成された下書き。track/target 等の空欄は手動で埋めること。',
    generated_at: new Date().toISOString(),
    notes: tracks.sort((a, b) => a.channel - b.channel || a.note - b.note),
    control_changes: ccs.sort((a, b) => a.channel - b.channel || a.cc_number - b.cc_number),
  };
  download(`midi-mapping-draft-${Date.now()}.json`, JSON.stringify(draft, null, 2));
}

// --- Wire up UI ---

els.refresh.addEventListener('click', () => initMIDI());
els.select.addEventListener('change', () => connectTo(els.select.value));
els.clear.addEventListener('click', () => {
  rawLog.length = 0;
  summary.clear();
  summaryRows.clear();
  els.summaryBody.innerHTML = '';
  els.log.innerHTML = '';
  els.count.textContent = '0 messages';
});
els.exportLog.addEventListener('click', exportLogJSON);
els.exportCsv.addEventListener('click', exportLogCSV);
els.exportMapping.addEventListener('click', exportMappingDraft);

initMIDI();
