/* Trend Scanner Part Deux — dashboard.js */

let state = null;
let lastScanCount = -1;
let prevAlertTradeCount = -1;
let activeMASymbol = null;
let activeFilter = 'all';
const cooldownEndsAt = {}; // symbol → Unix timestamp (seconds) when cooldown expires

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.tfp').forEach(el => el.classList.remove('active'));
  const pill = document.querySelector(`.tfp[data-filter="${f}"]`);
  if (pill) pill.classList.add('active');
  renderCardGrid();
}

// Tier-based cancel cycle counts (must match config.py)
const STRONG_CANCEL_CYCLES_JS  = 2;
const REGULAR_CANCEL_CYCLES_JS = 3;

// ── Utility ───────────────────────────────────────────────────────────────────

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtPrice(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  if (v >= 1000) return fmt(v, 2);
  if (v >= 1)    return fmt(v, 4);
  return fmt(v, 6);
}

function relTime(ts) {
  if (!ts) return '';
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function elapsed(ts) {
  if (!ts) return '—';
  const secs = Math.floor(Date.now() / 1000) - ts;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function scoreClass(n) {
  if (n >= 6) return 'score-high';
  if (n >= 4) return 'score-med';
  return 'score-low';
}

function rsiColor(v) {
  if (v == null || isNaN(v)) return '#ffffff';
  return v <= 35 ? '#00ff88' : v >= 65 ? '#ff4444' : '#ffffff';
}

// ── Tab management ─────────────────────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`tab-btn-${tabId}`);
  if (activeBtn) activeBtn.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  const activeContent = document.getElementById(`tab-${tabId}`);
  if (activeContent) activeContent.classList.add('active');

  const tlActions = document.getElementById('tradelog-tab-actions');
  if (tlActions) tlActions.style.display = tabId === 'tradelog' ? 'flex' : 'none';

  const alertActions = document.getElementById('alerts-tab-actions');
  if (alertActions) alertActions.style.display = tabId === 'alerts' ? 'flex' : 'none';

  try { localStorage.setItem('tsp_active_tab', tabId); } catch(e) {}
}

function updateAlertBadge() {
  if (!state) return;
  const openTrades    = state.open_trades || {};
  const openTradeKeys = new Set(Object.keys(openTrades));
  const alerts        = state.alerts || [];

  const unactedAlerts = alerts.filter(a => !openTradeKeys.has(`${a.symbol}${a.direction}`));
  const total = openTradeKeys.size + unactedAlerts.length;

  const badge = document.getElementById('alert-badge');
  if (badge) {
    if (total > 0) {
      badge.textContent   = `(${total})`;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  if (prevAlertTradeCount !== -1 && total > prevAlertTradeCount) {
    const btn = document.getElementById('tab-btn-alerts');
    if (btn) {
      btn.classList.remove('tab-flash');
      void btn.offsetWidth;
      btn.classList.add('tab-flash');
    }
  }
  prevAlertTradeCount = total;
}

function showToast(msg, duration = 4000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ── API calls ──────────────────────────────────────────────────────────────────

async function openTrade(symbol, direction, exchange = 'HL') {
  try {
    const res = await fetch('/api/trade/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction, exchange }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || 'Failed to open trade');
      return;
    }
    if (data.status === 'pending') {
      showToast(`LIMIT order placed at ${fmtPrice(data.limit_px)} on ${exchange} — awaiting fill`);
    }
    await fetchState();
    renderAll();
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

async function cancelLimitOrder(symbol, direction) {
  try {
    const res = await fetch('/api/order/limit/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || 'Failed to cancel limit order');
      return;
    }
    showToast(`Limit order cancelled — ${symbol} ${direction}`);
    await fetchState();
    renderAll();
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

async function resetCircuitBreaker() {
  try {
    const res = await fetch('/api/circuit-breaker/reset', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.detail || 'Reset failed'); return; }
    await fetchState();
    renderAll();
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

async function resetDay() {
  try {
    const res = await fetch('/api/reset-day', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.detail || 'Reset failed'); return; }
    await fetchState();
    renderAll();
    showToast('Day reset — daily P&L and halt cleared.');
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

async function closeTrade(symbol, direction) {
  try {
    const res = await fetch('/api/trade/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || 'Failed to close trade');
      return;
    }
    if (state) {
      state.alerts = (state.alerts || []).filter(
        a => !(a.symbol === symbol && a.direction === direction)
      );
      const key = `${symbol}${direction}`;
      if (state.open_trades) delete state.open_trades[key];
    }
    renderAlerts();
    await fetchState();
    renderAll();
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

// ── Fetch state ───────────────────────────────────────────────────────────────

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    state = await res.json();
    const nowSec = Date.now() / 1000;
    for (const p of (state.pair_states || [])) {
      const cd = p.cooldown_remaining_seconds;
      if (cd > 0) {
        cooldownEndsAt[p.symbol] = nowSec + cd;
      } else {
        delete cooldownEndsAt[p.symbol];
      }
    }
  } catch (e) {
    // silently ignore network hiccups
  }
}

// ── Header render ─────────────────────────────────────────────────────────────

function renderHeader() {
  if (!state) return;
  const acc = state.account || {};
  const pct = acc.cap_pct || 0;
  const capColor = pct >= 90 ? '#ff4444' : pct >= 70 ? '#ffaa00' : '#00ff88';

  const tradesEl = document.getElementById('hc-trades');
  if (tradesEl) tradesEl.textContent = `${acc.trades_opened ?? 0} opened`;

  const lastScan = state.last_scan_at;
  const scanAgoEl = document.getElementById('hc-scan-ago');
  if (scanAgoEl && lastScan) scanAgoEl.textContent = relTime(lastScan);

  const deployEl = document.getElementById('hc-deploy-time');
  if (deployEl && state.deploy_time && !deployEl.dataset.set) {
    deployEl.textContent = 'DEPLOYED ' + state.deploy_time;
    deployEl.dataset.set = '1';
  }

  const ms = state.market_snapshot || {};
  const tb = ms.trend_bias || {};
  const bearCount = (tb.strong_bear || []).length;
  const bullCount = (tb.strong_bull || []).length;
  const neutCount = (tb.neutral    || []).length;

  const trendEl = document.getElementById('hc-trend-val');
  if (trendEl) {
    trendEl.innerHTML =
      `<span style="color:#ff4444">${bearCount} BEAR</span>` +
      `<span style="color:#333"> · </span>` +
      `<span style="color:#00ff88">${bullCount} BULL</span>` +
      `<span style="color:#333"> · </span>` +
      `<span style="color:#66aaff">${neutCount} NEU</span>`;
  }

  const pairs = state.pair_states || [];
  const adxStrongCount = pairs.filter(p => (p.adx || 0) >= 50).length;
  const adxEl = document.getElementById('hc-adx-strong');
  if (adxEl) {
    adxEl.textContent = adxStrongCount + ' pairs';
    adxEl.style.color = adxStrongCount > 0 ? '#00ff88' : '#666666';
  }

  const sigEl = document.getElementById('hc-signals');
  if (sigEl) sigEl.textContent = (state.alerts || []).length;

  const daily      = state.daily || {};
  const dailyPnl   = daily.pnl   ?? null;
  const dailyHalted = daily.halted ?? false;
  const pnlEl      = document.getElementById('hc-daily-pnl');
  if (pnlEl && dailyPnl !== null) {
    const pnlColor = dailyPnl >= 0 ? '#00ff88' : '#ff4444';
    const pnlSign  = dailyPnl >= 0 ? '+' : '';
    pnlEl.textContent = `${pnlSign}$${fmt(dailyPnl, 2)}`;
    pnlEl.style.color = pnlColor;
  }

  const btcRegime = state.btc_regime || 'Neutral';
  const btcEl     = document.getElementById('hc-btc-regime');
  if (btcEl) {
    const btcColor = btcRegime === 'Strong Bull' ? '#00ff88'
      : btcRegime === 'Strong Bear' ? '#ff4444' : '#ffaa00';
    const btcLabel = btcRegime === 'Strong Bull' ? 'BULL'
      : btcRegime === 'Strong Bear' ? 'BEAR' : 'NEUTRAL';
    btcEl.textContent = btcLabel;
    btcEl.style.color = btcColor;
  }

  const dlBadgeEl = document.getElementById('daily-limit-badge');
  if (dlBadgeEl) dlBadgeEl.style.display = dailyHalted ? 'inline-flex' : 'none';
  const rdBtnEl = document.getElementById('reset-day-btn');
  if (rdBtnEl) rdBtnEl.style.display = dailyHalted ? 'inline-flex' : 'none';

  const cb = state.circuit_breaker || {};
  const cbActive = cb.active || false;
  const cbLosses = cb.consecutive_losses || 0;

  const cbBadgeEl = document.getElementById('circuit-breaker-badge');
  if (cbBadgeEl) cbBadgeEl.style.display = cbActive ? 'inline-flex' : 'none';
  const cbResetEl = document.getElementById('circuit-breaker-reset');
  if (cbResetEl) cbResetEl.style.display = cbActive ? 'inline-flex' : 'none';

  const lossesEl = document.getElementById('hc-losses-in-row');
  if (lossesEl) {
    if (cbLosses >= 3) {
      const lossColor = cbLosses >= 5 ? '#ff4444' : '#ffaa00';
      lossesEl.innerHTML = `LOSSES IN ROW: <span style="color:${lossColor};font-weight:700">${cbLosses}</span>`;
      lossesEl.style.display = 'inline-flex';
    } else {
      lossesEl.style.display = 'none';
    }
  }
}

// ── Scan pulse strip render ───────────────────────────────────────────────────

function renderScanPulse() {
  if (!state) return;
  const scanCount = state.scan_count ?? 0;
  const lastScan  = state.last_scan_at;
  const signals   = (state.alerts || []).length;

  const numEl = document.getElementById('pulse-scan-num');
  if (numEl) numEl.textContent = `#${scanCount}`;

  const agoEl = document.getElementById('pulse-ago');
  if (agoEl && lastScan) {
    const secs = Math.max(0, Math.floor(Date.now() / 1000) - lastScan);
    agoEl.textContent = `${secs}s ago`;
  }

  const sigEl = document.getElementById('pulse-signals');
  if (sigEl) sigEl.textContent = signals;

  if (lastScanCount !== -1 && scanCount !== lastScanCount) {
    const dot = document.getElementById('pulse-dot');
    if (dot) {
      dot.classList.remove('flash');
      void dot.offsetWidth;
      dot.classList.add('flash');
    }
  }
  lastScanCount = scanCount;
}

// ── Trend pill builder (V4 — color-aware, ADX-tiered) ─────────────────────────

function buildTrendPill(tp) {
  // tp: HIGH_PROB_BEAR, STRONG_BEAR, REGULAR_BEAR,
  //     HIGH_PROB_BULL, STRONG_BULL, REGULAR_BULL, NEUTRAL
  if (!tp) tp = 'NEUTRAL';

  const isBull    = tp.endsWith('_BULL');
  const isBear    = tp.endsWith('_BEAR');
  const isHigh    = tp.startsWith('HIGH_PROB');
  const isStrong  = tp.startsWith('STRONG');
  const isRegular = tp.startsWith('REGULAR');
  const isNeutral = tp === 'NEUTRAL';

  let pillBg, pillBorder, labelColor, label;
  let litColor, litGlow, dimBg, dimBorder, glowPx;
  let litCount = 0;

  if (isNeutral) {
    pillBg     = 'rgba(100,160,255,0.08)';  pillBorder = 'rgba(100,160,255,0.2)';
    labelColor = '#66aaff';                 label      = 'NEU';
    litColor   = 'rgba(100,160,255,0.35)';  litGlow    = 'none'; glowPx = 0;
    dimBg      = 'rgba(100,160,255,0.35)';  dimBorder  = '1px solid rgba(100,160,255,0.3)';
  } else if (isHigh) {
    litCount = 3; glowPx = 5;
    if (isBear) {
      pillBg = 'rgba(255,68,68,0.1)';   pillBorder = 'rgba(255,68,68,0.3)';
      labelColor = '#ff4444';           label      = 'BEAR';
      litColor   = '#ff4444';           litGlow    = 'rgba(255,68,68,0.8)';
      dimBg      = 'rgba(255,68,68,0.12)'; dimBorder = '1px solid rgba(255,68,68,0.2)';
    } else {
      pillBg = 'rgba(0,255,136,0.1)';   pillBorder = 'rgba(0,255,136,0.3)';
      labelColor = '#00ff88';           label      = 'BULL';
      litColor   = '#00ff88';           litGlow    = 'rgba(0,255,136,0.8)';
      dimBg      = 'rgba(0,255,136,0.12)'; dimBorder = '1px solid rgba(0,255,136,0.2)';
    }
  } else if (isStrong) {
    litCount = 2; glowPx = 4;
    pillBg     = 'rgba(255,170,0,0.08)'; pillBorder = 'rgba(255,170,0,0.22)';
    labelColor = '#ffaa00';              label      = isBear ? 'BEAR' : 'BULL';
    litColor   = '#ffaa00';             litGlow    = 'rgba(255,170,0,0.7)';
    dimBg      = 'rgba(255,170,0,0.12)'; dimBorder = '1px solid rgba(255,170,0,0.2)';
  } else {
    litCount = 1; glowPx = 3;
    pillBg     = 'rgba(255,255,255,0.05)'; pillBorder = 'rgba(255,255,255,0.12)';
    labelColor = '#ffffff';                label      = isBear ? 'BEAR' : 'BULL';
    litColor   = '#ffffff';               litGlow    = 'rgba(255,255,255,0.4)';
    dimBg      = 'rgba(255,255,255,0.08)'; dimBorder = '1px solid rgba(255,255,255,0.12)';
  }

  function dot(i) {
    if (isNeutral) {
      return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dimBg};border:1px solid rgba(100,160,255,0.3);flex-shrink:0"></span>`;
    }
    if (i < litCount) {
      return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${litColor};box-shadow:0 0 ${glowPx}px ${litGlow};flex-shrink:0"></span>`;
    }
    return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dimBg};border:${dimBorder};flex-shrink:0"></span>`;
  }

  return `<div style="display:inline-flex;align-items:center;gap:3px;background:${pillBg};border:1px solid ${pillBorder};border-radius:20px;padding:4px 10px">` +
    dot(0) + dot(1) + dot(2) +
    `<span style="color:${labelColor};font-weight:700;font-size:11px;margin-left:5px;letter-spacing:0.04em">${label}</span>` +
    `</div>`;
}

// ── Right side panel render ───────────────────────────────────────────────────

function renderSidePanel() {
  if (!state) return;
  const ms = state.market_snapshot || {};
  const tb = ms.trend_bias     || {};
  const ab = ms.adx_bands      || {};
  const mb = ms.momentum_bands || {};

  function chips(arr, color) {
    if (!arr || arr.length === 0) return '';
    return arr.map(s => `<span class="sp-chip" style="color:${color}">${s}</span>`).join(' ');
  }

  const trendEl = document.getElementById('sp-trend-bias');
  if (trendEl) {
    let html = '';
    const bears = tb.strong_bear || [];
    const bulls = tb.strong_bull || [];
    const neuts = tb.neutral     || [];
    if (bears.length > 0) {
      html += `<div class="sp-row"><span class="sp-row-label" style="color:#ff4444">BEAR ${bears.length}</span></div>`;
      html += `<div class="sp-chips">${chips(bears, '#ff4444')}</div>`;
    }
    if (bulls.length > 0) {
      html += `<div class="sp-row"><span class="sp-row-label" style="color:#00ff88">BULL ${bulls.length}</span></div>`;
      html += `<div class="sp-chips">${chips(bulls, '#00ff88')}</div>`;
    }
    if (neuts.length > 0) {
      html += `<div class="sp-row"><span class="sp-row-label" style="color:#66aaff">NEU ${neuts.length}</span></div>`;
      html += `<div class="sp-chips">${chips(neuts, '#66aaff')}</div>`;
    }
    trendEl.innerHTML = html || '<span style="color:#333;font-size:9px">—</span>';
  }

  const adxEl = document.getElementById('sp-adx-strength');
  if (adxEl) {
    let html = '';
    if ((ab.strong   || []).length > 0)
      html += `<div class="sp-adx-row"><span class="sp-adx-dots" style="color:#00ff88">●●●</span><div class="sp-chips">${chips(ab.strong, '#00ff88')}</div></div>`;
    if ((ab.moderate || []).length > 0)
      html += `<div class="sp-adx-row"><span class="sp-adx-dots" style="color:#ffaa00">●●</span><div class="sp-chips">${chips(ab.moderate, '#ffaa00')}</div></div>`;
    if ((ab.weak     || []).length > 0)
      html += `<div class="sp-adx-row"><span class="sp-adx-dots" style="color:#444">○</span><div class="sp-chips">${chips(ab.weak, '#444444')}</div></div>`;
    adxEl.innerHTML = html || '<span style="color:#333;font-size:9px">—</span>';
  }

  const momEl = document.getElementById('sp-momentum');
  if (momEl) {
    let html = '';
    if ((mb.overbought || []).length > 0) {
      html += `<div style="font-size:12px;color:#ff4444;font-weight:700;margin-bottom:2px">OB J&gt;80</div>`;
      html += `<div class="sp-chips" style="margin-bottom:4px">${chips(mb.overbought, '#ff4444')}</div>`;
    }
    if ((mb.oversold  || []).length > 0) {
      html += `<div style="font-size:12px;color:#00ff88;font-weight:700;margin-bottom:2px">OS J&lt;20</div>`;
      html += `<div class="sp-chips">${chips(mb.oversold, '#00ff88')}</div>`;
    }
    momEl.innerHTML = html || '<span style="color:#333;font-size:9px">—</span>';
  }

  const btcEl = document.getElementById('sp-btc-regime');
  if (btcEl) {
    const regime = state.btc_regime || 'Neutral';
    const regimeBg     = regime === 'Strong Bull' ? 'rgba(0,255,136,0.1)'  : regime === 'Strong Bear' ? 'rgba(255,68,68,0.1)'  : 'rgba(255,170,0,0.1)';
    const regimeBorder = regime === 'Strong Bull' ? 'rgba(0,255,136,0.3)'  : regime === 'Strong Bear' ? 'rgba(255,68,68,0.3)'  : 'rgba(255,170,0,0.3)';
    const regimeColor  = regime === 'Strong Bull' ? '#00ff88'               : regime === 'Strong Bear' ? '#ff4444'               : '#ffaa00';
    const regimeLabel  = regime === 'Strong Bull' ? 'BULL'                  : regime === 'Strong Bear' ? 'BEAR'                  : 'NEUTRAL';
    btcEl.innerHTML = `<div class="sp-regime-badge" style="background:${regimeBg};border:1px solid ${regimeBorder}">` +
      `<div class="sp-regime-text" style="color:${regimeColor}">${regimeLabel}</div>` +
      `</div>`;
  }

  const sessEl = document.getElementById('sp-session');
  if (sessEl) {
    sessEl.innerHTML =
      `<div class="sp-session-badge" style="background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.3)">` +
      `<div class="sp-session-text" style="color:#00ff88">ALL SESSIONS OPEN</div>` +
      `</div>`;
  }
}

// ── Alert tier helpers ────────────────────────────────────────────────────────

function getAlertTier(alert) {
  if (alert.trend_strength && alert.trend_strength !== 'NEUTRAL') return alert.trend_strength;
  const adx   = alert.adx   || 0;
  const trend = alert.trend || '';
  if (trend === 'Neutral') return 'REGULAR';
  if (adx >= 60) return 'HIGH_PROB';
  if (adx >= 40) return 'STRONG';
  return 'REGULAR';
}

function buildTierHeader(tierKey, count) {
  const configs = {
    HIGH_PROB: { label: 'HIGH PROBABILITY', color: '#00ff88', adxRange: 'ADX ≥ 60', tpText: 'TP1 · TP2 · TP3', dots: 3 },
    STRONG:    { label: 'STRONG',           color: '#ffaa00', adxRange: 'ADX 40–59', tpText: 'TP1 · TP2',       dots: 2 },
    REGULAR:   { label: 'REGULAR',          color: '#aaaaaa', adxRange: 'ADX 25–39', tpText: 'TP1 only',        dots: 1 },
    IN_TRADE:  { label: 'IN TRADE',         color: '#f97316', adxRange: 'Active positions', tpText: '',          dots: 1 },
  };
  const cfg = configs[tierKey] || configs.REGULAR;
  const topMargin = tierKey === 'HIGH_PROB' ? '0' : '18px';

  let dotHtml = '';
  for (let i = 0; i < 3; i++) {
    const lit = i < cfg.dots;
    const c   = lit ? cfg.color : '#222222';
    const glow = (lit && tierKey !== 'REGULAR') ? `;box-shadow:0 0 4px ${cfg.color}88` : '';
    dotHtml += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c}${glow};flex-shrink:0"></span>`;
  }

  return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0 8px;margin-top:${topMargin};border-bottom:1px solid #1a1e2a;margin-bottom:10px">
    <div style="display:flex;gap:3px;align-items:center">${dotHtml}</div>
    <span style="font-family:'Bebas Neue',sans-serif;font-size:17px;color:#fff;letter-spacing:.1em;line-height:1">${cfg.label}</span>
    ${cfg.adxRange ? `<span style="font-size:10px;color:#444;margin-left:4px">${cfg.adxRange}</span>` : ''}
    ${cfg.tpText   ? `<span style="font-size:10px;color:#333"> · </span><span style="font-size:10px;color:#444">${cfg.tpText}</span>` : ''}
    <span style="font-size:11px;color:#333;margin-left:4px">(${count})</span>
  </div>`;
}

// ── Signal alert card (two-row design) ────────────────────────────────────────

function buildSignalCard(alert, capReached) {
  const ts     = getAlertTier(alert);
  const isLong = alert.direction === 'LONG';
  const key    = `${alert.symbol}${alert.direction}`;
  const now    = Math.floor(Date.now() / 1000);
  const age    = now - (alert.fired_at || now);
  const STALE_S = 5400; // 90 min
  const isStale = age > STALE_S;

  // Tier dot indicator (card header)
  const dotColors   = { HIGH_PROB: '#00ff88', STRONG: '#ffaa00', REGULAR: '#aaaaaa', NEUTRAL: '#444' };
  const dotCounts   = { HIGH_PROB: 3,         STRONG: 2,         REGULAR: 1,         NEUTRAL: 0 };
  const dotColor    = dotColors[ts] || '#aaaaaa';
  const dotCount    = dotCounts[ts] || 1;
  let dotHtml = '';
  for (let i = 0; i < 3; i++) {
    const lit = i < dotCount;
    const c   = lit ? dotColor : '#222';
    dotHtml += `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c};flex-shrink:0"></span>`;
  }

  const dirBadge = isLong
    ? `<span class="ac-dir-long">LONG</span>`
    : `<span class="ac-dir-short">SHORT</span>`;

  // Gates count from live pair state
  const pairState = (state.pair_states || []).find(p => p.symbol === alert.symbol);
  const gs = pairState ? (pairState.gates_status || {}) : {};
  const gateCount  = [gs.trend_pass, gs.adx_pass, gs.depth_pass, gs.ma_pass].filter(Boolean).length;
  const gatesColor = gateCount === 4 ? '#00ff88' : gateCount >= 3 ? '#ffaa00' : '#555';

  const staleHtml = isStale
    ? `<span style="color:#ffaa00;font-size:9px;font-weight:700;background:rgba(255,170,0,0.1);border:1px solid rgba(255,170,0,0.3);border-radius:3px;padding:1px 5px;margin-left:3px">STALE</span>`
    : '';

  // SNAPSHOT ROW values
  const adx   = alert.adx || 0;
  const j1h   = alert.j1h || 50;
  const rsi1h = alert.rsi_1h || 50;
  const adxColor  = adx >= 60 ? '#00ff88' : adx >= 40 ? '#ffaa00' : adx >= 25 ? '#fff' : '#666';
  const jColor    = j1h >= 80 ? '#ff4444' : j1h <= 20 ? '#00ff88' : '#fff';
  const rsiCol    = rsi1h >= 70 ? '#ff4444' : rsi1h <= 30 ? '#00ff88' : '#fff';
  const trendLbl  = alert.trend === 'Strong Bull' ? 'BULL' : alert.trend === 'Strong Bear' ? 'BEAR' : 'NEU';
  const trendCol  = alert.trend === 'Strong Bull' ? '#00ff88' : alert.trend === 'Strong Bear' ? '#ff4444' : '#666';
  const depthPct  = pairState ? (isLong ? pairState.bid_pct : pairState.ask_pct) : null;
  const depthStr  = depthPct != null ? `${fmt(depthPct, 1)}%` : '—';
  const depthCol  = (depthPct || 0) >= 60 ? '#00ff88' : (depthPct || 0) >= 45 ? '#ffaa00' : '#fff';
  const ch24      = pairState ? pairState.change_24h : null;
  const ch24Html  = ch24 != null
    ? `<span style="color:${ch24 >= 0 ? '#00ff88' : '#ff4444'}">${ch24 >= 0 ? '+' : ''}${fmt(Math.abs(ch24), 1)}%</span>`
    : '<span style="color:#555">—</span>';

  function snapItem(label, valHtml) {
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
      <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em;white-space:nowrap">${label}</div>
      <div style="font-size:13px;font-weight:700;line-height:1.2">${valHtml}</div>
    </div>`;
  }

  const snapRow = `<div style="display:flex;gap:0;padding:8px 14px;border-bottom:1px solid #1a1e2a;background:rgba(255,255,255,0.01)">
    ${snapItem('ADX',   `<span style="color:${adxColor}">${fmt(adx, 1)}</span>`)}
    ${snapItem('J',     `<span style="color:${jColor}">${fmt(j1h, 1)}</span>`)}
    ${snapItem('RSI 1H',`<span style="color:${rsiCol}">${fmt(rsi1h, 1)}</span>`)}
    ${snapItem('TREND', `<span style="color:${trendCol}">${trendLbl}</span>`)}
    ${snapItem('DEPTH', `<span style="color:${depthCol}">${depthStr}</span>`)}
    ${snapItem('24H Δ', ch24Html)}
  </div>`;

  // LEVELS GRID
  const entry  = alert.entry_price || 0;
  const slHalf = alert.sl_half_price || (isLong ? entry * (1 - 0.006) : entry * (1 + 0.006));
  const slFull = alert.sl_price || 0;
  const tp1    = alert.tp1_price || 0;
  const tp2    = alert.tp2_price || null;
  const tp3    = alert.tp3_price || null;

  function sPct(lvl) {
    if (!lvl || !entry) return null;
    return isLong ? (lvl - entry) / entry * 100 : (entry - lvl) / entry * 100;
  }

  function levelCol(label, price, priceColor, pct, larger = false) {
    const pctColor = pct == null ? '#333' : pct >= 0 ? '#00cc44' : '#ff4444';
    const pctStr   = pct == null ? '' : `${pct >= 0 ? '+' : ''}${fmt(pct, 2)}%`;
    const sz       = larger ? '16px' : '13px';
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;overflow:hidden">
      <div style="font-size:9px;font-weight:700;letter-spacing:.05em;color:#555;white-space:nowrap;text-transform:uppercase">${label}</div>
      <div style="font-size:${sz};font-weight:700;color:${priceColor};white-space:nowrap;font-family:'JetBrains Mono',monospace;line-height:1.2">${fmtPrice(price)}</div>
      <div style="font-size:9px;color:${pctColor};min-height:12px">${pctStr}</div>
    </div>`;
  }

  const cols = ts === 'HIGH_PROB' ? 6 : ts === 'STRONG' ? 5 : 4;
  let levelsHtml = `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px 6px;padding:8px;background:#0b0d12;border-radius:6px;border:1px solid #1a1e2a">`;
  levelsHtml += levelCol('ENTRY',    entry,  '#ffffff', null);
  levelsHtml += levelCol('SL 50%',  slHalf, '#ffaa00', sPct(slHalf));
  levelsHtml += levelCol('SL FULL', slFull, '#ff4444', sPct(slFull));
  levelsHtml += levelCol('TP1 1.5R', tp1,   '#00cc66', sPct(tp1));
  if (ts === 'STRONG' || ts === 'HIGH_PROB') {
    levelsHtml += levelCol('TP2 2.5R', tp2, '#00ff88', sPct(tp2));
  }
  if (ts === 'HIGH_PROB') {
    levelsHtml += levelCol('TP3 4.0R', tp3, '#00ffcc', sPct(tp3), true);
  }
  levelsHtml += '</div>';

  // MARGIN ROW
  const lev    = alert.leverage || 10;
  const margin = alert.margin   || 2000;
  const posSize = entry > 0 ? (margin * lev) / entry : 0;
  const posSizeStr = posSize > 0
    ? `${fmt(posSize, posSize < 1 ? 4 : posSize < 100 ? 2 : 1)} ${alert.symbol}`
    : '—';
  const dr = alert.dollar_risk || 0;

  function mrItem(label, valHtml) {
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
      <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em;white-space:nowrap">${label}</div>
      <div style="font-size:13px;font-weight:700;line-height:1.2">${valHtml}</div>
    </div>`;
  }

  const marginRow = `<div style="display:flex;gap:0;padding:8px 14px;border-bottom:1px solid #1a1e2a">
    ${mrItem('LEVERAGE',  `<span style="color:#fff">${lev}x</span>`)}
    ${mrItem('MARGIN',    `<span style="color:#fff">$${fmt(margin, 0)}</span>`)}
    ${mrItem('POS SIZE',  `<span style="color:#aaa;font-size:11px">${posSizeStr}</span>`)}
    ${mrItem('1R RISK',   `<span style="color:#ff4444">$${fmt(dr, 2)}</span>`)}
  </div>`;

  // AWAITING PULLBACK ROW (if status = awaiting_entry)
  let awaitRow = '';
  if (alert.status === 'awaiting_entry') {
    awaitRow = `<div style="padding:6px 14px;background:rgba(249,115,22,0.06);border-bottom:1px solid rgba(249,115,22,0.2)">
      <span style="color:#f97316;font-size:10px;font-weight:700;letter-spacing:.06em;animation:pending-pulse 1.4s infinite">◈ AWAITING PULLBACK ENTRY</span>
    </div>`;
  }

  // EXCHANGE BUTTONS / AWAITING FILL / CANCELLED states
  const autoInfo      = (state.auto_pending || {})[key];
  const plo           = alert.pending_limit_order;   // set when a LIMIT order is live
  const isCancelled   = !!alert.limit_order_cancelled;
  const slotsFull     = (state.account || {}).slots_full || false;
  const dirText       = isLong ? 'LONG' : 'SHORT';

  // Order type hint label (shown in normal state, before buttons)
  const orderTypeTip  = ts === 'HIGH_PROB'
    ? `<span style="font-size:9px;color:#444;letter-spacing:.05em">Order type: <span style="color:#00ff88">MARKET</span> (instant fill)</span>`
    : `<span style="font-size:9px;color:#444;letter-spacing:.05em">Order type: <span style="color:#ffaa00">LIMIT</span> · ${ts === 'STRONG' ? STRONG_CANCEL_CYCLES_JS : REGULAR_CANCEL_CYCLES_JS} scan cycles max</span>`;

  let buttonsHtml;

  if (isCancelled) {
    // CANCELLED flash — show briefly until next poll clears it
    const cancelReason = alert.limit_order_cancel_reason || '';
    buttonsHtml = `
      <div style="padding:10px;border-radius:6px;background:rgba(255,68,68,0.08);
          border:1px solid rgba(255,68,68,0.3);text-align:center;
          animation:cancelled-flash 0.6s ease-out">
        <div style="color:#ff4444;font-size:11px;font-weight:700;letter-spacing:.08em">✕ LIMIT ORDER CANCELLED</div>
        ${cancelReason ? `<div style="color:#555;font-size:9px;margin-top:4px">${cancelReason.replace(/^\[CANCEL\] \S+ \S+ — /,'')}</div>` : ''}
      </div>`;
  } else if (plo) {
    // AWAITING LIMIT FILL state
    const cycles     = alert.scan_cycles_since_alert || 0;
    const maxCycles  = plo.cancel_after_cycles || 3;
    const remaining  = Math.max(0, maxCycles - cycles);
    const pct        = Math.max(0, Math.min(100, (remaining / maxCycles) * 100));
    const exchLabel  = plo.exchange || 'HL';
    const exchColor  = exchLabel === 'MEXC' ? '#f59e0b' : '#60a5fa';
    const exchBg     = exchLabel === 'MEXC' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)';
    const exchBorder = exchLabel === 'MEXC' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)';

    buttonsHtml = `
      <div style="border-radius:6px;border:1px solid rgba(255,170,0,0.3);background:rgba(255,170,0,0.06);overflow:hidden">
        <div style="padding:8px 12px;display:flex;align-items:center;gap:8px">
          <span style="color:#ffaa00;font-size:10px;font-weight:700;letter-spacing:.06em;animation:pending-pulse 1.4s infinite">⏳ AWAITING FILL</span>
          <span style="background:${exchBg};border:1px solid ${exchBorder};border-radius:3px;padding:1px 6px;font-size:9px;color:${exchColor};font-weight:700">${exchLabel}</span>
          <span style="flex:1"></span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:#fff">${fmtPrice(plo.limit_px)}</span>
        </div>
        <div style="padding:0 12px 4px;display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:3px;background:#1a1e2a;border-radius:2px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:#ffaa00;border-radius:2px;transition:width .3s"></div>
          </div>
          <span style="font-size:9px;color:#555;white-space:nowrap">${remaining} cycle${remaining !== 1 ? 's' : ''} left</span>
        </div>
        <div style="padding:6px 12px 8px">
          <button onclick="cancelLimitOrder('${alert.symbol}','${alert.direction}')"
            style="width:100%;padding:6px;border-radius:4px;border:1px solid rgba(255,68,68,0.3);
              background:rgba(255,68,68,0.08);color:#ff4444;font-family:var(--font);
              font-size:10px;font-weight:700;letter-spacing:.06em;cursor:pointer">
            ✕ CANCEL ORDER
          </button>
        </div>
      </div>`;
  } else if (autoInfo) {
    const remaining = Math.max(0, Math.ceil(autoInfo.fire_at - Date.now() / 1000));
    const label = remaining > 0 ? `AUTO IN ${remaining}s` : 'OPENING…';
    buttonsHtml = `<button class="pill pill-open" style="background:#ffaa00;color:#000;cursor:default;width:100%;padding:10px;font-size:11px" data-auto-key="${key}">${label}</button>`;
  } else if (slotsFull) {
    buttonsHtml = `<button class="pill" style="background:rgba(80,80,80,0.15);border:1px solid #444;color:#555;cursor:not-allowed;width:100%;padding:10px;font-size:11px" disabled>⛔ SLOTS FULL</button>`;
  } else {
    const dis = capReached ? 'disabled style="opacity:0.4;cursor:not-allowed"' : '';
    buttonsHtml = `
      <div style="margin-bottom:6px;text-align:center">${orderTypeTip}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button ${dis} onclick="openTrade('${alert.symbol}', '${alert.direction}', 'MEXC')"
          style="padding:10px;border-radius:6px;border:1px solid rgba(245,158,11,0.4);
            background:rgba(245,158,11,0.1);color:#f59e0b;font-family:var(--font);
            font-size:11px;font-weight:700;letter-spacing:.05em;cursor:pointer;
            display:flex;align-items:center;justify-content:center;gap:6px">
          <span style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);border-radius:3px;padding:1px 5px;font-size:9px">MEXC</span>
          OPEN ${dirText}
        </button>
        <button ${dis} onclick="openTrade('${alert.symbol}', '${alert.direction}', 'HL')"
          style="padding:10px;border-radius:6px;border:1px solid rgba(59,130,246,0.4);
            background:rgba(59,130,246,0.1);color:#60a5fa;font-family:var(--font);
            font-size:11px;font-weight:700;letter-spacing:.05em;cursor:pointer;
            display:flex;align-items:center;justify-content:center;gap:6px">
          <span style="background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:3px;padding:1px 5px;font-size:9px">HL</span>
          OPEN ${dirText}
        </button>
      </div>`;
  }

  const borderColor = ts === 'HIGH_PROB' ? '#00ff88' : ts === 'STRONG' ? '#ffaa00' : '#444';
  const cardGrad = ts === 'HIGH_PROB'
    ? 'linear-gradient(135deg, rgba(0,255,136,0.04) 0%, rgba(13,15,20,1) 50%)'
    : ts === 'STRONG'
    ? 'linear-gradient(135deg, rgba(255,170,0,0.03) 0%, rgba(13,15,20,1) 50%)'
    : 'none';

  return `<div class="ac" style="border-left:3px solid ${borderColor};background:${cardGrad};padding:0;margin-bottom:10px">
    <!-- CARD HEADER -->
    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px 8px;border-bottom:1px solid #1a1e2a">
      <div style="display:flex;gap:3px;align-items:center">${dotHtml}</div>
      <span style="font-family:'Bebas Neue',sans-serif;font-size:21px;color:#fff;letter-spacing:0.05em;line-height:1">${alert.symbol}</span>
      ${dirBadge}
      <span style="font-size:9px;color:${gatesColor};margin-left:2px">${gateCount}/4</span>
      <span style="flex:1"></span>
      <span style="font-size:10px;color:#555">${relTime(alert.fired_at)}</span>
      ${staleHtml}
    </div>
    <!-- SIGNAL SNAPSHOT ROW -->
    ${snapRow}
    <!-- TRADE LEVELS -->
    <div style="padding:10px 14px;border-bottom:1px solid #1a1e2a">${levelsHtml}</div>
    <!-- MARGIN ROW -->
    ${marginRow}
    ${awaitRow}
    <!-- EXCHANGE BUTTONS -->
    <div style="padding:10px 14px">${buttonsHtml}</div>
  </div>`;
}

// ── In-trade alert card ───────────────────────────────────────────────────────

function buildInTradeCard(alert, trade) {
  const isLong    = alert.direction === 'LONG';
  const ts        = getAlertTier(alert);
  const key       = `${alert.symbol}${alert.direction}`;
  const tp1Hit    = !!(trade && trade.tp1_hit);
  const trailSL   = trade && trade.trailing_sl;
  const exchange  = (trade && trade.exchange) || 'HL';

  const pnl       = trade.unrealized_pnl ?? 0;
  const r         = trade.r ?? 0;
  const pnlColor  = pnl >= 0 ? '#00ff88' : '#ff4444';
  const rColor    = r   >= 0 ? '#00ff88' : '#ff4444';
  const pnlSign   = pnl >= 0 ? '+' : '';
  const rSign     = r   >= 0 ? '+' : '';

  const currentPx = (state.prices && state.prices[alert.symbol])
    || (trade && trade.current_price)
    || alert.entry_price;
  const entry = trade.entry_price || alert.entry_price || 0;

  const slHalf = alert.sl_half_price || (isLong ? entry * (1 - 0.006) : entry * (1 + 0.006));
  const tp1    = alert.tp1_price || 0;
  const tp2    = alert.tp2_price || null;
  const tp3    = alert.tp3_price || null;

  function sPct(lvl) {
    if (!lvl || !entry) return null;
    return isLong ? (lvl - entry) / entry * 100 : (entry - lvl) / entry * 100;
  }

  function levelCol(label, price, priceColor, pct, struck = false) {
    const pctColor = pct == null ? '#333' : pct >= 0 ? '#00cc44' : '#ff4444';
    const pctStr   = pct == null ? '' : `${pct >= 0 ? '+' : ''}${fmt(pct, 2)}%`;
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;overflow:hidden;${struck ? 'opacity:0.4' : ''}">
      <div style="font-size:9px;font-weight:700;letter-spacing:.05em;color:#555;white-space:nowrap;text-transform:uppercase">${label}${struck ? ' ✓' : ''}</div>
      <div style="font-size:13px;font-weight:700;color:${priceColor};white-space:nowrap;font-family:'JetBrains Mono',monospace;line-height:1.2;${struck ? 'text-decoration:line-through' : ''}">${fmtPrice(price)}</div>
      <div style="font-size:9px;color:${pctColor};min-height:12px">${pctStr}</div>
    </div>`;
  }

  const cols = ts === 'HIGH_PROB' ? 6 : ts === 'STRONG' ? 5 : 4;
  let levelsHtml = `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px 6px;padding:8px;background:#0b0d12;border-radius:6px;border:1px solid #1a1e2a">`;
  levelsHtml += levelCol('ENTRY', entry, '#aaaaaa', null);
  levelsHtml += levelCol('SL 50%', slHalf, '#ffaa00', sPct(slHalf), tp1Hit);
  if (tp1Hit) {
    // After TP1, SL moves to entry (breakeven)
    levelsHtml += `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
      <div style="font-size:9px;font-weight:700;letter-spacing:.05em;color:#555">SL / BE</div>
      <div style="font-size:13px;font-weight:700;color:#00ff88;font-family:'JetBrains Mono',monospace;line-height:1.2">${fmtPrice(trade.sl_price || entry)}</div>
      <div style="font-size:9px;color:#00cc44">BE ✓</div>
    </div>`;
  } else {
    levelsHtml += levelCol('SL FULL', alert.sl_price, '#ff4444', sPct(alert.sl_price));
  }
  levelsHtml += levelCol('TP1 1.5R', tp1, tp1Hit ? '#666' : '#00cc66', sPct(tp1), tp1Hit);
  if (ts === 'STRONG' || ts === 'HIGH_PROB') {
    levelsHtml += levelCol('TP2 2.5R', tp2, '#00ff88', sPct(tp2));
  }
  if (ts === 'HIGH_PROB') {
    levelsHtml += levelCol('TP3 4.0R', tp3, '#00ffcc', sPct(tp3));
  }
  levelsHtml += '</div>';

  const trailHtml = (tp1Hit && trailSL) ? `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(249,115,22,0.07);border-top:1px solid rgba(249,115,22,0.15);border-bottom:1px solid rgba(249,115,22,0.15)">
      <span style="font-size:9px;font-weight:700;letter-spacing:.08em;color:#f97316">TRAILING SL ACTIVE</span>
      <span style="font-size:14px;font-weight:700;color:#f97316;font-family:'JetBrains Mono',monospace">${fmtPrice(trailSL)}</span>
    </div>` : '';

  const inTradeColor = isLong ? '#00ff88' : '#ff4444';
  const dirBadge = isLong ? `<span class="ac-dir-long">LONG</span>` : `<span class="ac-dir-short">SHORT</span>`;
  const exchColor  = exchange === 'MEXC' ? '#f59e0b' : '#60a5fa';
  const exchBg     = exchange === 'MEXC' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)';
  const exchBorder = exchange === 'MEXC' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)';
  const lev  = trade.leverage || alert.leverage || 10;
  const margin = trade.margin || alert.margin || 2000;
  const adx  = trade.adx || alert.adx || 0;

  return `<div class="ac" style="border-left:3px solid ${inTradeColor};background:linear-gradient(135deg, ${isLong ? 'rgba(0,255,136,0.04)' : 'rgba(255,68,68,0.04)'} 0%, rgba(13,15,20,1) 50%);padding:0;margin-bottom:10px">
    <!-- IN TRADE HEADER -->
    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px 8px;border-bottom:1px solid #1a1e2a">
      <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:4px;
        background:${isLong ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,68,0.1)'};
        border:1px solid ${isLong ? 'rgba(0,255,136,0.35)' : 'rgba(255,68,68,0.35)'};
        color:${inTradeColor};font-size:10px;font-weight:700;letter-spacing:.06em;
        animation:pending-pulse 1.4s infinite">● IN TRADE</span>
      <span style="font-size:10px;color:#555">${elapsed(trade.opened_at)}</span>
      <span style="background:${exchBg};border:1px solid ${exchBorder};color:${exchColor};border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700">${exchange}</span>
      <span style="flex:1"></span>
      <span style="font-family:'Bebas Neue',sans-serif;font-size:21px;color:#fff;letter-spacing:0.05em;line-height:1">${alert.symbol}</span>
      ${dirBadge}
    </div>
    <!-- LIVE ROW -->
    <div style="display:flex;gap:0;padding:8px 14px;border-bottom:1px solid #1a1e2a;background:rgba(255,255,255,0.015)">
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">ENTRY</div>
        <div style="font-size:13px;font-weight:700;color:#aaa;font-family:'JetBrains Mono',monospace">${fmtPrice(entry)}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">CURRENT</div>
        <div style="font-size:13px;font-weight:700;color:#fff;font-family:'JetBrains Mono',monospace">${fmtPrice(currentPx)}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">PNL</div>
        <div style="font-size:13px;font-weight:700;color:${pnlColor}">${pnlSign}$${fmt(pnl, 2)}</div>
        <div style="font-size:10px;color:${rColor}">${rSign}${fmt(r, 2)}R</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">DURATION</div>
        <div style="font-size:13px;font-weight:700;color:#aaa">${elapsed(trade.opened_at)}</div>
      </div>
    </div>
    ${trailHtml}
    <!-- LEVELS -->
    <div style="padding:10px 14px;border-bottom:1px solid #1a1e2a">${levelsHtml}</div>
    <!-- MARGIN ROW -->
    <div style="display:flex;gap:0;padding:8px 14px;border-bottom:1px solid #1a1e2a">
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">LEVERAGE</div>
        <div style="font-size:13px;font-weight:700;color:#fff">${lev}x</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">MARGIN</div>
        <div style="font-size:13px;font-weight:700;color:#fff">$${fmt(margin, 0)}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">${tp1Hit ? 'PARTIAL ✓' : 'STATUS'}</div>
        <div style="font-size:11px;font-weight:700;color:${tp1Hit ? '#f97316' : '#aaa'}">${tp1Hit ? 'TP1 HIT' : 'OPEN'}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:9px;color:#555;font-weight:700;letter-spacing:.06em">ADX ENTRY</div>
        <div style="font-size:13px;font-weight:700;color:${(adx||0)>=30?'#00ff88':'#666'}">${fmt(adx, 1)}</div>
      </div>
    </div>
    <!-- CLOSE BUTTON -->
    <div style="padding:10px 14px">
      <button onclick="closeTrade('${alert.symbol}', '${alert.direction}')"
        style="width:100%;padding:10px;border-radius:6px;
          border:1px solid rgba(255,68,68,0.45);background:rgba(255,68,68,0.1);
          color:#ff4444;font-family:var(--font);font-size:11px;font-weight:700;
          letter-spacing:.08em;cursor:pointer">
        ■ CLOSE ON ${exchange}
      </button>
    </div>
  </div>`;
}

// ── Alerts render (tiered layout) ─────────────────────────────────────────────

function renderAlerts() {
  if (!state) return;
  const container  = document.getElementById('alerts-container');
  const allAlerts  = (state.alerts || []).slice().reverse();
  const pendings   = (state.pending_alerts || []).slice().reverse();
  const openTrades = state.open_trades || {};
  const acc        = state.account || {};
  const capReached = acc.cap_reached;

  const confirmedKeys   = new Set(allAlerts.map(a => `${a.symbol}${a.direction}`));
  const visiblePendings = pendings.filter(p => !confirmedKeys.has(`${p.symbol}${p.direction}`));

  if (allAlerts.length === 0 && visiblePendings.length === 0) {
    container.innerHTML = `
      <div class="alerts-empty">
        Scanning every 20s.<br>Alerts appear here when<br>all 4 conditions pass twice.
      </div>`;
    return;
  }

  // Sort confirmed alerts into tiers
  const inTradeAlerts = [];
  const tier1 = [], tier2 = [], tier3 = [];

  for (const alert of allAlerts) {
    const key   = `${alert.symbol}${alert.direction}`;
    const trade = openTrades[key];
    if (trade) {
      inTradeAlerts.push({ alert, trade });
    } else {
      const ts = getAlertTier(alert);
      if (ts === 'HIGH_PROB')   tier1.push(alert);
      else if (ts === 'STRONG') tier2.push(alert);
      else                      tier3.push(alert);
    }
  }

  let html = '<div class="alerts-list">';

  // PENDING cards (first confirmation scan)
  for (const p of visiblePendings) {
    const isLong = p.direction === 'LONG';
    html += `
      <div class="alert-card" style="border-left:3px solid #ffaa00;opacity:0.85;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="
            display:inline-flex;align-items:center;gap:6px;
            padding:3px 8px;border-radius:4px;
            background:rgba(255,170,0,0.12);border:1px solid rgba(255,170,0,0.4);
            color:#ffaa00;font-size:10px;font-weight:700;letter-spacing:.06em;
            animation:pending-pulse 1.4s infinite
          ">⏳ PENDING RECONFIRMATION</span>
        </div>
        <div class="alert-header-row">
          <div class="alert-sig">
            <span class="alert-sym">${p.symbol}</span>
            <span class="dir-pill ${isLong ? 'dir-long' : 'dir-short'}">${p.direction}</span>
          </div>
          <div class="alert-score">ADX <span style="color:${(p.adx||0) >= 30 ? '#00ff88' : '#666'}">${fmt(p.adx, 1)}</span></div>
        </div>
        <div class="alert-grid">
          <div class="ag-row">
            <span class="ag-label">Trend</span>
            <span class="ag-val ${isLong ? 'trend-bull' : 'trend-bear'}">${p.trend}</span>
          </div>
          <div class="ag-row">
            <span class="ag-label">First seen</span>
            <span class="ag-val" style="color:var(--muted)">${relTime(p.first_seen)}</span>
          </div>
        </div>
        <div class="alert-footer">
          <span class="alert-time" style="color:#ffaa00">Awaiting next scan…</span>
        </div>
      </div>`;
  }

  // TIER 1 — HIGH PROBABILITY
  if (tier1.length > 0) {
    html += buildTierHeader('HIGH_PROB', tier1.length);
    for (const a of tier1) html += buildSignalCard(a, capReached);
  }

  // TIER 2 — STRONG
  if (tier2.length > 0) {
    html += buildTierHeader('STRONG', tier2.length);
    for (const a of tier2) html += buildSignalCard(a, capReached);
  }

  // TIER 3 — REGULAR
  if (tier3.length > 0) {
    html += buildTierHeader('REGULAR', tier3.length);
    for (const a of tier3) html += buildSignalCard(a, capReached);
  }

  // TIER 4 — IN TRADE
  if (inTradeAlerts.length > 0) {
    html += buildTierHeader('IN_TRADE', inTradeAlerts.length);
    for (const { alert, trade } of inTradeAlerts) html += buildInTradeCard(alert, trade);
  }

  html += '</div>';
  container.innerHTML = html;
}

// ── Clear stale alerts ────────────────────────────────────────────────────────

async function clearStaleAlerts() {
  const btn = document.getElementById('clear-stale-btn');
  try {
    const res  = await fetch('/api/alerts/stale', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { showToast(data.detail || 'Failed to clear stale alerts'); return; }
    showToast(`Cleared ${data.removed} stale alert${data.removed !== 1 ? 's' : ''}`);
    if (btn) {
      btn.textContent = '✓ CLEARED';
      btn.style.background  = 'rgba(0,255,136,0.15)';
      btn.style.borderColor = 'rgba(0,255,136,0.4)';
      btn.style.color = '#00ff88';
      setTimeout(() => {
        btn.textContent = '✕ CLEAR STALE';
        btn.style.background  = '';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 1500);
    }
    await fetchState();
    renderAll();
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

// ── Render all ────────────────────────────────────────────────────────────────

// ── MA Stack Overlay ─────────────────────────────────────────────────────────

const MA_STACK_INFO = {
  BULL:    { sym: '▲', label: 'BULLISH STACK',  color: '#00ff88', bg: 'rgba(0,255,136,0.10)',   border: 'rgba(0,255,136,0.30)'  },
  BEAR:    { sym: '▼', label: 'BEARISH STACK',  color: '#ff4444', bg: 'rgba(255,68,68,0.10)',    border: 'rgba(255,68,68,0.30)'  },
  MIXED:   { sym: '⟷', label: 'MIXED',          color: '#ffaa00', bg: 'rgba(255,170,0,0.10)',   border: 'rgba(255,170,0,0.30)'  },
  NEUTRAL: { sym: '○', label: 'NEUTRAL',         color: '#66aaff', bg: 'rgba(100,160,255,0.10)', border: 'rgba(100,160,255,0.30)' },
};

function handleSymClick(sym) {
  if (activeMASymbol === sym) hideMAOverlay();
  else showMAOverlay(sym);
}

function showMAOverlay(sym) {
  activeMASymbol = sym;
  const overlay   = document.getElementById('ma-overlay');
  const sidePanel = document.getElementById('side-panel');
  if (sidePanel) sidePanel.style.display = 'none';
  if (overlay)   overlay.style.display = 'flex';
  renderMAOverlay(sym);
  renderPairTable();
}

function hideMAOverlay() {
  activeMASymbol = null;
  const overlay   = document.getElementById('ma-overlay');
  const sidePanel = document.getElementById('side-panel');
  if (overlay)   overlay.style.display = 'none';
  if (sidePanel) sidePanel.style.display = '';
  renderPairTable();
}

function buildMATFBlock(tf, d) {
  const { ma5, ma10, ma30, ma60, ma5_dir, ma10_dir, ma30_dir, ma60_dir, stack: tfStack, price: pv } = d || {};
  const si  = MA_STACK_INFO[tfStack] || MA_STACK_INFO.NEUTRAL;
  const p   = pv || 0;

  const vals = [ma5, ma10, ma30, ma60].filter(v => v != null);
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 1;
  const span = maxV - minV || 1;
  const barW = v => v == null ? 40 : Math.round(40 + (v - minV) / span * 55);

  const rowC = (a, b) => {
    if (a == null || b == null) return '#555555';
    return a > b ? '#00ff88' : a < b ? '#ff4444' : '#888888';
  };
  const dirSym = d => d === 'UP' ? '↑' : d === 'DOWN' ? '↓' : '→';

  const maRows = [
    { label: 'MA5',  val: ma5,  dir: ma5_dir,  color: rowC(p,   ma5)  },
    { label: 'MA10', val: ma10, dir: ma10_dir, color: rowC(ma5, ma10) },
    { label: 'MA30', val: ma30, dir: ma30_dir, color: rowC(ma10, ma30) },
    { label: 'MA60', val: ma60, dir: ma60_dir, color: rowC(ma30, ma60) },
  ];

  const rowsHtml = maRows.map(r =>
    `<div class="ma-row" style="color:${r.color}">` +
    `<span class="ma-row-label">${r.label}</span>` +
    `<div class="ma-bar-wrap"><div class="ma-bar" style="width:${barW(r.val)}%;background:${r.color}"></div></div>` +
    `<span class="ma-row-val">${r.val != null ? fmtPrice(r.val) : '—'}</span>` +
    `<span class="ma-row-dir">${dirSym(r.dir)}</span>` +
    `</div>`
  ).join('');

  const badgeHtml = `<div class="ma-stack-badge" style="background:${si.bg};border:1px solid ${si.border};color:${si.color}">${si.sym} ${si.label}</div>`;

  const dotColor = tf.key === '5m' ? '#ffaa00' : tf.key === '15m' ? '#66aaff' : '#00ff88';
  const dot = `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${dotColor};margin-right:6px;vertical-align:middle;flex-shrink:0"></span>`;

  return `<div class="ma-tf-block">` +
    `<div class="ma-tf-label">${dot}<span style="font-size:9px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:1px">${tf.label}</span></div>` +
    rowsHtml + badgeHtml +
    `</div>`;
}

function buildMAAlignmentSummary(mad, trend) {
  const h1Stack = (mad['1h'] || {}).stack || 'NEUTRAL';
  const tfs = [
    { key: '5m', label: '5M' }, { key: '15m', label: '15M' }, { key: '1h', label: '1H' },
  ];

  const rows = tfs.map(tf => {
    const d     = mad[tf.key] || {};
    const stack = d.stack || 'NEUTRAL';
    const si    = MA_STACK_INFO[stack] || MA_STACK_INFO.NEUTRAL;

    let gateHtml;
    if (tf.key === '1h') {
      const pass = (stack === 'BULL' && trend === 'Strong Bull') || (stack === 'BEAR' && trend === 'Strong Bear');
      gateHtml = pass
        ? `<span style="color:#00ff88;font-size:9px;font-weight:700;font-family:'JetBrains Mono',monospace">PASS</span>`
        : `<span style="color:#444444;font-size:9px;font-family:'JetBrains Mono',monospace">FAIL</span>`;
    } else {
      const aligns = stack === h1Stack && (stack === 'BULL' || stack === 'BEAR');
      gateHtml = aligns
        ? `<span style="color:#ffaa00;font-size:9px;font-weight:700;font-family:'JetBrains Mono',monospace">ALIGNS</span>`
        : `<span style="color:#444444;font-size:9px;font-family:'JetBrains Mono',monospace">—</span>`;
    }

    return `<div style="display:flex;align-items:center;height:22px">` +
      `<span style="width:28px;font-size:9px;color:#555555;flex-shrink:0;font-family:'JetBrains Mono',monospace">${tf.label}</span>` +
      `<span style="flex:1;font-size:9px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${si.color}">${si.sym} ${si.label}</span>` +
      gateHtml + `</div>`;
  }).join('');

  return `<div class="ma-align-section">` +
    `<div style="font-size:9px;font-weight:700;color:#ffffff;letter-spacing:1px;text-transform:uppercase;margin-bottom:5px">ALIGNMENT SUMMARY</div>` +
    rows + `</div>`;
}

function renderMAOverlay(sym) {
  if (!state || !sym) return;
  const overlay = document.getElementById('ma-overlay');
  if (!overlay) return;

  const pairs = state.pair_states || [];
  const p = pairs.find(x => x.symbol === sym);
  if (!p) return;

  const nameEl = overlay.querySelector('.ma-overlay-sym');
  if (nameEl) nameEl.textContent = sym;

  const mad = ((p.ma_data || {}).timeframes) || {};
  const trend = p.trend || 'Neutral';

  const tfs = [
    { key: '5m', label: '5M' }, { key: '15m', label: '15M' }, { key: '1h', label: '1H' },
  ];

  const blocksHtml = tfs.map(tf => buildMATFBlock(tf, mad[tf.key] || {})).join('');
  const alignHtml  = buildMAAlignmentSummary(mad, trend);

  const contentEl = overlay.querySelector('.ma-overlay-content');
  if (contentEl) contentEl.innerHTML = blocksHtml + alignHtml;
}

// ── Card grid ─────────────────────────────────────────────────────────────────

function pillHtml(label, val, valColor, bgTint) {
  const bg = bgTint ? `background:${bgTint};` : '';
  return `<div class="card-pill" style="${bg}">` +
    `<span class="card-pill-label">${label}</span>` +
    `<span class="card-pill-val" style="color:${valColor}">${val}</span>` +
    `</div>`;
}

// ── Gate status pill helpers ────────────────────────────────────────────────

function _jPass(j1h, adx, isLong) {
  return isLong ? (j1h <= 20 || (adx >= 50 && j1h <= 45))
                : (j1h >= 80 || (adx >= 50 && j1h >= 55));
}

function buildGateStatusPill(p, gs, adx, j1h, j_pass, allPass) {
  if (allPass) return `<div class="gate-pass-pill">✓ ALL GATES PASS</div>`;
  const isLong = gs.gates_direction !== 'SHORT';
  if (!gs.trend_pass) return `<div class="gate-blocked-pill">TREND NEU · MA not aligned</div>`;
  if (!gs.adx_pass)   return `<div class="gate-blocked-pill">ADX ${fmt(adx,1)} · below min</div>`;
  if (!gs.depth_pass) {
    const d = isLong ? (p.bid_pct ?? 50) : (p.ask_pct ?? 50);
    return `<div class="gate-blocked-pill">DEPTH ${fmt(d,1)}% · need 60%</div>`;
  }
  if (!j_pass) {
    const thr = adx >= 50 ? (isLong ? 45 : 55) : (isLong ? 20 : 80);
    const dir = isLong ? '<' : '>';
    return `<div class="gate-blocked-pill">J ${fmt(j1h,1)} · need ${dir}${thr}</div>`;
  }
  return '';
}

function buildCardStatusBar(p, sst, trade, ot, j_pass, allPass, gs) {
  const passCount = [gs.trend_pass, gs.adx_pass, gs.depth_pass, j_pass].filter(Boolean).length;
  if (sst === 'IN_TRADE' && trade) {
    const dir = ot[`${p.symbol}LONG`] ? 'LONG' : 'SHORT';
    const dirC = dir === 'LONG' ? '#00ff88' : '#ff4444';
    const dur = elapsed(trade.opened_at);
    const pnl = trade.unrealized_pnl ?? null;
    const r = trade.r ?? null;
    const pnlStr = pnl !== null ? ` · ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}` : '';
    const rStr = r !== null ? ` · ${r >= 0 ? '+' : ''}${fmt(r,2)}R` : '';
    return `<div class="card-status-bar" style="color:${dirC}"><span class="sig-pulse" style="color:${dirC}">●</span> IN TRADE ${dur} · ${dir}${pnlStr}${rStr}</div>`;
  }
  if (sst === 'ALERT') {
    const dir = p.signal_direction || '';
    return `<div class="card-status-bar" style="background:rgba(0,255,136,0.06);border-top-color:rgba(0,255,136,0.2);color:#00ff88">🔔 CONFIRMED · ${dir} · TAP SYMBOL TO OPEN</div>`;
  }
  if (sst === 'PENDING') {
    const dir = p.signal_direction || '';
    return `<div class="card-status-bar" style="background:rgba(255,170,0,0.06);border-top-color:rgba(255,170,0,0.2);color:#ffaa00">⏳ SCAN 1 OF 2 — CONFIRMING ${dir}</div>`;
  }
  if (allPass) return `<div class="card-status-bar" style="color:#00ff88">✓ ALL GATES PASS · awaiting 2nd scan</div>`;
  if (passCount === 0) return `<div class="card-status-bar">0/4 GATES · not trending</div>`;
  return `<div class="card-status-bar">${passCount}/4 GATES · tap symbol for detail</div>`;
}

function buildPairCard(p) {
  const livePrice = (state.prices && state.prices[p.symbol]) || p.price;
  const sst = p.signal_state || 'SCANNING';
  const ts  = p.trend_strength || 'NEUTRAL';
  const tp  = p.trend_pill || 'NEUTRAL';

  // ── CHANGE 2: Card classes with glow ──────────────────────────────────────
  let cc = 'pair-card';
  if (sst === 'PENDING') cc += ' state-pending';
  else if (sst === 'ALERT') cc += ' state-alert';
  else if (sst === 'IN_TRADE') cc += ' state-trade';
  if (ts === 'HIGH_PROB') cc += (tp.endsWith('_BULL') ? ' hp-bull' : ' hp-bear');
  else if (ts === 'STRONG') cc += ' card-strong';

  const gs  = p.gates_status || {};
  const adx = p.adx ?? 0;
  const j1h = p.j5 ?? 50;
  const isLong = gs.gates_direction !== 'SHORT';
  const j_pass = _jPass(j1h, adx, isLong);
  const allPass = gs.trend_pass && gs.adx_pass && gs.depth_pass && j_pass;

  // ── CHANGE 4: Gate dots T·A·D·J ───────────────────────────────────────────
  const passCount = [gs.trend_pass, gs.adx_pass, gs.depth_pass, j_pass].filter(Boolean).length;
  const nearMiss  = passCount === 3;
  const gDot = (pass, isJ) => {
    const bg = pass ? '#00ff88' : (nearMiss && !pass && isJ ? '#ffaa00' : '#1c1c1c');
    const border = pass ? '' : `border:1px solid ${nearMiss && !pass && isJ ? '#332200' : '#2a2a2a'};`;
    return `<span style="width:6px;height:6px;border-radius:50%;display:inline-block;background:${bg};${border}flex-shrink:0"></span>`;
  };
  const tadj_color = allPass ? '#00ff88' : '#2a2a2a';
  const gatesPill = `<div style="background:#111;border:1px solid #1e1e1e;border-radius:5px;padding:2px 5px;display:flex;align-items:center;gap:3px;flex-shrink:0">` +
    gDot(gs.trend_pass,false) + gDot(gs.adx_pass,false) + gDot(gs.depth_pass,false) + gDot(j_pass,true) +
    `<span style="font-family:'JetBrains Mono',monospace;font-size:6px;font-weight:700;color:${tadj_color};margin-left:2px;letter-spacing:0.3px">T·A·D·J</span>` +
    `</div>`;

  // ── ROW 1: Symbol (CHANGE 3 glow + CONF badge) + trend pill + gates + price
  const tpHtml = buildTrendPill(tp);
  let symStyle = 'color:#ffffff;';
  if (allPass && tp.endsWith('_BULL')) symStyle = 'color:#00ff88;text-shadow:0 0 10px rgba(0,255,136,0.7);';
  else if (allPass && tp.endsWith('_BEAR')) symStyle = 'color:#ff4444;text-shadow:0 0 10px rgba(255,68,68,0.7);';
  else if (tp === 'NEUTRAL') symStyle = 'color:#66aaff;';
  const confBadge = allPass ? `<span class="conf-badge">CONF</span>` : '';
  const ch = p.change_24h ?? null;
  const chColor = ch === null ? '#555' : ch > 0 ? '#00ff88' : ch < 0 ? '#ff4444' : '#555';
  const chStr   = ch !== null ? `${ch > 0 ? '+' : ''}${fmt(Math.abs(ch), 1)}%` : '';

  const row1 = `<div class="card-row1">` +
    `<div class="card-identity">` +
    `<span class="card-sym" style="${symStyle}position:relative;cursor:pointer" onclick="openLayoutCard('${p.symbol}')">${p.symbol}${confBadge}</span>` +
    tpHtml + gatesPill +
    `</div>` +
    `<div class="card-price-col">` +
    `<span class="card-price">${fmtPrice(livePrice)}</span>` +
    `<span style="font-size:9px;font-weight:700;color:${chColor};display:block;text-align:right">${chStr}</span>` +
    `</div></div>`;

  // ── ROW 2: Indicator pills + CHANGE 5 (blocked pill) + CHANGE 6 (ADX tier)
  const adxColor = adx >= 50 ? '#00ff88' : adx >= 25 ? '#ffaa00' : '#555555';
  let adxTier = '';
  if      (adx >= 60) adxTier = `<span class="adx-tier adx-tier-high">HIGH</span>`;
  else if (adx >= 40) adxTier = `<span class="adx-tier adx-tier-strong">STR</span>`;
  else if (adx >= 25) adxTier = `<span class="adx-tier adx-tier-reg">REG</span>`;
  const adxPill = `<div class="card-pill">` +
    `<span class="card-pill-label">ADX</span>` +
    `<span class="card-pill-val" style="color:${adxColor}">${fmt(adx,1)}${adxTier}</span>` +
    `</div>`;

  const j1hC  = j1h <= 20 ? '#00ff88' : j1h >= 80 ? '#ff4444' : '#ffffff';
  const j15m  = p.j_15m ?? null;
  const j15mC = j15m === null ? '#555' : j15m <= 20 ? '#00ff88' : j15m >= 80 ? '#ff4444' : '#ffffff';
  const j5m   = p.j_5m ?? null;
  const j5mC  = j5m === null ? '#555' : j5m <= 20 ? '#00ff88' : j5m >= 80 ? '#ff4444' : '#ffffff';

  let fundPill = '';
  const fr = p.funding_rate ?? null;
  if (fr !== null) {
    const frPct = fr * 100;
    const frC = Math.abs(frPct) < 0.001 ? '#555' : frPct < 0 ? '#00ff88' : '#ff4444';
    fundPill = pillHtml('FUND', `${frPct >= 0 ? '+' : ''}${frPct.toFixed(4)}%`, frC);
  }

  const ot = state.open_trades || {};
  const trade = ot[`${p.symbol}LONG`] || ot[`${p.symbol}SHORT`];
  let volOrPnl = '';
  if (trade) {
    const pnlV = trade.unrealized_pnl ?? null;
    const rV   = trade.r ?? null;
    const pnlC = pnlV === null ? '#555' : pnlV >= 0 ? '#00ff88' : '#ff4444';
    const rC   = rV   === null ? '#555' : rV   >= 0 ? '#00ff88' : '#ff4444';
    volOrPnl = pillHtml('PNL', pnlV !== null ? `${pnlV >= 0 ? '+' : ''}$${Math.abs(pnlV).toFixed(0)}` : '—', pnlC) +
               pillHtml('R',   rV   !== null ? `${rV   >= 0 ? '+' : ''}${fmt(rV, 2)}` : '—', rC);
  } else {
    const vr = p.vol_ratio ?? null;
    const vrC = vr !== null && vr >= 1.5 ? '#ffaa00' : '#555555';
    volOrPnl = pillHtml('VOL', vr !== null ? `${fmt(vr, 1)}x` : '—', vrC);
  }
  const statusPill = buildGateStatusPill(p, gs, adx, j1h, j_pass, allPass);

  const row2 = `<div class="card-row2">` +
    adxPill +
    pillHtml('1H',  fmt(j1h, 1), j1hC) +
    pillHtml('15M', j15m !== null ? fmt(j15m,1) : '—', j15mC) +
    pillHtml('5M',  j5m  !== null ? fmt(j5m, 1) : '—', j5mC) +
    fundPill + volOrPnl + statusPill +
    `</div>`;

  // ── ROW 3: MA stack + RSI ─────────────────────────────────────────────────
  const mad = ((p.ma_data || {}).timeframes) || {};
  const STACKS = {
    BULL: { label: 'BULL', color: '#00ff88' }, BEAR: { label: 'BEAR', color: '#ff4444' },
    MIXED: { label: 'MIX', color: '#ffaa00' }, NEUTRAL: { label: 'NEU', color: '#66aaff' },
  };
  const sPill = (lbl, key) => {
    const si = STACKS[(mad[key] || {}).stack] || STACKS.NEUTRAL;
    return `<div class="card-pill" style="border-color:${si.color}22">` +
      `<span class="card-pill-label">${lbl}</span>` +
      `<span class="card-pill-val" style="color:${si.color}">${si.label}</span></div>`;
  };
  const rsi  = p.rsi_1h ?? null;
  const rsiC = rsi === null ? '#555' : rsi < 35 ? '#00ff88' : rsi > 65 ? '#ff4444' : '#ffffff';
  const rsiPill = `<div class="card-pill" style="margin-left:auto">` +
    `<span class="card-pill-label">RSI</span>` +
    `<span class="card-pill-val" style="color:${rsiC}">${rsi !== null ? fmt(rsi, 1) : '—'}</span></div>`;
  const row3 = `<div class="card-row3">` +
    `<span class="card-pill-label" style="flex-shrink:0">MA</span>` +
    sPill('5M','5m') + sPill('15M','15m') + sPill('1H','1h') + rsiPill +
    `</div>`;

  // ── ROW 4: Depth (CHANGE 9: wall prices bold white) ───────────────────────
  const bid  = p.bid_pct ?? 50;
  const ask  = p.ask_pct ?? 50;
  const bidW = p.bid_wall != null ? fmtPrice(p.bid_wall) : '—';
  const askW = p.ask_wall != null ? fmtPrice(p.ask_wall) : '—';
  const row4 = `<div class="card-row4">` +
    `<div class="card-depth-bar"><div class="card-depth-bar-fill" style="width:${Math.round(bid)}%"></div></div>` +
    `<div class="card-depth-cols">` +
    `<div><div class="card-pill-label">BUYERS</div><div style="font-size:10px;font-weight:700;color:#00ff88">${fmt(bid,1)}%</div><div style="font-size:9px;font-weight:700;color:#ffffff;font-family:'JetBrains Mono',monospace">${bidW}</div></div>` +
    `<div style="text-align:right"><div class="card-pill-label">SELLERS</div><div style="font-size:10px;font-weight:700;color:#ff4444">${fmt(ask,1)}%</div><div style="font-size:9px;font-weight:700;color:#ffffff;font-family:'JetBrains Mono',monospace">${askW}</div></div>` +
    `</div></div>`;

  // ── CHANGE 7: Bottom status bar ───────────────────────────────────────────
  const statusBar = buildCardStatusBar(p, sst, trade, ot, j_pass, allPass, gs);

  return `<div class="${cc}" data-symbol="${p.symbol}">${row1}${row2}${row3}${row4}${statusBar}</div>`;
}

function renderCardGrid() {
  if (!state) return;
  const grid = document.getElementById('card-grid');
  if (!grid || grid.style.display === 'none') return;

  let pairs = state.pair_states || [];
  const ot  = state.open_trades || {};

  switch (activeFilter) {
    case 'alerts':    pairs = pairs.filter(p => p.signal_state === 'PENDING' || p.signal_state === 'ALERT'); break;
    case 'trades':    pairs = pairs.filter(p => p.signal_state === 'IN_TRADE'); break;
    case 'bear-high': pairs = pairs.filter(p => p.trend_pill === 'HIGH_PROB_BEAR'); break;
    case 'bull-high': pairs = pairs.filter(p => p.trend_pill === 'HIGH_PROB_BULL'); break;
    case 'strong':    pairs = pairs.filter(p => p.trend_pill === 'STRONG_BEAR' || p.trend_pill === 'STRONG_BULL'); break;
    case 'regular':   pairs = pairs.filter(p => p.trend_pill === 'REGULAR_BEAR' || p.trend_pill === 'REGULAR_BULL'); break;
    case 'neutral':   pairs = pairs.filter(p => p.trend_pill === 'NEUTRAL'); break;
  }

  const countEl = document.getElementById('filter-count');
  if (countEl) countEl.textContent = pairs.length;

  grid.innerHTML = pairs.length
    ? pairs.map(p => buildPairCard(p)).join('')
    : `<div style="grid-column:1/-1;text-align:center;color:#555;padding:40px;font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:0.06em">NO PAIRS MATCHING FILTER</div>`;
}

function renderMarketStrip() {
  if (!state) return;
  const strip = document.getElementById('market-strip');
  if (!strip) return;
  const ms = state.market_snapshot || {};
  const tb = ms.trend_bias || {};
  const mb = ms.momentum_bands || {};
  const bears = (tb.strong_bear || []).length;
  const bulls = (tb.strong_bull || []).length;
  const neuts = (tb.neutral || []).length;
  const ob    = (mb.overbought || []).length;
  const os    = (mb.oversold   || []).length;
  const regime = state.btc_regime || 'Neutral';
  const regC   = regime === 'Strong Bull' ? '#00ff88' : regime === 'Strong Bear' ? '#ff4444' : '#ffaa00';
  const regB   = regime === 'Strong Bull' ? 'rgba(0,255,136,0.3)' : regime === 'Strong Bear' ? 'rgba(255,68,68,0.3)' : 'rgba(255,170,0,0.3)';
  const regL   = regime === 'Strong Bull' ? 'BTC ▲' : regime === 'Strong Bear' ? 'BTC ▼' : 'BTC ○';
  const chip = (lbl, col, bdr) =>
    `<span class="ms-chip" style="color:${col};border-color:${bdr}">${lbl}</span>`;
  const sep = `<span class="ms-sep">·</span>`;
  strip.innerHTML =
    chip(`BEAR ${bears}`, '#ff4444', 'rgba(255,68,68,0.3)') + sep +
    chip(`BULL ${bulls}`, '#00ff88', 'rgba(0,255,136,0.3)') + sep +
    chip(`NEU ${neuts}`,  '#66aaff', 'rgba(100,160,255,0.2)') + sep +
    chip(regL, regC, regB) + sep +
    chip(`OB ${ob}`, '#ff4444', 'rgba(255,68,68,0.15)') + sep +
    chip(`OS ${os}`, '#00ff88', 'rgba(0,255,136,0.15)');
}

// ── CHANGE 1: J Opportunity Map ───────────────────────────────────────────────

function renderJMap() {
  const jmap = document.getElementById('j-map');
  if (!jmap || !state) return;
  const pairs = state.pair_states || [];
  if (!pairs.length) return;
  jmap.classList.add('loaded');

  function renderTrack(isLong) {
    const label = isLong ? 'LONG OPPORTUNITY — NEED J &lt; 20 (OR &lt;45 RELAXED)' : 'SHORT OPPORTUNITY — NEED J &gt; 80 (OR &gt;55 RELAXED)';
    const usedBuckets = {};
    const dots = pairs.map(p => {
      const j   = p.j5 ?? 50;
      const adx = p.adx ?? 0;
      const gs  = p.gates_status || {};
      const jp  = _jPass(j, adx, isLong);
      const allP = gs.trend_pass && gs.adx_pass && gs.depth_pass && jp;
      let cls;
      if (isLong  && j <= 20)                         cls = allP ? 'jd-conf' : 'jd-os';
      else if (!isLong && j >= 80)                    cls = allP ? 'jd-conf' : 'jd-ob';
      else if (isLong  && adx >= 50 && j <= 45)       cls = 'jd-relax';
      else if (!isLong && adx >= 50 && j >= 55)       cls = 'jd-relax';
      else                                             cls = 'jd-mid';

      const leftPct = Math.max(0.5, Math.min(99.5, j));
      const bucket  = Math.round(leftPct / 4) * 4;
      const above   = !usedBuckets[bucket];
      usedBuckets[bucket] = true;
      const labelY  = above ? -14 : 20;
      return `<span class="j-dot ${cls}" title="${p.symbol} J=${j}" style="left:${leftPct}%;top:50%">` +
        `<span class="j-dot-label" style="top:${labelY}px;left:50%">${p.symbol.replace('USDT','').replace('PERP','')}</span>` +
        `</span>`;
    }).join('');

    return `<div class="j-track-wrap">` +
      `<div class="j-track-label">${label}</div>` +
      `<div class="j-track">` +
        `<div class="j-zone-os"></div>` +
        `<div class="j-zone-ob"></div>` +
        `<div class="j-relax-line-l"></div>` +
        `<div class="j-relax-line-r"></div>` +
        dots +
      `</div>` +
      `<div class="j-axis"><span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100</span></div>` +
      `</div>`;
  }

  const legDot = (cls, label) =>
    `<div class="j-map-legend-item">` +
    `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0;${cls==='jd-os'?'background:#00ff88':cls==='jd-ob'?'background:#ff4444':cls==='jd-relax'?'background:#ffaa00':'background:#00ff88;animation:conf-glow 1.5s ease-in-out infinite'}"></span>${label}` +
    `</div>`;

  jmap.innerHTML =
    `<div class="j-map-header">` +
    `<span class="j-map-title">J — OPPORTUNITY MAP · 1H KDJ</span>` +
    `<div class="j-map-legend">` +
    legDot('jd-os','OS') + legDot('jd-ob','OB') + legDot('jd-relax','RELAXED') + legDot('jd-conf','CONF') +
    `</div></div>` +
    renderTrack(true) + renderTrack(false);
}

// ── CHANGE 8: Layout Card Modal ────────────────────────────────────────────────

function openLayoutCard(sym) {
  const overlay = document.getElementById('layout-overlay');
  if (!overlay || !state) return;
  const p = (state.pair_states || []).find(x => x.symbol === sym);
  if (!p) return;
  overlay.innerHTML = buildLayoutCard(p);
  overlay.classList.remove('hidden');
}

function closeLayoutCard(e) {
  if (e && e.target && e.target.id !== 'layout-overlay') return;
  const overlay = document.getElementById('layout-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function buildLayoutCard(p) {
  const livePrice = (state.prices && state.prices[p.symbol]) || p.price;
  const ts  = p.trend_strength || 'NEUTRAL';
  const tp  = p.trend_pill || 'NEUTRAL';
  const adx = p.adx ?? 0;
  const j1h = p.j5 ?? 50;
  const gs  = p.gates_status || {};
  const gd  = p.gates_detail || {};
  const isLong = gs.gates_direction !== 'SHORT';
  const j_pass = _jPass(j1h, adx, isLong);
  const allPass = gs.trend_pass && gs.adx_pass && gs.depth_pass && j_pass;

  const ch = p.change_24h ?? null;
  const chColor = ch === null ? '#555' : ch >= 0 ? '#00ff88' : '#ff4444';
  const chStr   = ch !== null ? `${ch >= 0 ? '+' : ''}${fmt(Math.abs(ch),1)}%` : '';

  const dir = tp.endsWith('_BULL') ? 'BULL' : tp.endsWith('_BEAR') ? 'BEAR' : '';
  const dirC = dir === 'BULL' ? '#00ff88' : dir === 'BEAR' ? '#ff4444' : '#aaa';
  const tier = ts === 'HIGH_PROB' ? 'HIGH' : ts === 'STRONG' ? 'STRONG' : ts === 'REGULAR' ? 'REG' : '';
  const tierC = ts === 'HIGH_PROB' ? '#00ff88' : ts === 'STRONG' ? '#ffaa00' : '#aaa';
  const badgesHtml = [
    dir  ? `<span style="padding:2px 6px;border-radius:3px;border:1px solid ${dirC}33;font-size:9px;font-weight:700;color:${dirC}">${dir}</span>` : '',
    tier ? `<span style="padding:2px 6px;border-radius:3px;border:1px solid ${tierC}33;font-size:9px;font-weight:700;color:${tierC}">${tier}</span>` : '',
    `<span style="padding:2px 6px;border-radius:3px;border:1px solid #ffaa0033;font-size:9px;font-weight:700;color:#ffaa00">ADX ${fmt(adx,1)}</span>`,
  ].filter(Boolean).join('');

  // Gate bars
  function gateBar(letter, name, pass, fillPct, thrPct, detail, valueStr, thr2Pct) {
    const fc  = pass ? '#00ff88' : '#ff4444';
    const sta = pass
      ? `<span style="color:#00ff88;font-size:9px;font-weight:700">✓ PASS</span>`
      : `<span style="color:#ff4444;font-size:9px;font-weight:700">✗ FAIL</span>`;
    const m1  = thrPct  != null ? `<div class="lc-gate-bar-marker" style="left:${Math.min(100,thrPct)}%"></div>` : '';
    const m2  = thr2Pct != null ? `<div class="lc-gate-bar-marker" style="left:${Math.min(100,thr2Pct)}%;background:#ffaa00;opacity:0.7"></div>` : '';
    return `<div class="lc-gate-row">` +
      `<div class="lc-gate-header">` +
        `<span class="lc-gate-letter">${letter}</span>` +
        `<span class="lc-gate-name">${name}</span>` +
        `<span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#666">${valueStr}</span>` +
        `<span style="margin-left:auto">${sta}</span>` +
      `</div>` +
      `<div class="lc-gate-bar-track">` +
        `<div class="lc-gate-bar-fill" style="width:${Math.min(100,Math.max(0,fillPct))}%;background:${fc}"></div>` +
        m1 + m2 +
      `</div>` +
      `<div class="lc-gate-detail">${detail}</div>` +
      `</div>`;
  }

  const tFill   = gs.trend_pass ? 100 : 25;
  const tDetail = `MA stack: ${p.trend||'Neutral'} — needs Strong Bull or Strong Bear`;
  const gT      = gateBar('T','TREND', gs.trend_pass, tFill, null, tDetail, p.trend||'Neutral', null);

  const aFill   = Math.min(100, (adx/80)*100);
  const aThr    = ((gd.adx_value != null ? 25 : 25)/80)*100;
  const aDetail = `ADX ${fmt(adx,1)} — minimum ${gd.adx_value != null ? 25 : 25} to qualify`;
  const gA      = gateBar('A','ADX', gs.adx_pass, aFill, aThr, aDetail, fmt(adx,1), null);

  const dPct    = gd.depth_pct ?? (isLong ? (p.bid_pct??50) : (p.ask_pct??50));
  const dDetail = `${isLong?'Bid':'Ask'} ${fmt(dPct,1)}% — need ≥60% on the ${isLong?'buy':'sell'} side`;
  const gD      = gateBar('D','DEPTH', gs.depth_pass, dPct, 60, dDetail, `${fmt(dPct,1)}%`, null);

  const jStd    = gd.j_threshold_standard ?? (isLong ? 20 : 80);
  const jRlx    = gd.j_threshold_relaxed  ?? (isLong ? 45 : 55);
  const jTier   = gd.j_tier || (adx >= 50 ? 'relaxed' : 'standard');
  const jReason = gd.j_tier_reason || `ADX ${fmt(adx,1)} ${adx>=50?'≥':'<'} 50 — ${jTier} tier`;
  const jThr2   = jTier === 'relaxed' ? jRlx : null;
  const jDetail = `J ${fmt(j1h,1)} — ${jTier}: need ${isLong?'<':'>'}${jTier==='relaxed'?jRlx:jStd} · ${jReason}`;
  const gJ      = gateBar('J','KDJ J 1H', j_pass, j1h, jStd, jDetail, fmt(j1h,1), jThr2);

  // Scan history
  const history = p.scan_history || [];
  const histHtml = history.length === 0
    ? `<div style="color:#333;font-size:8px;font-family:'JetBrains Mono',monospace">No scan history yet — runs after first scan</div>`
    : history.map((h, i) => {
        const chip = (pass, lbl) =>
          `<span class="lc-history-chip ${pass?'lc-chip-pass':'lc-chip-fail'}">${lbl}${pass?'✓':'✗'}</span>`;
        const when = h.scanned_at ? relTime(h.scanned_at) : '—';
        const allP = h.trend_pass && h.adx_pass && h.depth_pass && h.j_pass;
        const allPBadge = allP ? `<span style="color:#00ff88;font-size:7px;font-weight:700;margin-left:4px">ALL PASS</span>` : '';
        return `<div class="lc-history-row">` +
          `<span style="color:#333;width:14px;flex-shrink:0">${i+1}</span>` +
          chip(h.trend_pass,'T') + chip(h.adx_pass,'A') + chip(h.depth_pass,'D') +
          chip(h.j_pass, `J(${fmt(h.j_value??0,0)})`) +
          allPBadge +
          `<span style="color:#333;margin-left:auto;font-size:7px">${when}</span>` +
          (h.reason_failed ? `<span style="color:#333;font-size:7px;margin-left:4px">${h.reason_failed}</span>` : '') +
          `</div>`;
      }).join('');

  // MA strip
  const mad = ((p.ma_data||{}).timeframes) || {};
  const LC_STACKS = { BULL:'#00ff88', BEAR:'#ff4444', MIXED:'#ffaa00', NEUTRAL:'#66aaff' };
  const maStripHtml = `<div class="lc-ma-strip">` +
    ['5m','15m','1h'].map(k => {
      const stk = (mad[k]||{}).stack || 'NEUTRAL';
      const sc  = LC_STACKS[stk] || '#66aaff';
      const lbl = k === '5m' ? '5M' : k === '15m' ? '15M' : '1H';
      return `<div class="lc-ma-pill">` +
        `<span style="font-size:7px;font-weight:700;color:#fff;font-family:'JetBrains Mono',monospace">${lbl}</span>` +
        `<span style="font-size:10px;font-weight:700;color:${sc};font-family:'JetBrains Mono',monospace">${stk}</span>` +
        `</div>`;
    }).join('') +
    `</div>`;

  // Recent trades
  const log = (state.trade_log || []).filter(t => t.symbol === p.symbol).slice(-3).reverse();
  const tradesHtml = log.length === 0
    ? `<div style="color:#333;font-size:8px;font-family:'JetBrains Mono',monospace">No completed trades for ${p.symbol}</div>`
    : log.map(t => {
        const pnl = t.pnl ?? 0;
        const r   = t.r ?? 0;
        const pc  = pnl >= 0 ? '#00ff88' : '#ff4444';
        const dc  = t.direction === 'LONG' ? '#00ff88' : '#ff4444';
        return `<div class="lc-trade-row">` +
          `<span style="color:${dc};font-weight:700;width:36px">${t.direction}</span>` +
          `<span>${fmtPrice(t.entry_price)}</span>` +
          `<span style="color:#333">→</span>` +
          `<span>${fmtPrice(t.exit_price)}</span>` +
          `<span style="color:${pc};font-weight:700;margin-left:auto">${pnl>=0?'+':''}$${fmt(pnl,2)}</span>` +
          `<span style="color:${pc};font-weight:700">${r>=0?'+':''}${fmt(r,2)}R</span>` +
          `</div>`;
      }).join('');

  // Exchange buttons
  const ot   = state.open_trades || {};
  const btnDir = isLong ? 'LONG' : 'SHORT';
  const canTrade = allPass || (state.alerts||[]).some(a=>a.symbol===p.symbol);
  const btnsHtml = `<div class="lc-btn-row">` +
    (canTrade
      ? `<button class="lc-btn lc-btn-hl" onclick="openTrade('${p.symbol}','${btnDir}','HL');document.getElementById('layout-overlay').classList.add('hidden')">OPEN ${btnDir} HL</button>` +
        `<button class="lc-btn lc-btn-mexc" onclick="openTrade('${p.symbol}','${btnDir}','MEXC');document.getElementById('layout-overlay').classList.add('hidden')">OPEN ${btnDir} MEXC</button>`
      : `<div style="flex:1;padding:10px;border-radius:6px;background:#111;border:1px solid #1e1e1e;text-align:center;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;color:#444">WAITING FOR GATE CONFLUENCE</div>`
    ) +
    `</div>`;

  return `<div class="layout-card" onclick="event.stopPropagation()">` +
    `<div class="lc-header">` +
      `<div class="lc-sym-row">` +
        `<span class="lc-sym-name">${p.symbol}</span>${badgesHtml}` +
        `<button class="lc-close" onclick="document.getElementById('layout-overlay').classList.add('hidden')">×</button>` +
      `</div>` +
      `<div class="lc-price-row">` +
        `<span class="lc-price">${fmtPrice(livePrice)}</span>` +
        (ch !== null ? `<span style="font-size:11px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${chColor}">${chStr}</span>` : '') +
      `</div>` +
    `</div>` +
    `<div class="lc-section"><div class="lc-section-title">GATE STATUS — ALL 4 MUST PASS</div>${gT}${gA}${gD}${gJ}</div>` +
    `<div class="lc-section"><div class="lc-section-title">SCAN HISTORY (LAST 3)</div>${histHtml}</div>` +
    `<div class="lc-section"><div class="lc-section-title">MA ALIGNMENT</div>${maStripHtml}</div>` +
    `<div class="lc-section"><div class="lc-section-title">RECENT TRADES</div>${tradesHtml}</div>` +
    btnsHtml +
    `</div>`;
}

// ── Relative time helper (used by layout card) ─────────────────────────────────
function relTime(ts) {
  const s = Math.floor(Date.now()/1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function renderAll() {
  renderHeader();
  renderScanPulse();
  renderJMap();
  renderCardGrid();
  renderMarketStrip();
  if (activeMASymbol) renderMAOverlay(activeMASymbol);
  else renderSidePanel();
  renderAlerts();
  renderTradeLog();
  updateAlertBadge();
}

// ── Trade log render ──────────────────────────────────────────────────────────

function renderTradeLog() {
  const container = document.getElementById('tradelog-container');
  if (!container || !state) return;

  const openTrades = Object.values(state.open_trades || {});
  const log        = (state.trade_log || []).slice().reverse();

  if (openTrades.length === 0 && log.length === 0) {
    container.innerHTML = '<div class="log-empty">No completed trades yet.</div>';
    return;
  }

  let html = '';

  if (openTrades.length > 0) {
    html += `<div style="padding:12px 16px 4px">
      <div style="font-size:10px;font-weight:800;letter-spacing:.12em;color:#ffaa00;margin-bottom:8px;text-transform:uppercase">
        ▶ IN PROGRESS
      </div>
      <div class="log-scroll"><table class="log-table"><thead><tr>
        <th>OPENED</th><th>SYMBOL</th><th>DIR</th><th>ADX</th>
        <th>ENTRY</th><th>CURRENT</th><th>UNREAL PNL</th><th>UNREAL R</th><th>DURATION</th>
      </tr></thead><tbody>`;

    for (const t of openTrades) {
      const isLong   = t.direction === 'LONG';
      const pnl      = t.unrealized_pnl ?? 0;
      const r        = t.r ?? 0;
      const pnlColor = pnl >= 0 ? '#00ff88' : '#ff4444';
      const rColor   = r   >= 0 ? '#00ff88' : '#ff4444';
      const pnlSign  = pnl >= 0 ? '+' : '';
      const rSign    = r   >= 0 ? '+' : '';
      const dirClass = isLong ? 'dir-long' : 'dir-short';
      const openedStr = new Date((t.opened_at || 0) * 1000)
        .toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const elapsedS = t.elapsed_s ?? 0;
      const dur = elapsedS < 60 ? `${elapsedS}s` : `${Math.floor(elapsedS / 60)}m${elapsedS % 60}s`;

      html += `<tr style="border-left:2px solid ${isLong ? '#00ff88' : '#ff4444'}">
        <td style="color:var(--muted);font-size:10px">${openedStr}</td>
        <td class="sym">${t.symbol}</td>
        <td><span class="dir-pill ${dirClass}" style="font-size:9px;padding:2px 5px">${t.direction}</span></td>
        <td style="text-align:right;color:${(t.adx||0)>=30?'#00ff88':'#666666'}">${fmt(t.adx,1)}</td>
        <td style="text-align:right">${fmtPrice(t.entry_price)}</td>
        <td style="text-align:right;color:#ffffff;font-weight:700">${fmtPrice(t.current_price)}</td>
        <td style="color:${pnlColor};font-weight:bold;text-align:right">${pnlSign}$${fmt(pnl,2)}</td>
        <td style="color:${rColor};text-align:right">${rSign}${fmt(r,2)}R</td>
        <td style="color:var(--muted);font-size:10px">${dur}</td>
      </tr>`;
    }

    html += '</tbody></table></div></div>';
  }

  if (log.length > 0) {
    if (openTrades.length > 0) {
      html += `<div style="padding:4px 16px 0">
        <div style="font-size:10px;font-weight:800;letter-spacing:.12em;color:#555;text-transform:uppercase;margin-bottom:8px">
          CLOSED
        </div>`;
    }

    html += '<div class="log-scroll"><table class="log-table"><thead><tr>'
      + '<th>TIME</th><th>SYMBOL</th><th>DIR</th><th>SCORE</th>'
      + '<th>ENTRY</th><th>EXIT</th><th>REASON</th><th>PNL</th><th>R</th><th>DUR</th>'
      + '</tr></thead><tbody>';

    for (const t of log) {
      const dt = new Date(t.timestamp_closed * 1000);
      const timeStr = dt.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const pnlColor = (t.pnl_usd ?? 0) >= 0 ? '#00ff88' : '#ff4444';
      const rColor   = (t.r_value  ?? 0) >= 0 ? '#00ff88' : '#ff4444';
      const pnlSign  = (t.pnl_usd ?? 0) >= 0 ? '+' : '';
      const rSign    = (t.r_value  ?? 0) >= 0 ? '+' : '';
      const dur      = t.duration_seconds < 60
        ? `${t.duration_seconds}s`
        : `${Math.floor(t.duration_seconds / 60)}m${t.duration_seconds % 60}s`;
      const dirClass = t.direction === 'LONG' ? 'dir-long' : 'dir-short';

      html += `<tr>
        <td style="color:var(--muted);font-size:10px">${timeStr}</td>
        <td class="sym">${t.symbol}</td>
        <td><span class="dir-pill ${dirClass}" style="font-size:9px;padding:2px 5px">${t.direction}</span></td>
        <td style="text-align:right">${t.score ?? '—'}</td>
        <td style="text-align:right">${fmtPrice(t.entry_price)}</td>
        <td style="text-align:right">${fmtPrice(t.exit_price)}</td>
        <td style="font-size:10px;color:var(--muted)">${t.exit_reason}</td>
        <td style="color:${pnlColor};font-weight:bold;text-align:right">${pnlSign}$${fmt(t.pnl_usd, 2)}</td>
        <td style="color:${rColor};text-align:right">${rSign}${fmt(t.r_value, 2)}R</td>
        <td style="color:var(--muted);font-size:10px">${dur}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    if (openTrades.length > 0) html += '</div>';
  }

  container.innerHTML = html;
}

// ── Clear confirmation modal ───────────────────────────────────────────────────

function showClearConfirm(openCount) {
  return new Promise(resolve => {
    const existing = document.getElementById('clear-confirm-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'clear-confirm-modal';
    modal.style.cssText = [
      'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:9999;',
      'display:flex;align-items:center;justify-content:center;',
    ].join('');

    const tradeMsg = openCount > 0
      ? `This will force close <b style="color:#ff4444">${openCount} open trade${openCount > 1 ? 's' : ''}</b> and clear the log.`
      : 'This will clear the completed trade log.';

    modal.innerHTML = `
      <div style="
        background:#141720;border:1px solid #2a2f3e;border-radius:10px;
        padding:28px 32px;max-width:360px;width:90%;font-family:var(--font);
        box-shadow:0 24px 80px rgba(0,0,0,0.9);
      ">
        <div style="font-size:14px;font-weight:800;letter-spacing:.08em;color:#ffffff;margin-bottom:12px">CLEAR ALL</div>
        <div style="font-size:12px;color:#888;line-height:1.8;margin-bottom:24px">${tradeMsg}<br>Confirm?</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="cc-cancel" style="
            padding:8px 20px;border-radius:5px;border:1px solid #333;
            background:#1a1e2a;color:#666;font-family:var(--font);
            font-size:11px;font-weight:700;letter-spacing:.06em;cursor:pointer;
          ">CANCEL</button>
          <button id="cc-yes" style="
            padding:8px 20px;border-radius:5px;border:1px solid rgba(255,68,68,0.5);
            background:rgba(255,68,68,0.18);color:#ff4444;font-family:var(--font);
            font-size:11px;font-weight:700;letter-spacing:.06em;cursor:pointer;
          ">YES, CLEAR</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    document.getElementById('cc-cancel').onclick = () => { modal.remove(); resolve(false); };
    document.getElementById('cc-yes').onclick    = () => { modal.remove(); resolve(true); };
    modal.onclick = e => { if (e.target === modal) { modal.remove(); resolve(false); } };
  });
}

async function clearTradeLog() {
  const openCount = Object.keys((state && state.open_trades) || {}).length;
  const confirmed = await showClearConfirm(openCount);
  if (!confirmed) return;

  const btn = document.getElementById('clear-log-btn');
  try {
    await fetch('/api/tradelog', { method: 'DELETE' });
    if (btn) {
      btn.textContent = '✓ CLEARED';
      btn.style.background  = 'rgba(0,255,136,0.15)';
      btn.style.borderColor = 'rgba(0,255,136,0.4)';
      btn.style.color = '#00ff88';
      setTimeout(() => {
        btn.textContent = '✕ CLEAR LOG';
        btn.style.background  = '';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 1500);
    }
    await fetchState();
    renderAll();
  } catch (e) {
    showToast('Error clearing log');
  }
}

// ── Reference pill toggle ─────────────────────────────────────────────────────

function toggleRefPill() {
  const card = document.getElementById('ref-pill-card');
  if (card) card.classList.toggle('open');
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll() {
  await fetchState();
  renderAll();
}

// Restore last active tab from localStorage
try {
  const savedTab = localStorage.getItem('tsp_active_tab');
  if (savedTab) switchTab(savedTab);
} catch(e) {}

// Initial load + 1s refresh
poll();
setInterval(poll, 1000);
