/* ============================================================
   dashboard.js  —  Live Detection page logic
   Depends on: CLASS_INFO injected by Flask as window.CLASS_INFO
   ============================================================ */

'use strict';

// ── Constants ────────────────────────────────────────────────
const CLASS_COLORS = {
  Blue       : '#3B82F6',
  Red        : '#EF4444',
  Yellow     : '#EAB308',
  White      : '#94A3B8',
  'Non-Waste': '#22C55E'
};
const RISK_CLS = {
  High  : 'risk-high',
  Medium: 'risk-medium',
  Low   : 'risk-low',
  None  : 'risk-none'
};

// Motion detection tuning
const MOTION_THRESHOLD = 18;    // per-channel pixel diff (0–255)
const MOTION_TRIGGER   = 0.04;  // fraction of changed pixels to fire predict
const PREDICT_COOLDOWN = 3000;  // ms min gap between auto predictions

// ── State ────────────────────────────────────────────────────
let stream          = null;
let autoActive      = false;
let isPredicting    = false;
let currentFilter   = null;
let selectedFile    = null;
let motionCanvas    = null;
let motionCtx       = null;
let prevFrame       = null;
let motionRafId     = null;
let lastPredictTime = 0;

// ── Helpers ──────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setBtn(id, disabled) { $(id).disabled = disabled; }

function showToast(msg, type = 'info', duration = 3200) {
  const wrap = $('toasts');
  const t    = document.createElement('div');
  t.className   = `toast ${type}`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.cssText += 'opacity:0;transform:translateX(32px);transition:all .25s';
    setTimeout(() => t.remove(), 260);
  }, duration);
}

// ── WebSocket ────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  $('wsDot').style.background  = '#22C55E';
  $('wsLabel').textContent      = 'Live';
});
socket.on('disconnect', () => {
  $('wsDot').style.background  = '#EF4444';
  $('wsLabel').textContent      = 'Disconnected';
});
socket.on('high_risk_alert', d => {
  showToast(`⚠️ HIGH RISK: ${d.class} (${d.confidence}%)`, 'risk', 6000);
});
socket.on('history_cleared', () => {
  loadHistory();
  showToast('🗑️ History cleared', 'info');
});

// ── Camera Controls ──────────────────────────────────────────
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    const video      = $('videoEl');
    video.srcObject  = stream;
    video.style.display = 'block';
    $('camPlaceholder').style.display = 'none';
    $('camOverlay').style.display     = 'block';

    // Hidden low-res canvas for motion diff
    motionCanvas        = document.createElement('canvas');
    motionCanvas.width  = 160;
    motionCanvas.height = 120;
    motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
    prevFrame = null;

    setBtn('btnStart',   true);
    setBtn('btnStop',    false);
    setBtn('btnPredict', false);
    setBtn('btnAuto',    false);
    showToast('📷 Camera started', 'success');
  } catch (e) {
    showToast('❌ Camera error: ' + e.message, 'risk');
  }
}

function stopCamera() {
  stopAuto();
  if (stream)      { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (motionRafId) { cancelAnimationFrame(motionRafId); motionRafId = null; }
  prevFrame = null;

  $('videoEl').style.display        = 'none';
  $('camPlaceholder').style.display = 'flex';
  $('camOverlay').style.display     = 'none';
  $('motionBarWrap').classList.remove('show');

  setBtn('btnStart',    false);
  setBtn('btnStop',     true);
  setBtn('btnPredict',  true);
  setBtn('btnAuto',     true);
  setBtn('btnAutoStop', true);
  showToast('⏹ Camera stopped', 'info');
}

// ── Auto Predict (Motion-Based) ──────────────────────────────
function toggleAuto() {
  autoActive ? stopAuto() : startAuto();
}

function startAuto() {
  if (!stream) return;
  autoActive = true;
  $('btnAuto').className = 'cbtn cbtn-auto auto-on';
  $('btnAuto').innerHTML = '🤖 Auto: ON';
  setBtn('btnAutoStop', false);
  $('motionBarWrap').classList.add('show');
  $('autoStatusPill').textContent = 'ON — Motion';
  showToast('🤖 Auto Predict ON — watching for new objects…', 'warn');
  runMotionLoop();
}

function stopAuto() {
  autoActive = false;
  if (motionRafId) { cancelAnimationFrame(motionRafId); motionRafId = null; }
  prevFrame = null;

  $('btnAuto').className = 'cbtn cbtn-auto auto-off';
  $('btnAuto').innerHTML = '🤖 Auto Predict';
  setBtn('btnAutoStop', true);
  $('motionBarWrap').classList.remove('show');
  $('autoStatusPill').textContent  = 'OFF';
  $('motionBadge').textContent     = 'MOTION: —';
  $('motionBadge').className       = 'motion-badge idle';
}

function runMotionLoop() {
  if (!autoActive || !stream) return;

  const video = $('videoEl');
  if (video.readyState < 2) {
    motionRafId = requestAnimationFrame(runMotionLoop);
    return;
  }

  // Sample small frame
  motionCtx.drawImage(video, 0, 0, 160, 120);
  const curr = motionCtx.getImageData(0, 0, 160, 120);

  if (prevFrame) {
    let changed = 0;
    const total = curr.data.length / 4;
    for (let i = 0; i < curr.data.length; i += 4) {
      const dr = Math.abs(curr.data[i]   - prevFrame[i]);
      const dg = Math.abs(curr.data[i+1] - prevFrame[i+1]);
      const db = Math.abs(curr.data[i+2] - prevFrame[i+2]);
      if ((dr + dg + db) / 3 > MOTION_THRESHOLD) changed++;
    }

    const motionLevel = changed / total;
    const pct = Math.min(100, (motionLevel / 0.5) * 100).toFixed(0);

    $('motionFill').style.width    = Math.min(100, motionLevel * 200) + '%';
    $('motionPct').textContent     = pct + '%';

    const now = Date.now();
    if (motionLevel >= MOTION_TRIGGER && (now - lastPredictTime) > PREDICT_COOLDOWN && !isPredicting) {
      $('motionBadge').textContent = 'DETECTED!';
      $('motionBadge').className   = 'motion-badge active';
      lastPredictTime = now;
      predictFromCamera();
      setTimeout(() => {
        if (autoActive) {
          $('motionBadge').textContent = 'WATCHING…';
          $('motionBadge').className   = 'motion-badge idle';
        }
      }, 2000);
    } else if (motionLevel < MOTION_TRIGGER * 0.5) {
      $('motionBadge').textContent = 'WATCHING…';
      $('motionBadge').className   = 'motion-badge idle';
    }
  }

  prevFrame   = new Uint8Array(curr.data);
  // ~10 fps — lightweight
  motionRafId = setTimeout(() => { motionRafId = requestAnimationFrame(runMotionLoop); }, 100);
}

// ── Prediction ───────────────────────────────────────────────
function predictOnce() { predictFromCamera(); }

function captureFrame() {
  const video = $('videoEl');
  const cv    = $('canvasEl');
  cv.width    = 224;
  cv.height   = 224;
  cv.getContext('2d').drawImage(video, 0, 0, 224, 224);
  return cv.toDataURL('image/jpeg', 0.88);
}

async function predictFromCamera() {
  if (!stream || isPredicting) return;
  await runPrediction(captureFrame());
}

async function predictFromFile() {
  if (!selectedFile || isPredicting) return;
  const reader = new FileReader();
  reader.onload = async e => await runPrediction(e.target.result);
  reader.readAsDataURL(selectedFile);
}

async function runPrediction(b64) {
  isPredicting = true;
  try {
    const res = await fetch('/api/predict', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ image: b64 })
    });
    if (!res.ok) {
      const err = await res.json();
      showToast('⚠️ ' + err.error, 'risk');
      return;
    }
    const data = await res.json();
    renderResult(data);
    loadHistory();
  } catch (e) {
    showToast('❌ Prediction failed: ' + e.message, 'risk');
  } finally {
    isPredicting = false;
  }
}

function renderResult(d) {
  $('resultEmpty').style.display = 'none';
  const card  = $('resultCard');
  card.style.display = 'block';

  const info  = CLASS_INFO[d.class] || {};
  const color = CLASS_COLORS[d.class] || '#94A3B8';

  card.style.borderTopColor = color;
  card.style.borderTopWidth = '3px';

  $('resClass').textContent    = d.class;
  $('resClass').style.color    = color;
  $('resIcon').textContent     = info.icon || '';
  $('resDesc').textContent     = info.desc || '';

  const badge       = $('resBadge');
  badge.textContent = (info.risk || 'N/A') + ' Risk';
  badge.className   = 'risk-badge ' + (RISK_CLS[info.risk] || 'risk-none');

  const conf        = d.confidence;
  $('resConf').textContent   = conf + '%';
  const fill        = $('confFill');
  fill.style.width  = conf + '%';
  fill.style.background =
    conf >= 90 ? 'linear-gradient(90deg,#22C55E,#4ADE80)' :
    conf >= 75 ? 'linear-gradient(90deg,#3B82F6,#60A5FA)' :
                 'linear-gradient(90deg,#EAB308,#FDE047)';

  $('confWarn').style.display = d.low_confidence ? 'flex' : 'none';

  const alertEl = $('alertBanner');
  if (d.alert) { alertEl.textContent = d.alert; alertEl.style.display = 'block'; }
  else           alertEl.style.display = 'none';

  // Per-class probability bars
  const probsEl = $('allProbs');
  probsEl.innerHTML = '';
  Object.entries(d.all_probabilities || {})
    .sort((a, b) => b[1] - a[1])
    .forEach(([cls, pct]) => {
      const c = CLASS_COLORS[cls] || '#94A3B8';
      probsEl.innerHTML += `
        <div class="prob-row">
          <span class="prob-name">${CLASS_INFO[cls]?.icon || ''} ${cls}</span>
          <div class="prob-mini"><div class="prob-fill" style="width:${pct}%;background:${c}"></div></div>
          <span class="prob-pct" style="color:${c}">${pct.toFixed(1)}%</span>
        </div>`;
    });

  $('resTime').textContent = '🕐 ' + new Date(d.timestamp).toLocaleString();
}

// ── Upload ───────────────────────────────────────────────────
function onDragOver(e) {
  e.preventDefault();
  $('uploadZone').classList.add('drag-over');
}
function onDrop(e) {
  e.preventDefault();
  $('uploadZone').classList.remove('drag-over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
}
function onFileSelect(e) {
  if (e.target.files[0]) setFile(e.target.files[0]);
}
function setFile(f) {
  selectedFile = f;
  const reader = new FileReader();
  reader.onload = e => {
    const img  = $('previewImg');
    img.src    = e.target.result;
    img.style.display = 'block';
  };
  reader.readAsDataURL(f);
  $('btnUpload').disabled = false;
}
function clearUpload() {
  selectedFile = null;
  $('previewImg').style.display = 'none';
  $('fileInput').value          = '';
  $('btnUpload').disabled       = true;
}

// ── Detection History ────────────────────────────────────────
function filterHist(cls, el) {
  currentFilter = cls;
  document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  loadHistory();
}

async function loadHistory() {
  try {
    const url  = '/api/history?limit=80' + (currentFilter ? '&class=' + encodeURIComponent(currentFilter) : '');
    const rows = await (await fetch(url)).json();
    const list = $('histList');
    $('histCount').textContent = rows.length + ' records';

    if (!rows.length) {
      list.innerHTML = '<div class="hist-empty">No records found</div>';
      return;
    }

    list.innerHTML = rows.map(r => {
      const color = r.color || CLASS_COLORS[r.class_name] || '#94A3B8';
      const icon  = r.icon  || CLASS_INFO[r.class_name]?.icon || '📦';
      const label = r.label || r.class_name;
      const time  = new Date(r.timestamp).toLocaleTimeString();
      const date  = new Date(r.timestamp).toLocaleDateString();
      return `
        <div class="hist-item" style="border-left:3px solid ${color}">
          <span class="hist-icon">${icon}</span>
          <div class="hist-info">
            <div class="hist-class">${label}</div>
            <div class="hist-time">${date} · ${time} · ${r.user || 'N/A'}</div>
          </div>
          <div class="hist-conf" style="color:${color}">${r.confidence}%</div>
        </div>`;
    }).join('');
  } catch (e) {
    console.error('History load error:', e);
  }
}

// ── Auth ─────────────────────────────────────────────────────


// ── Init ─────────────────────────────────────────────────────
loadHistory();
setInterval(loadHistory, 15000);
