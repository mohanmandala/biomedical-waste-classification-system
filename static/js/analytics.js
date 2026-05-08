/* ============================================================
   analytics.js  —  Analytics Dashboard logic
   Depends on: CLASS_INFO injected by Flask as window.CLASS_INFO
               Chart.js loaded in <head>
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

// ── Chart Defaults ───────────────────────────────────────────
Chart.defaults.color       = 'rgba(255,255,255,0.5)';
Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";

// ── State ────────────────────────────────────────────────────
let doughnutChart = null;
let lineChart     = null;
let barChart      = null;

// ── Helpers ──────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showToast(msg, type = 'info', duration = 3500) {
  const container = $('toasts');
  const toast     = document.createElement('div');
  toast.className   = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function animateCounter(id, target) {
  const el   = $(id);
  let cur    = 0;
  const step = Math.ceil(target / 40) || 1;
  const timer = setInterval(() => {
    cur = Math.min(cur + step, target);
    el.textContent = cur;
    if (cur >= target) clearInterval(timer);
  }, 30);
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  await loadSummary();
  await loadTrend(14, document.querySelector('.day-btn.active'));
  await loadClassReport();
}

// ── KPI Summary ──────────────────────────────────────────────
async function loadSummary() {
  const res = await fetch('/api/analytics/summary');
  const d   = await res.json();

  animateCounter('kpiTotal', d.total);
  animateCounter('kpiToday', d.today);

  // High risk = red + white raw classes
  const highRisk = (d.by_class || [])
    .filter(c => c.class_name === 'red' || c.class_name === 'white')
    .reduce((s, c) => s + c.total, 0);
  animateCounter('kpiHighRisk', highRisk);

  // Top class
  const top = [...(d.by_class || [])].sort((a, b) => b.total - a.total)[0];
  if (top) {
    $('kpiTopClass').textContent    = (top.label || top.class_name);
    $('kpiTopClassSub').textContent = top.total + ' detections';
  }

  // Weighted average confidence
  const byClass = d.by_class || [];
  if (byClass.length > 0) {
    const totalW  = byClass.reduce((s, c) => s + c.total, 0);
    const avgConf = totalW > 0
      ? byClass.reduce((s, c) => s + c.avg_confidence * c.total, 0) / totalW
      : 0;
    $('kpiAvgConf').textContent = avgConf.toFixed(1) + '%';
  }

  renderDoughnut(byClass);
  renderBar(byClass);
}

// ── Doughnut Chart ───────────────────────────────────────────
function renderDoughnut(byClass) {
  // Use label (display name) for chart, raw class name for color lookup
  const labels = byClass.map(c => c.label || c.class_name);
  const values = byClass.map(c => c.total);
  const colors = byClass.map(c => CLASS_COLORS[c.label] || c.color || '#94A3B8');

  if (doughnutChart) doughnutChart.destroy();

  doughnutChart = new Chart($('doughnutChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data           : values,
        backgroundColor: colors.map(c => c + 'CC'),
        borderColor    : colors,
        borderWidth    : 2,
        hoverOffset    : 8
      }]
    },
    options: {
      responsive        : true,
      maintainAspectRatio: false,
      cutout            : '65%',
      plugins: {
        legend : { position: 'right', labels: { padding: 16, usePointStyle: true, pointStyleWidth: 10, font: { size: 12 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} (${((ctx.raw / ctx.dataset.data.reduce((a, b) => a + b, 0)) * 100).toFixed(1)}%)` } }
      }
    }
  });
}

// ── Bar Chart ────────────────────────────────────────────────
function renderBar(byClass) {
  // Order by display label
  const ORDER = ['Blue', 'Red', 'Yellow', 'White', 'Non-Waste'];
  const data  = ORDER.map(label => {
    const found = byClass.find(b => (b.label || b.class_name) === label);
    return found ? found.avg_confidence : 0;
  });
  const colors = ORDER.map(c => CLASS_COLORS[c] + 'CC');

  if (barChart) barChart.destroy();

  barChart = new Chart($('barChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels  : ORDER.map(c => (CLASS_INFO[c]?.icon || '') + ' ' + c),
      datasets: [{
        label          : 'Avg Confidence (%)',
        data,
        backgroundColor: colors,
        borderColor    : ORDER.map(c => CLASS_COLORS[c]),
        borderWidth    : 1,
        borderRadius   : 8,
        borderSkipped  : false
      }]
    },
    options: {
      responsive        : true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,.05)' } }
      },
      plugins: {
        legend : { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)}% confidence` } }
      }
    }
  });
}

// ── Line Chart (Daily Trend) ─────────────────────────────────
async function loadTrend(days, el) {
  document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');

  const res  = await fetch('/api/analytics/daily?days=' + days);
  const rows = await res.json();

  const dateSet = [...new Set(rows.map(r => r.date))].sort();
  // Map raw class_name in DB → display label for legend
  const CLASS_MAP = { blue: 'Blue', non_waste: 'Non-Waste', red: 'Red', white: 'White', yellow: 'Yellow' };
  const DISPLAY_ORDER = ['Blue', 'Red', 'Yellow', 'White', 'Non-Waste'];

  const datasets = DISPLAY_ORDER.map(label => {
    const rawKey = Object.entries(CLASS_MAP).find(([, v]) => v === label)?.[0];
    const data   = dateSet.map(d => {
      const row = rows.find(r => r.date === d && (r.class_name === rawKey || r.class_name === label));
      return row ? row.count : 0;
    });
    const color = CLASS_COLORS[label];
    return {
      label           : (CLASS_INFO[label]?.icon || '') + ' ' + label,
      data,
      borderColor     : color,
      backgroundColor : color + '20',
      borderWidth     : 2,
      fill            : false,
      tension         : 0.4,
      pointBackgroundColor: color,
      pointRadius     : 3,
      pointHoverRadius: 6
    };
  });

  if (lineChart) lineChart.destroy();

  lineChart = new Chart($('lineChart').getContext('2d'), {
    type: 'line',
    data: { labels: dateSet, datasets },
    options: {
      responsive        : true,
      maintainAspectRatio: false,
      interaction       : { mode: 'index', intersect: false },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxRotation: 45 } },
        y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: 'rgba(255,255,255,.05)' } }
      },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, pointStyleWidth: 10, padding: 14, font: { size: 11 } } }
      }
    }
  });
}

// ── Per-Class Report Table ───────────────────────────────────
async function loadClassReport() {
  const res  = await fetch('/api/analytics/class-report');
  const rows = await res.json();
  const tbody   = $('classTable');
  const riskMap = { High: 'risk-high', Medium: 'risk-med', Low: 'risk-low', None: 'risk-none' };

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>
        <span class="class-dot" style="background:${CLASS_COLORS[r.class] || '#94A3B8'}"></span>
        <strong>${r.class}</strong>
      </td>
      <td style="color:var(--text2)">${r.info.desc}</td>
      <td><span class="risk-pill ${riskMap[r.info.risk] || 'risk-none'}">${r.info.risk} Risk</span></td>
      <td><strong>${r.total}</strong></td>
      <td>
        <span style="font-weight:700">${Number(r.avg_confidence).toFixed(1)}%</span>
        <div class="conf-mini-bar">
          <div class="conf-mini-fill" style="width:${r.avg_confidence}%"></div>
        </div>
      </td>
    </tr>`).join('');

  $('reportUpdated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
}

// ── Actions ──────────────────────────────────────────────────
function exportCSV() {
  window.open('/api/analytics/export', '_blank');
  showToast('📊 Exporting CSV report…', 'success');
}

async function confirmDelete() {
  if (!confirm('⚠️ Delete ALL detection history? This cannot be undone.')) return;
  const res = await fetch('/api/analytics/delete', { method: 'DELETE' });
  if (res.ok) {
    showToast('🗑️ History deleted successfully', 'success');
    setTimeout(init, 500);
  } else {
    showToast('❌ Delete failed — admin access required', 'risk');
  }
}



// ── WebSocket live refresh ────────────────────────────────────
const socket = io();
socket.on('new_prediction', () => loadSummary());
socket.on('history_cleared', () => init());

// ── Run ──────────────────────────────────────────────────────
init();
setInterval(init, 30000);
