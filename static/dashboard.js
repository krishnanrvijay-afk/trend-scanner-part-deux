/* Trend Scanner Part Deux — dashboard.js */

let state = null;
let lastScanCount = -1;
let prevAlertTradeCount = -1;
const cooldownEndsAt = {}; // symbol → Unix timestamp (seconds) when cooldown expires

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

async function openTrade(symbol, direction) {
  try {
    const res = await fetch('/api/trade/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || 'Failed to open trade');
      return;
    }
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

  const marginEl = document.getElementById('hc-margin');
  if (marginEl) {
    marginEl.textContent = `${fmt(acc.margin_deployed, 0)} / ${fmt(acc.cap, 0)} USDC`;
    marginEl.style.color = capColor;
  }

  const tradesEl = document.getElementById('hc-trades');
  if (tradesEl) tradesEl.textContent = `${acc.trades_opened ?? 0} opened`;

  const capPctEl = document.getElementById('hc-cap-pct');
  if (capPctEl) {
    capPctEl.textContent = `${fmt(pct, 1)}%`;
    capPctEl.style.color = capColor;
  }

  const capBar = document.getElementById('hc-cap-bar');
  if (capBar) {
    capBar.style.width = Math.min(pct, 100) + '%';
    capBar.className = 'hc-capbar-fill ' + (pct >= 90 ? 'cap-red' : pct >= 70 ? 'cap-yellow' : 'cap-green');
  }

  const lastScan = state.last_scan_at;
  const scanAgoEl = document.getElementById('hc-scan-ago');
  if (scanAgoEl && lastScan) scanAgoEl.textContent = relTime(lastScan);

  const deployEl = document.getElementById('hc-deploy-time');
  if (deployEl && state.deploy_time && !deployEl.dataset.set) {
    deployEl.textContent = 'DEPLOYED ' + state.deploy_time;
    deployEl.dataset.set = '1';
  }

  // Right card
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
      `<span style="color:#888">${neutCount} NEU</span>`;
  }

  const pairs = state.pair_states || [];
  const adxStrongCount = pairs.filter(p => (p.adx || 0) >= 50).length;
  const adxEl = document.getElementById('hc-adx-strong');
  if (adxEl) {
    adxEl.textContent = adxStrongCount + ' pairs';
    adxEl.style.color = adxStrongCount > 0 ? '#00ff88' : '#666666';
  }

  const cp = state.closest_pair;
  const closestEl = document.getElementById('hc-closest');
  if (closestEl) {
    if (cp && cp.gates_passing > 0) {
      const dirColor = cp.direction === 'LONG' ? '#00ff88' : '#ff4444';
      const hcFail   = cp.failing_gate ? `<span style="color:#ff4444;font-size:9px"> ${cp.failing_gate}✕</span>` : '';
      closestEl.innerHTML =
        `<span style="color:#fff">${cp.symbol}</span>&nbsp;` +
        `<span style="color:${dirColor}">${cp.direction}</span>&nbsp;` +
        `<span style="color:#ffaa00">${cp.gates_passing}/4</span>${hcFail}`;
    } else {
      closestEl.textContent = '—';
      closestEl.style.color = '#444';
    }
  }

  const sigEl = document.getElementById('hc-signals');
  if (sigEl) sigEl.textContent = (state.alerts || []).length;

  // Slots
  const slotsUsed  = acc.slots_used  ?? 0;
  const maxSlots   = acc.max_slots   ?? 2;
  const slotsEl    = document.getElementById('hc-slots');
  if (slotsEl) {
    const slotsColor = slotsUsed >= maxSlots ? '#ff4444' : slotsUsed > 0 ? '#ffaa00' : '#00ff88';
    slotsEl.textContent = `${slotsUsed}/${maxSlots}`;
    slotsEl.style.color = slotsColor;
  }

  // Daily P&L
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

  // Session
  const sessionLabel = state.session_label || 'CLOSED';
  const sessionEl    = document.getElementById('hc-session');
  if (sessionEl) {
    const sessionColor = sessionLabel === 'CLOSED' ? '#444444'
      : sessionLabel === 'EU+US'      ? '#00ff88'
      : '#ffaa00';
    sessionEl.textContent = sessionLabel;
    sessionEl.style.color = sessionColor;
  }

  // BTC regime (right card)
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

  // Daily limit banner
  const dlBadgeEl = document.getElementById('daily-limit-badge');
  if (dlBadgeEl) dlBadgeEl.style.display = dailyHalted ? 'inline-flex' : 'none';
  const rdBtnEl = document.getElementById('reset-day-btn');
  if (rdBtnEl) rdBtnEl.style.display = dailyHalted ? 'inline-flex' : 'none';

  // Circuit breaker
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
  const cp        = state.closest_pair;

  const numEl = document.getElementById('pulse-scan-num');
  if (numEl) numEl.textContent = `#${scanCount}`;

  const agoEl = document.getElementById('pulse-ago');
  if (agoEl && lastScan) {
    const secs = Math.max(0, Math.floor(Date.now() / 1000) - lastScan);
    agoEl.textContent = `${secs}s ago`;
  }

  const sigEl = document.getElementById('pulse-signals');
  if (sigEl) sigEl.textContent = signals;

  const cpEl = document.getElementById('pulse-closest');
  if (cpEl) {
    if (cp && cp.gates_passing > 0) {
      const dirColor = cp.direction === 'LONG' ? '#00ff88' : '#ff4444';
      const failStr  = cp.failing_gate ? ` — ${cp.failing_gate} failing` : '';
      cpEl.innerHTML =
        `<span style="color:#ffffff">closest:</span> ` +
        `<span style="color:#ffffff;font-weight:bold">${cp.symbol}</span> ` +
        `<span style="color:${dirColor};font-weight:bold">${cp.direction}</span> ` +
        `<span style="color:#ffaa00;font-weight:bold">(${cp.gates_passing}/4${failStr})</span>`;
    } else {
      cpEl.innerHTML = `<span style="color:#444444">All gates quiet</span>`;
    }
  }

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

// ── Trend dot strength builder ─────────────────────────────────────────────────

function buildTrendDots(trend, adx) {
  const isBull    = trend === 'Strong Bull';
  const isBear    = trend === 'Strong Bear';
  const isNeutral = !isBull && !isBear;

  const litColor   = isBull ? '#00ff88' : isBear ? '#ff4444' : '#222222';
  const litGlow    = isBull ? 'rgba(0,255,136,0.7)' : isBear ? 'rgba(255,68,68,0.7)' : 'none';
  const dimBg      = isBull ? 'rgba(0,255,136,0.12)' : isBear ? 'rgba(255,68,68,0.12)' : '#222222';
  const dimBorder  = isBull ? '1px solid rgba(0,255,136,0.2)' : isBear ? '1px solid rgba(255,68,68,0.2)' : '1px solid #333';
  const labelColor = isBull ? '#00ff88' : isBear ? '#ff4444' : '#444444';
  const label      = isBull ? 'BULL' : isBear ? 'BEAR' : 'NEU';

  let litCount = 0;
  if (!isNeutral) {
    if (adx >= 60) litCount = 3;
    else if (adx >= 40) litCount = 2;
    else if (adx >= 25) litCount = 1;
  }

  function dot(i) {
    const lit = i < litCount;
    if (lit) {
      return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${litColor};box-shadow:0 0 5px ${litGlow};flex-shrink:0"></span>`;
    }
    if (isNeutral) {
      return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#222;border:1px solid #333;flex-shrink:0"></span>`;
    }
    return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dimBg};border:${dimBorder};flex-shrink:0"></span>`;
  }

  return `<div style="display:flex;align-items:center;gap:3px">` +
    dot(0) + dot(1) + dot(2) +
    `<span style="color:${labelColor};font-weight:700;font-size:10px;margin-left:5px;letter-spacing:0.04em">${label}</span>` +
    `</div>`;
}

// ── Pair table render (two-row layout) ────────────────────────────────────────

function buildPairRowHtml(p) {
  const livePrice  = (state.prices && state.prices[p.symbol]) || p.price;
  const adx        = p.adx     ?? 0;
  const j5         = p.j5      ?? 50;
  const bid        = p.bid_pct ?? 0;
  const ask        = p.ask_pct ?? 0;
  const bidWall    = p.bid_wall ?? null;
  const askWall    = p.ask_wall ?? null;
  const change24h  = p.change_24h ?? null;

  // Symbol cell
  const symHtml = `<span class="sym">${p.symbol}</span>`;

  // Trend dots
  const trendDots = buildTrendDots(p.trend || 'Neutral', adx);

  // 24h change
  let changeHtml = `<span style="color:#444">—</span>`;
  if (change24h !== null && !isNaN(change24h)) {
    const chColor = change24h >= 0 ? '#00ff88' : '#ff4444';
    const chSign  = change24h >= 0 ? '+' : '';
    changeHtml = `<span style="color:${chColor};font-weight:700">${chSign}${fmt(Math.abs(change24h), 1)}%</span>`;
  }

  const adxColor = adx >= 30 ? '#00ff88' : '#666666';
  const j5Color  = j5  <= 20 ? '#00ff88' : j5 >= 80 ? '#ff4444' : '#ffffff';

  const cdSecs = cooldownEndsAt[p.symbol]
    ? Math.max(0, Math.ceil(cooldownEndsAt[p.symbol] - Date.now() / 1000))
    : (p.cooldown_remaining_seconds || 0);

  // Signal cell
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

  // Gate dots
  const gs = p.gates_status || {};
  const passCount = [gs.trend_pass, gs.adx_pass, gs.depth_pass, gs.ma_pass].filter(Boolean).length;
  const nearMiss  = passCount === 3;
  function gColor(pass) {
    return pass ? '#00ff88' : (nearMiss ? '#ffaa00' : '#444444');
  }
  const chk = v => v ? '✓' : '✗';
  const tip = [
    `TREND ${chk(gs.trend_pass)}`,
    `ADX ${chk(gs.adx_pass)}`,
    `DEPTH ${chk(gs.depth_pass)}`,
    `MA STACK ${chk(gs.ma_pass)}`,
  ].join(' · ');
  const gatesCell = `<div class="gate-dots" title="${tip}">` +
    `<span class="gate-dot" style="background:${gColor(gs.trend_pass)}"></span>` +
    `<span class="gate-dot" style="background:${gColor(gs.adx_pass)}"></span>` +
    `<span class="gate-dot" style="background:${gColor(gs.depth_pass)}"></span>` +
    `<span class="gate-dot" style="background:${gColor(gs.ma_pass)}"></span>` +
    `</div>`;

  // Wall display
  const bidWallStr = bidWall !== null ? fmtPrice(bidWall) : '—';
  const askWallStr = askWall !== null ? fmtPrice(askWall) : '—';

  // ROW 1 — active data
  const row1 = `<tr data-symbol="${p.symbol}" class="pair-row-1">` +
    `<td style="text-align:left">${symHtml}</td>` +
    `<td style="text-align:left">${trendDots}</td>` +
    `<td class="price-cell">${fmtPrice(livePrice)}</td>` +
    `<td>${changeHtml}</td>` +
    `<td style="color:${adxColor}">${fmt(adx, 1)}</td>` +
    `<td style="color:${j5Color}">${j5 > 100 ? '100+' : j5 < 0 ? '0-' : fmt(j5, 1)}</td>` +
    `<td style="text-align:center">${gatesCell}</td>` +
    `<td style="text-align:center">${sigCell}</td>` +
    `</tr>`;

  // ROW 2 — depth strip
  const row2 = `<tr data-symbol="${p.symbol}" class="pair-row-2">` +
    `<td colspan="8" style="padding:0">` +
    `<div class="depth-strip">` +
    `<div class="depth-buyers">` +
    `<span class="ds-label ds-label-buy">BUYERS</span>` +
    `<span class="ds-pct ds-pct-buy">${fmt(bid, 1)}%</span>` +
    `<span class="ds-wall-lbl">WALL</span>` +
    `<span class="ds-wall-val">${bidWallStr}</span>` +
    `</div>` +
    `<div class="ds-divider"></div>` +
    `<div class="depth-sellers">` +
    `<span class="ds-label ds-label-sell">SELLERS</span>` +
    `<span class="ds-pct ds-pct-sell">${fmt(ask, 1)}%</span>` +
    `<span class="ds-wall-lbl">WALL</span>` +
    `<span class="ds-wall-val">${askWallStr}</span>` +
    `</div>` +
    `</div>` +
    `</td>` +
    `</tr>`;

  return row1 + row2;
}

function renderPairTable() {
  if (!state) return;
  const tbody = document.getElementById('pair-tbody');
  const pairs = state.pair_states || [];

  if (pairs.length === 0) {
    tbody.innerHTML = '<tr class="pair-row-1"><td colspan="8" style="text-align:center;color:var(--muted);padding:30px;">No data yet — first scan in progress…</td></tr>';
    return;
  }

  let html = '';
  for (const p of pairs) html += buildPairRowHtml(p);
  tbody.innerHTML = html;

  // Sync hover highlight across both rows of each pair
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

  // TREND BIAS
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
      html += `<div class="sp-chips">${chips(neuts, '#444444')}</div>`;
    }
    trendEl.innerHTML = html || '<span style="color:#333;font-size:9px">—</span>';
  }

  // ADX STRENGTH — ●●● ≥60, ●● 30-59, ○ <30
  const adxEl = document.getElementById('sp-adx-strength');
  if (adxEl) {
    let html = '';
    if ((ab.strong   || []).length > 0) {
      html += `<div class="sp-adx-row"><span class="sp-adx-dots" style="color:#00ff88">●●●</span><div class="sp-chips">${chips(ab.strong, '#00ff88')}</div></div>`;
    }
    if ((ab.moderate || []).length > 0) {
      html += `<div class="sp-adx-row"><span class="sp-adx-dots" style="color:#ffaa00">●●</span><div class="sp-chips">${chips(ab.moderate, '#ffaa00')}</div></div>`;
    }
    if ((ab.weak     || []).length > 0) {
      html += `<div class="sp-adx-row"><span class="sp-adx-dots" style="color:#444">○</span><div class="sp-chips">${chips(ab.weak, '#444444')}</div></div>`;
    }
    adxEl.innerHTML = html || '<span style="color:#333;font-size:9px">—</span>';
  }

  // MOMENTUM J
  const momEl = document.getElementById('sp-momentum');
  if (momEl) {
    let html = '';
    if ((mb.overbought || []).length > 0) {
      html += `<div style="font-size:9px;color:#ff4444;font-weight:700;margin-bottom:2px">OB J&gt;80</div>`;
      html += `<div class="sp-chips" style="margin-bottom:4px">${chips(mb.overbought, '#ff4444')}</div>`;
    }
    if ((mb.oversold  || []).length > 0) {
      html += `<div style="font-size:9px;color:#00ff88;font-weight:700;margin-bottom:2px">OS J&lt;20</div>`;
      html += `<div class="sp-chips">${chips(mb.oversold, '#00ff88')}</div>`;
    }
    momEl.innerHTML = html || '<span style="color:#333;font-size:9px">—</span>';
  }

  // BTC REGIME
  const btcEl = document.getElementById('sp-btc-regime');
  if (btcEl) {
    const regime = state.btc_regime || 'Neutral';
    const regimeBg     = regime === 'Strong Bull' ? 'rgba(0,255,136,0.1)'  : regime === 'Strong Bear' ? 'rgba(255,68,68,0.1)'  : 'rgba(255,170,0,0.1)';
    const regimeBorder = regime === 'Strong Bull' ? 'rgba(0,255,136,0.3)'  : regime === 'Strong Bear' ? 'rgba(255,68,68,0.3)'  : 'rgba(255,170,0,0.3)';
    const regimeColor  = regime === 'Strong Bull' ? '#00ff88'               : regime === 'Strong Bear' ? '#ff4444'               : '#ffaa00';
    const regimeLabel  = regime === 'Strong Bull' ? 'BULL'                  : regime === 'Strong Bear' ? 'BEAR'                  : 'NEUTRAL';
    btcEl.innerHTML = `<div class="sp-regime-badge" style="background:${regimeBg};border:1px solid ${regimeBorder}">` +
      `<div class="sp-regime-text" style="color:${regimeColor}">${regimeLabel}</div>` +
      `<div class="sp-regime-sub">${regime}</div>` +
      `</div>`;
  }

  // SESSION
  const sessEl = document.getElementById('sp-session');
  if (sessEl) {
    const session   = state.session_label || 'CLOSED';
    const sessColor = session === 'CLOSED' ? '#ff4444' : '#00ff88';
    const sessBg    = session === 'CLOSED' ? 'rgba(255,68,68,0.1)' : 'rgba(0,255,136,0.1)';
    const sessBdr   = session === 'CLOSED' ? 'rgba(255,68,68,0.3)' : 'rgba(0,255,136,0.3)';
    sessEl.innerHTML = `<div class="sp-session-badge" style="background:${sessBg};border:1px solid ${sessBdr}">` +
      `<div class="sp-session-text" style="color:${sessColor}">${session}</div>` +
      `</div>`;
  }
}

// ── Alert card builder ────────────────────────────────────────────────────────

function buildConfirmedAlertCard(alert, trade, capReached, entryBanner = '') {
  const key    = `${alert.symbol}${alert.direction}`;
  const inTrade = !!trade;
  const isLong  = alert.direction === 'LONG';

  const dirBadge = isLong
    ? `<span class="ac-dir-long">LONG</span>`
    : `<span class="ac-dir-short">SHORT</span>`;

  const adxColor   = (alert.adx || 0) >= 30 ? '#00ff88' : '#666666';
  const trendColor = isLong ? '#00ff88' : '#ff4444';
  const trendLabel = isLong ? '▲ S.Bull' : '▼ S.Bear';

  const dr       = alert.dollar_risk || 0;
  const slDollar  = dr > 0 ? `-$${fmt(dr, 2)}`       : '—';
  const tp1Dollar = dr > 0 ? `+$${fmt(dr * 1.5, 2)}` : '—';
  const tp2Dollar = dr > 0 ? `+$${fmt(dr * 2.0, 2)}` : '—';

  const tp1Hit   = !!(trade && trade.tp1_hit);
  const trailSL  = trade && trade.trailing_sl;
  const slDisplay = tp1Hit
    ? (trailSL
        ? `<span style="color:#555;text-decoration:line-through;margin-right:4px">${fmtPrice(alert.sl_price)}</span><span style="color:#f97316;font-weight:700">TRAIL ${fmtPrice(trailSL)}</span>`
        : `<span style="color:#555;text-decoration:line-through;margin-right:6px">${fmtPrice(alert.sl_price)}</span><span style="color:#00ff88;font-weight:700">BREAKEVEN</span>`)
    : `<span style="color:#ff4444;font-weight:700">${fmtPrice(alert.sl_price)}</span>`;

  const currentPrice = (state.prices && state.prices[alert.symbol])
    || (trade && trade.current_price)
    || alert.entry_price;
  const slP  = alert.sl_price;
  const tp2P = alert.tp2_price;
  let progressPct = 50;
  if (slP && tp2P && currentPrice) {
    progressPct = isLong
      ? (currentPrice - slP) / (tp2P - slP) * 100
      : (slP - currentPrice) / (slP - tp2P) * 100;
    progressPct = Math.max(0, Math.min(100, progressPct));
  }
  const t  = progressPct / 100;
  const pr = Math.round(0xff + (0x00 - 0xff) * t);
  const pg = Math.round(0x44 + (0xff - 0x44) * t);
  const pb = Math.round(0x44 + (0x88 - 0x44) * t);
  const fillColor = `rgb(${pr},${pg},${pb})`;

  let html = `<div class="ac">`;

  // Header
  html += `
    <div>
      <div class="ac-header-top">
        <div class="ac-sig">
          <span class="ac-sym">${alert.symbol}</span>
          ${dirBadge}
        </div>
        <div class="ac-right">
          <span style="color:${adxColor};font-weight:700">ADX ${fmt(alert.adx, 1)}</span>
          <span style="color:${trendColor};font-weight:700">${trendLabel}</span>
        </div>
      </div>
      <div class="ac-ts">${relTime(alert.fired_at)}</div>
    </div>`;

  if (entryBanner) html += entryBanner;

  // IN TRADE status
  if (inTrade) {
    const badgeBorder = isLong ? '#00ff88' : '#ff4444';
    const badgeBg     = isLong ? 'rgba(0,255,136,0.07)' : 'rgba(255,68,68,0.07)';
    const pnl      = trade.unrealized_pnl ?? 0;
    const pnlColor = pnl >= 0 ? '#00ff88' : '#ff4444';
    const pnlSign  = pnl >= 0 ? '+' : '';
    const r        = trade.r ?? 0;
    const rColor   = r >= 0 ? '#00ff88' : '#ff4444';
    const rSign    = r >= 0 ? '+' : '';

    html += `
      <div>
        <div class="ac-intrade-badge" style="background:${badgeBg};border-color:${badgeBorder};color:${badgeBorder}">
          <span>● IN TRADE</span>
          <span style="font-weight:400;color:#cccccc">${elapsed(trade.opened_at)}</span>
        </div>
        <div class="ac-pnl-row">
          <div class="ac-lv">
            <span class="ac-lv-label">Entry</span>
            <span class="ac-lv-val" style="color:#ffffff">${fmtPrice(trade.entry_price)}</span>
          </div>
          <div class="ac-lv">
            <span class="ac-lv-label">Current</span>
            <span class="ac-lv-val" style="color:#ffffff">${fmtPrice(currentPrice)}</span>
          </div>
          <div class="ac-lv">
            <span class="ac-lv-label">PnL / R</span>
            <span class="ac-lv-val">
              <span style="color:${pnlColor}">${pnlSign}$${fmt(pnl, 2)}</span>
              <span style="font-size:10px;color:${rColor}"> ${rSign}${fmt(r, 2)}R</span>
            </span>
          </div>
        </div>
      </div>`;
  }

  // Position details
  html += `
    <div>
      <div class="ac-section-label">Position</div>
      <div class="ac-detail-grid">
        <div class="ac-detail-row"><span class="ac-detail-label">MARGIN</span><span class="ac-detail-val" style="color:#ffffff">$${fmt(alert.margin, 0)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">ADX</span><span class="ac-detail-val" style="color:${adxColor}">${fmt(alert.adx, 1)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">LEVERAGE</span><span class="ac-detail-val" style="color:#ffffff">${alert.leverage ?? 6}x</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">DOLLAR RISK</span><span class="ac-detail-val" style="color:#ffaa00">$${fmt(alert.dollar_risk, 2)}</span></div>
      </div>
      <div style="display:flex;gap:16px;margin-top:6px;font-size:10px;color:#555555">
        <span>RSI 1H <span style="color:#888888">${fmt(alert.rsi_1h ?? 50, 1)}</span></span>
        <span>J 1H <span style="color:#888888">${fmt(alert.j1h ?? 50, 1)}</span></span>
        <span>VOL <span style="color:#888888">${fmt(alert.volume_ratio ?? 0, 2)}x</span></span>
      </div>
    </div>`;

  // Levels
  const tp1Check = tp1Hit ? ` <span style="color:#00ff88">✓</span>` : '';
  html += `
    <div>
      <div class="ac-section-label">Levels</div>
      <div class="ac-levels">
        <div class="ac-level-row">
          <span class="ac-lvl-tag" style="color:#ff4444">SL</span>
          <span class="ac-lvl-price">${slDisplay}</span>
          <span class="ac-lvl-pct">(${fmt(alert.sl_pct, 2)}%)</span>
          <span class="ac-lvl-dollar" style="color:#ffaa00">${slDollar}</span>
        </div>
        <div class="ac-level-row" ${tp1Hit ? 'style="opacity:0.55"' : ''}>
          <span class="ac-lvl-tag" style="color:#ffaa00">TP1 1.5R${tp1Check}</span>
          <span class="ac-lvl-price" style="color:#ffaa00">${fmtPrice(alert.tp1_price)}</span>
          <span class="ac-lvl-pct"></span>
          <span class="ac-lvl-dollar" style="color:#00ff88">${tp1Dollar}</span>
        </div>
        <div class="ac-level-row">
          <span class="ac-lvl-tag" style="color:#00ff88">TP2 2.0R</span>
          <span class="ac-lvl-price" style="color:#00ff88">${fmtPrice(alert.tp2_price)}</span>
          <span class="ac-lvl-pct"></span>
          <span class="ac-lvl-dollar" style="color:#00ff88">${tp2Dollar}</span>
        </div>
      </div>
    </div>`;

  // Progress bar
  html += `
    <div>
      <div class="ac-progress-wrap">
        <div class="ac-progress-fill" style="width:${progressPct.toFixed(1)}%;background:${fillColor}"></div>
        <div class="ac-progress-marker" style="left:${progressPct.toFixed(1)}%"></div>
      </div>
      <div class="ac-progress-labels">
        <span style="color:#ff4444">SL ${fmtPrice(slP)}</span>
        <span style="color:#00ff88">TP2 ${fmtPrice(tp2P)}</span>
      </div>
    </div>`;

  // Footer
  html += `<div class="ac-footer"><span class="ac-elapsed">Fired ${relTime(alert.fired_at)}</span>`;
  if (!inTrade) {
    const autoInfo = (state.auto_pending || {})[key];
    const slotsFull = (state.account || {}).slots_full || false;
    if (autoInfo) {
      const remaining = Math.max(0, Math.ceil(autoInfo.fire_at - Date.now() / 1000));
      const label = remaining > 0 ? `AUTO IN ${remaining}s` : 'OPENING…';
      html += `<button class="pill pill-open" style="background:#ffaa00;color:#000;cursor:default;min-width:100px" data-auto-key="${key}">${label}</button>`;
    } else if (slotsFull) {
      html += `<button class="pill" style="background:rgba(100,100,100,0.15);border:1px solid #444;color:#666;cursor:not-allowed;min-width:100px" disabled title="Max simultaneous trades reached">⛔ SLOTS FULL</button>`;
    } else {
      const disabled = capReached ? 'disabled title="Margin cap reached"' : '';
      html += `<button class="pill pill-open" ${disabled} onclick="openTrade('${alert.symbol}', '${alert.direction}')">▶ OPEN TRADE</button>`;
    }
  } else {
    html += `<button class="pill pill-close" onclick="closeTrade('${alert.symbol}', '${alert.direction}')">■ CLOSE TRADE</button>`;
  }
  html += `</div></div>`;
  return html;
}

// ── Awaiting entry card builder ───────────────────────────────────────────────

function buildAwaitingEntryCard(ae) {
  const isLong   = ae.direction === 'LONG';
  const dirBadge = isLong
    ? `<span class="ac-dir-long">LONG</span>`
    : `<span class="ac-dir-short">SHORT</span>`;
  const threshold = ae.entry_rsi_threshold ?? (isLong ? 45 : 55);
  const rsi5m     = ae.rsi_5m_current;
  const remaining = ae.time_remaining_s ?? 0;
  const remM  = Math.floor(remaining / 60);
  const remS  = remaining % 60;
  const rsiDisplay = rsi5m != null ? `5m RSI: <b>${fmt(rsi5m, 1)}</b>` : '5m RSI: polling…';
  const waitingFor = isLong
    ? `Waiting for 5m RSI to cross below ${threshold}`
    : `Waiting for 5m RSI to cross above ${threshold}`;

  return `
    <div class="ac" style="border-left:3px solid #f97316">
      <div>
        <div class="ac-header-top">
          <div class="ac-sig">
            <span class="ac-sym">${ae.symbol}</span>
            ${dirBadge}
            <span class="ac-score" style="background:rgba(249,115,22,0.15);color:#f97316;border:1px solid rgba(249,115,22,0.3)">${ae.score ?? 0}/4</span>
          </div>
          <div class="ac-right">
            <span style="color:${(ae.adx || 0) >= 25 ? '#00ff88' : '#666'};font-weight:700">ADX ${fmt(ae.adx, 1)}</span>
            <span style="color:${isLong ? '#00ff88' : '#ff4444'};font-weight:700">${isLong ? '▲ S.Bull' : '▼ S.Bear'}</span>
          </div>
        </div>
        <div class="ac-ts">Signal confirmed ${relTime(ae.confirmed_at)}</div>
      </div>
      <div style="padding:10px 12px;background:#1a0e00;border:1px solid rgba(249,115,22,0.3);border-radius:6px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="
            display:inline-flex;align-items:center;gap:6px;
            padding:3px 10px;border-radius:4px;
            background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.4);
            color:#f97316;font-size:10px;font-weight:700;letter-spacing:.06em;
            animation:pending-pulse 1.4s infinite
          ">◈ AWAITING PULLBACK ENTRY</span>
          <span style="font-size:10px;color:#666">⏱ ${remM}m ${remS < 10 ? '0' : ''}${remS}s left</span>
        </div>
        <div style="font-size:11px;color:#aaa;margin-bottom:4px">${waitingFor}</div>
        <div style="font-size:12px;color:#f97316;font-weight:700">${rsiDisplay}</div>
        <div style="font-size:10px;color:#666;margin-top:4px">Timeout → market entry if no pullback</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px">
        <div class="ac-detail-row"><span class="ac-detail-label">ENTRY ~</span><span class="ac-detail-val" style="color:#fff">${fmtPrice(ae.entry_price)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">SL</span><span class="ac-detail-val" style="color:#ff4444">${fmtPrice(ae.sl_price)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">TP1</span><span class="ac-detail-val" style="color:#ffaa00">${fmtPrice(ae.tp1_price)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">TP2</span><span class="ac-detail-val" style="color:#00ff88">${fmtPrice(ae.tp2_price)}</span></div>
      </div>
    </div>`;
}

// ── Alerts render ─────────────────────────────────────────────────────────────

function renderAlerts() {
  if (!state) return;
  const container = document.getElementById('alerts-container');
  const allAlerts  = (state.alerts || []).slice().reverse();
  const pendings   = (state.pending_alerts || []).slice().reverse();

  const confirmedKeys   = new Set(allAlerts.map(a => `${a.symbol}${a.direction}`));
  const visiblePendings = pendings.filter(p => !confirmedKeys.has(`${p.symbol}${p.direction}`));

  if (allAlerts.length === 0 && visiblePendings.length === 0) {
    container.innerHTML = `
      <div class="alerts-empty">
        Scanning every 20s.<br>Alerts appear here when<br>all 4 conditions pass twice.
      </div>`;
    return;
  }

  const acc = state.account || {};
  const capReached = acc.cap_reached;
  const openTrades = state.open_trades || {};

  let html = '<div class="alerts-list">';

  // Pending cards
  for (const p of visiblePendings) {
    const isLong = p.direction === 'LONG';
    html += `
      <div class="alert-card" style="border-left:3px solid #ffaa00;opacity:0.85">
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
          <div class="alert-score">ADX <span style="color:${p.adx >= 30 ? '#00ff88' : '#666666'}">${fmt(p.adx, 1)}</span></div>
        </div>
        <div class="alert-grid">
          <div class="ag-row">
            <span class="ag-label">Trend</span>
            <span class="ag-val ${isLong ? 'trend-bull' : 'trend-bear'}">${p.trend}</span>
          </div>
          <div class="ag-row">
            <span class="ag-label">RSI 1H</span>
            <span class="ag-val"><span style="color:${rsiColor(p.rsi_1h)};font-weight:bold">${fmt(p.rsi_1h ?? 50, 1)}</span></span>
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

  // Confirmed alert cards
  for (const alert of allAlerts) {
    const key   = `${alert.symbol}${alert.direction}`;
    const trade = openTrades[key];
    html += buildConfirmedAlertCard(alert, trade, capReached);
  }

  html += '</div>';
  container.innerHTML = html;
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

  // IN PROGRESS section
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

  // Closed trades log
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
    document.getElementById('cc-yes').onclick   = () => { modal.remove(); resolve(true); };
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
      btn.style.background = 'rgba(0,255,136,0.15)';
      btn.style.borderColor = 'rgba(0,255,136,0.4)';
      btn.style.color = '#00ff88';
      setTimeout(() => {
        btn.textContent = '✕ CLEAR LOG';
        btn.style.background = '';
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

// Initial load
poll();

// Price refresh every 1 second
setInterval(poll, 1000);
