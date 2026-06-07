/* Trend Scanner Part Deux — dashboard.js */

let state = null;
let lastScanCount = -1;
let prevAlertTradeCount = -1;
const cooldownEndsAt = {}; // symbol → Unix timestamp (seconds) when cooldown expires

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

// ── Pair table render (single-row layout V4) ──────────────────────────────────

function buildPairRowHtml(p) {
  const livePrice = (state.prices && state.prices[p.symbol]) || p.price;
  const adx       = p.adx     ?? 0;
  const bid       = p.bid_pct ?? 0;
  const ask       = p.ask_pct ?? 0;
  const bidWall   = p.bid_wall ?? null;
  const askWall   = p.ask_wall ?? null;
  const change24h = p.change_24h ?? null;

  const isStale  = p.data_stale === true;
  const symHtml  = `<span class="sym" style="${isStale ? 'color:#555' : ''}">${p.symbol}${isStale ? '<span style="font-size:7px;color:#444;margin-left:2px">~</span>' : ''}</span>`;
  const trendPill = buildTrendPill(p.trend_pill || 'NEUTRAL');

  // Price column: stacked price + 24H change
  let ch24Line;
  if (change24h !== null && !isNaN(change24h)) {
    const chColor = change24h > 0 ? '#00ff88' : change24h < 0 ? '#ff4444' : '#555';
    const chSign  = change24h > 0 ? '+' : '';
    ch24Line = `<span style="display:block;font-size:10px;color:${chColor};font-weight:700;font-family:'JetBrains Mono',monospace">(${chSign}${fmt(Math.abs(change24h), 1)}%)</span>`;
  } else {
    ch24Line = `<span style="display:block;font-size:10px;color:#555">(—)</span>`;
  }
  const priceHtml = `<span style="display:block;font-size:14px;font-weight:700;color:#fff;font-family:'JetBrains Mono',monospace">${fmtPrice(livePrice)}</span>${ch24Line}`;

  // BUYERS · SELLERS combined pill column
  const buyWallStr  = bidWall !== null ? fmtPrice(bidWall) : '—';
  const sellWallStr = askWall !== null ? fmtPrice(askWall) : '—';
  const buyPill  = `<div style="background:rgba(0,255,136,0.07);border:1px solid rgba(0,255,136,0.18);border-radius:10px;padding:3px 8px;display:flex;align-items:center;gap:4px;margin-bottom:2px">` +
    `<span style="font-size:8px;color:#00ff88;font-weight:700;opacity:0.6">BUY</span>` +
    `<span style="font-size:10px;color:#00ff88;font-weight:700">${fmt(bid, 1)}%</span>` +
    `<span style="font-size:9px;color:#333">\u00b7</span>` +
    `<span style="font-size:10px;color:#ffffff;font-weight:700;font-family:'JetBrains Mono',monospace">${buyWallStr}</span>` +
    `</div>`;
  const sellPill = `<div style="background:rgba(255,68,68,0.07);border:1px solid rgba(255,68,68,0.18);border-radius:10px;padding:3px 8px;display:flex;align-items:center;gap:4px">` +
    `<span style="font-size:8px;color:#ff4444;font-weight:700;opacity:0.6">SELL</span>` +
    `<span style="font-size:10px;color:#ff4444;font-weight:700">${fmt(ask, 1)}%</span>` +
    `<span style="font-size:9px;color:#333">\u00b7</span>` +
    `<span style="font-size:10px;color:#ffffff;font-weight:700;font-family:'JetBrains Mono',monospace">${sellWallStr}</span>` +
    `</div>`;
  const depthPillHtml = `<div style="display:flex;flex-direction:column">${buyPill}${sellPill}</div>`;

  const adxColor = adx >= 30 ? '#00ff88' : '#666666';

  const j5    = p.j5 ?? null;
  const jColor = j5 === null ? '#444444' : j5 <= 20 ? '#00ff88' : j5 >= 80 ? '#ff4444' : '#ffffff';
  const jHtml  = j5 !== null ? fmt(j5, 1) : '—';

  const cdSecs = cooldownEndsAt[p.symbol]
    ? Math.max(0, Math.ceil(cooldownEndsAt[p.symbol] - Date.now() / 1000))
    : (p.cooldown_remaining_seconds || 0);

  const sigState = p.signal_state || 'SCANNING';
  let sigCell;
  switch (sigState) {
    case 'IN_TRADE': {
      const tlDir   = (state.open_trades || {})[`${p.symbol}LONG`] ? 'LONG' : 'SHORT';
      const tlColor = tlDir === 'LONG' ? '#00ff88' : '#ff4444';
      sigCell = `<span style="color:${tlColor};font-size:10px;font-weight:700;letter-spacing:.06em">▶ IN TRADE</span>`;
      break;
    }
    case 'COOLDOWN': {
      const cdM = Math.floor(cdSecs / 60);
      const cdS = cdSecs % 60;
      sigCell = `<span style="color:#666666;font-size:11px;white-space:nowrap">🕐 ${cdM}m${cdS < 10 ? '0' : ''}${cdS}s</span>`;
      break;
    }
    case 'ALERT':
      sigCell = `<span class="sig-pulse" style="color:#00ff88;font-size:10px;font-weight:700;letter-spacing:.04em">🔔 CONFIRMED</span>`;
      break;
    case 'PENDING':
      sigCell = `<span style="color:#ffaa00;font-size:10px;font-weight:700;letter-spacing:.04em">⏳ PENDING</span>`;
      break;
    default:
      sigCell = `<span style="color:#444444;font-size:11px">—</span>`;
  }

  const gs = p.gates_status || {};
  const passCount = [gs.trend_pass, gs.adx_pass, gs.depth_pass, gs.ma_pass].filter(Boolean).length;
  const nearMiss  = passCount === 3;
  function gColor(pass) { return pass ? '#00ff88' : (nearMiss ? '#ffaa00' : '#444444'); }
  const chk = v => v ? '✓' : '✗';
  const tip = [
    `TREND ${chk(gs.trend_pass)}`, `ADX ${chk(gs.adx_pass)}`,
    `DEPTH ${chk(gs.depth_pass)}`, `MA STACK ${chk(gs.ma_pass)}`,
  ].join(' · ');
  const gatesCell = `<div class="gate-dots" title="${tip}">` +
    `<span class="gate-dot" style="background:${gColor(gs.trend_pass)}"></span>` +
    `<span class="gate-dot" style="background:${gColor(gs.adx_pass)}"></span>` +
    `<span class="gate-dot" style="background:${gColor(gs.depth_pass)}"></span>` +
    `<span class="gate-dot" style="background:${gColor(gs.ma_pass)}"></span>` +
    `</div>`;

  return `<tr data-symbol="${p.symbol}" class="pair-row-1">` +
    `<td style="text-align:left">${symHtml}</td>` +
    `<td style="text-align:left">${trendPill}</td>` +
    `<td class="price-cell" style="text-align:right">${priceHtml}</td>` +
    `<td>${depthPillHtml}</td>` +
    `<td style="color:${adxColor};text-align:right">${fmt(adx, 1)}</td>` +
    `<td style="color:${jColor};text-align:right;font-weight:700">${jHtml}</td>` +
    `<td style="text-align:center">${gatesCell}</td>` +
    `<td style="text-align:center">${sigCell}</td>` +
    `</tr>`;
}

function renderPairTable() {
  if (!state) return;
  const tbody = document.getElementById('pair-tbody');
  const pairs = state.pair_states || [];

  if (pairs.length === 0) {
    tbody.innerHTML = '<tr class="pair-row-1"><td colspan="7" style="text-align:center;color:var(--muted);padding:30px;">No data yet — first scan in progress…</td></tr>';
    return;
  }

  let html = '';
  for (const p of pairs) html += buildPairRowHtml(p);
  tbody.innerHTML = html;

  tbody.querySelectorAll('tr[data-symbol]').forEach(row => {
    const sym = row.dataset.symbol;
    row.addEventListener('mouseenter', () => {
      tbody.querySelectorAll(`tr[data-symbol="${sym}"]`).forEach(r => r.classList.add('row-hover'));
    });
    row.addEventListener('mouseleave', () => {
      tbody.querySelectorAll(`tr[data-symbol="${sym}"]`).forEach(r => r.classList.remove('row-hover'));
    });
  });
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

function renderAll() {
  renderHeader();
  renderScanPulse();
  renderPairTable();
  renderSidePanel();
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
