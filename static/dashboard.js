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
  const openTradeKeys = new Set(Object.keys(openTrades)); // e.g. "BTCLONG"
  const alerts        = state.alerts || [];

  // Count open positions once, plus confirmed alerts that don't have a matching
  // open trade yet (unacted). Never count pending-reconfirmation cards.
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

  // Flash the tab label when count increases (new alert or new trade)
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
    // Immediately retire the card from local state — don't wait for the next poll
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
    // Resync local cooldown end-times from server so the countdown stays accurate
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

  // ── Left card ────────────────────────────────────────────────
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

  // ── Right card: Market Snapshot summary ──────────────────────
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
      closestEl.innerHTML =
        `<span style="color:#fff">${cp.symbol}</span>&nbsp;` +
        `<span style="color:${dirColor}">${cp.direction}</span>&nbsp;` +
        `<span style="color:#ffaa00">${cp.gates_passing}/4</span>`;
    } else {
      closestEl.textContent = '—';
      closestEl.style.color = '#444';
    }
  }

  const sigEl = document.getElementById('hc-signals');
  if (sigEl) sigEl.textContent = (state.alerts || []).length;
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
      cpEl.innerHTML =
        `<span style="color:#ffffff">closest:</span> ` +
        `<span style="color:#ffffff;font-weight:bold">${cp.symbol}</span> ` +
        `<span style="color:${dirColor};font-weight:bold">${cp.direction}</span> ` +
        `<span style="color:#ffaa00;font-weight:bold">(${cp.gates_passing}/4 gates)</span>`;
    } else {
      cpEl.innerHTML = `<span style="color:#444444">All gates quiet</span>`;
    }
  }

  // Flash pulse dot when scan_count increments
  if (lastScanCount !== -1 && scanCount !== lastScanCount) {
    const dot = document.getElementById('pulse-dot');
    if (dot) {
      dot.classList.remove('flash');
      void dot.offsetWidth; // force reflow to restart CSS animation
      dot.classList.add('flash');
    }
  }
  lastScanCount = scanCount;
}

// ── Pair table render ─────────────────────────────────────────────────────────
// Rows are updated in-place by data-symbol to preserve insertion order.
// Server returns pairs pre-sorted to match config.py PAIRS order.

function buildPairRowHtml(p, promotedEntry) {
  const trendClass = p.trend === 'Strong Bull' ? 'trend-bull'
    : p.trend === 'Strong Bear' ? 'trend-bear' : 'trend-neu';
  const trendLabel = p.trend === 'Strong Bull' ? '▲ S.Bull'
    : p.trend === 'Strong Bear' ? '▼ S.Bear' : '— Neutral';

  const livePrice = (state.prices && state.prices[p.symbol]) || p.price;
  const adx = p.adx  ?? 0;
  const j5  = p.j5   ?? 50;
  const bid = p.bid_pct ?? 0;
  const ask = p.ask_pct ?? 0;

  const adxColor = adx >= 30 ? '#00ff88' : '#666666';
  const j5Color  = j5  <= 20 ? '#00ff88' : j5 >= 80 ? '#ff4444' : '#ffffff';
  const bidColor = bid >= 60 ? '#00ff88' : '#ffffff';
  const askColor = ask >= 60 ? '#ff4444' : '#ffffff';

  const symHtml = promotedEntry
    ? `<span class="slot-badge">S${promotedEntry.slot_number}</span><span class="sym">${p.symbol}</span>`
    : `<span class="sym">${p.symbol}</span>`;

  const cdSecs = cooldownEndsAt[p.symbol]
    ? Math.max(0, Math.ceil(cooldownEndsAt[p.symbol] - Date.now() / 1000))
    : 0;

  // IN TRADE overrides everything else in the signal column
  const openTradesMap = state.open_trades || {};
  const hasLongTrade  = !!openTradesMap[`${p.symbol}LONG`];
  const hasShortTrade = !!openTradesMap[`${p.symbol}SHORT`];

  let sigCell;
  if (hasLongTrade || hasShortTrade) {
    const tradeColor = hasLongTrade ? '#00ff88' : '#ff4444';
    sigCell = `<span style="color:${tradeColor};font-size:10px;font-weight:700;letter-spacing:.06em">▶ IN TRADE</span>`;
  } else if (cdSecs > 0) {
    const cdM = Math.floor(cdSecs / 60);
    const cdS = cdSecs % 60;
    sigCell = `<span style="color:#666666;font-size:11px;white-space:nowrap" title="Cooldown active">🕐 ${cdM}m ${cdS < 10 ? '0' : ''}${cdS}s</span>`;
  } else {
    const sig = p.signal_state || 'none';
    if (sig === 'confirmed') {
      sigCell = '<span style="color:#00ff88;font-size:15px" title="Confirmed">🔔</span>';
    } else if (sig === 'pending') {
      sigCell = '<span style="color:#ffaa00;font-size:15px" title="Pending">⏳</span>';
    } else if (promotedEntry) {
      const secsLeft = Math.max(0, (promotedEntry.rotation_expires_at || 0) - Math.floor(Date.now() / 1000));
      const h = Math.floor(secsLeft / 3600);
      const m = Math.floor((secsLeft % 3600) / 60);
      sigCell = `<span style="color:#555;font-size:10px" title="Rotation expires">↻ ${h}h ${m}m</span>`;
    } else {
      sigCell = '';
    }
  }

  const gs = p.gates_status || {};
  const gatesList = [
    { name: 'TREND', pass: gs.trend_pass },
    { name: 'ADX',   pass: gs.adx_pass },
    { name: 'DEPTH', pass: gs.depth_pass },
    { name: 'J',     pass: gs.j_pass },
  ];
  const passingCount = gatesList.filter(g => g.pass).length;
  const dotsHtml = gatesList.map(g => {
    const color = g.pass ? '#00ff88' : (passingCount === 3 ? '#ffaa00' : '#444444');
    return `<span class="gate-dot" style="background:${color}"></span>`;
  }).join('');
  const gatesCell = `<div class="gate-dots" title="TREND · ADX · DEPTH · J">${dotsHtml}</div>`;

  return `<tr data-symbol="${p.symbol}">
    <td>${symHtml}</td>
    <td class="${trendClass}">${trendLabel}</td>
    <td class="price-cell">${fmtPrice(livePrice)}</td>
    <td style="color:${adxColor};text-align:right">${fmt(adx, 1)}</td>
    <td style="color:${j5Color};text-align:right">${j5 > 100 ? '100+' : j5 < 0 ? '0-' : fmt(j5, 1)}</td>
    <td style="color:${bidColor};text-align:right">${fmt(bid, 1)}%</td>
    <td style="color:${askColor};text-align:right">${fmt(ask, 1)}%</td>
    <td style="text-align:center">${gatesCell}</td>
    <td style="text-align:center">${sigCell}</td>
  </tr>`;
}

function renderPairTable() {
  if (!state) return;
  const tbody = document.getElementById('pair-tbody');
  const pairs = state.pair_states || [];
  const promotedMap = {};
  for (const pp of (state.promoted_pairs || [])) {
    promotedMap[pp.symbol] = pp;
  }

  if (pairs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:30px;">No data yet — first scan in progress…</td></tr>';
    return;
  }

  const fixedPairs = pairs.filter(p => !promotedMap[p.symbol]);
  const promPairs  = pairs.filter(p =>  promotedMap[p.symbol]);

  let html = '';
  for (const p of fixedPairs) html += buildPairRowHtml(p, null);

  html += `<tr class="promoted-divider"><td colspan="9">— PROMOTED —</td></tr>`;

  if (promPairs.length === 0) {
    html += `<tr><td colspan="9" style="text-align:center;color:#555;font-style:italic;padding:10px 12px;font-size:11px">No promoted pairs — market quiet</td></tr>`;
  } else {
    for (const p of promPairs) html += buildPairRowHtml(p, promotedMap[p.symbol]);
  }

  tbody.innerHTML = html;
}

// ── Market snapshot render ────────────────────────────────────────────────────

function toggleSnapshot() {
  const body    = document.getElementById('snapshot-body');
  const chevron = document.getElementById('snapshot-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.textContent = isOpen ? '▶' : '▼';
}

function renderMarketSnapshot() {
  const content = document.getElementById('snapshot-content');
  if (!content || !state) return;
  const ms = state.market_snapshot;
  if (!ms) return;

  const tb = ms.trend_bias     || {};
  const ab = ms.adx_bands      || {};
  const mb = ms.momentum_bands || {};
  const db = ms.depth_bias     || {};

  function chips(arr, color) {
    if (!arr || arr.length === 0)
      return `<span style="color:#444444;font-size:10px">—</span>`;
    return arr.map(s =>
      `<span style="color:${color};font-weight:bold;font-size:10px">${s}</span>`
    ).join(' ');
  }

  content.innerHTML = `
    <div class="snapshot-section">
      <div class="snap-label">Trend Bias</div>
      <div class="snap-row"><span class="snap-key">Bull</span>${chips(tb.strong_bull, '#00ff88')}</div>
      <div class="snap-row"><span class="snap-key">Bear</span>${chips(tb.strong_bear, '#ff4444')}</div>
      <div class="snap-row"><span class="snap-key">Neutral</span>${chips(tb.neutral, '#ffaa00')}</div>
    </div>
    <div class="snapshot-section">
      <div class="snap-label">ADX Strength</div>
      <div class="snap-row"><span class="snap-key">≥60</span>${chips(ab.strong, '#00ff88')}</div>
      <div class="snap-row"><span class="snap-key">30–59</span>${chips(ab.moderate, '#ffaa00')}</div>
      <div class="snap-row"><span class="snap-key">&lt;30</span>${chips(ab.weak, '#666666')}</div>
    </div>
    <div class="snapshot-section">
      <div class="snap-label">Momentum J</div>
      <div class="snap-row"><span class="snap-key">OB ≥80</span>${chips(mb.overbought, '#ff4444')}</div>
      <div class="snap-row"><span class="snap-key">Neutral</span>${chips(mb.neutral_j, '#ffffff')}</div>
      <div class="snap-row"><span class="snap-key">OS ≤20</span>${chips(mb.oversold, '#00ff88')}</div>
    </div>
    <div class="snapshot-section">
      <div class="snap-label">Depth Bias</div>
      <div class="snap-row"><span class="snap-key">Ask ≥55%</span>${chips(db.ask_dominant, '#ff4444')}</div>
      <div class="snap-row"><span class="snap-key">Bid ≥55%</span>${chips(db.bid_dominant, '#00ff88')}</div>
      <div class="snap-row"><span class="snap-key">Balanced</span>${chips(db.balanced, '#ffffff')}</div>
    </div>`;

  // Universe section — spans full grid width
  const us       = state.universe_state || {};
  const promoted = state.promoted_pairs  || [];
  const promChips = promoted.length > 0
    ? promoted.map(pp =>
        `<span style="color:#ffaa00;font-weight:bold;font-size:10px">S${pp.slot_number}:${pp.symbol}</span>`
        + `&nbsp;<span style="color:#666;font-size:9px">(${pp.universe_score}/7)</span>`
      ).join('&nbsp;&nbsp;')
    : '<span style="color:#444;font-size:10px">—</span>';

  content.innerHTML += `
    <div class="snapshot-section" style="grid-column:1/-1;border-top:1px solid var(--border);padding-top:10px;margin-top:4px">
      <div class="snap-label">Universe Scanner</div>
      <div class="snap-row"><span class="snap-key">Last scan</span><span style="color:#ffffff;font-size:10px">${us.last_scan_at ? relTime(us.last_scan_at) : '—'}</span></div>
      <div class="snap-row"><span class="snap-key">Coverage</span><span style="color:#ffffff;font-size:10px">${us.total_pairs_scanned ?? '—'} pairs scanned · ${us.pairs_surviving_filter ?? '—'} survive filter</span></div>
      <div class="snap-row" style="flex-wrap:wrap;gap:6px"><span class="snap-key">Promoted</span>${promChips}</div>
    </div>`;
}

// ── Alert card builder ────────────────────────────────────────────────────────

function buildConfirmedAlertCard(alert, trade, capReached) {
  const key    = `${alert.symbol}${alert.direction}`;
  const inTrade = !!trade;
  const isLong  = alert.direction === 'LONG';

  const dirBadge = isLong
    ? `<span class="ac-dir-long">LONG</span>`
    : `<span class="ac-dir-short">SHORT</span>`;

  const score    = alert.score ?? 0;
  const scoreMax = 7;
  const scoreColor = score >= scoreMax ? '#00ff88' : '#ffaa00';
  const scoreChip  = `<span class="ac-score" style="background:${scoreColor}22;color:${scoreColor};border:1px solid ${scoreColor}44">${score}/${scoreMax}</span>`;

  const adxColor   = (alert.adx || 0) >= 30 ? '#00ff88' : '#666666';
  const trendColor = isLong ? '#00ff88' : '#ff4444';
  const trendLabel = isLong ? '▲ S.Bull' : '▼ S.Bear';

  const dr       = alert.dollar_risk || 0;
  const slDollar = dr > 0 ? `-$${fmt(dr, 2)}`       : '—';
  const tp1Dollar = dr > 0 ? `+$${fmt(dr * 1.5, 2)}` : '—';
  const tp2Dollar = dr > 0 ? `+$${fmt(dr * 2.0, 2)}` : '—';

  const tp1Hit   = !!(trade && trade.tp1_hit);
  const slDisplay = tp1Hit
    ? `<span style="color:#555;text-decoration:line-through;margin-right:6px">${fmtPrice(alert.sl_price)}</span><span style="color:#00ff88;font-weight:700">BREAKEVEN</span>`
    : `<span style="color:#ff4444;font-weight:700">${fmtPrice(alert.sl_price)}</span>`;

  // Progress bar: 0% = SL (worst), 100% = TP2 (best)
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
  // Interpolate color red→green
  const t  = progressPct / 100;
  const pr = Math.round(0xff + (0x00 - 0xff) * t);
  const pg = Math.round(0x44 + (0xff - 0x44) * t);
  const pb = Math.round(0x44 + (0x88 - 0x44) * t);
  const fillColor = `rgb(${pr},${pg},${pb})`;

  let html = `<div class="ac">`;

  // ── Header
  html += `
    <div>
      <div class="ac-header-top">
        <div class="ac-sig">
          <span class="ac-sym">${alert.symbol}</span>
          ${dirBadge}
          ${scoreChip}
        </div>
        <div class="ac-right">
          <span style="color:${adxColor};font-weight:700">ADX ${fmt(alert.adx, 1)}</span>
          <span style="color:${trendColor};font-weight:700">${trendLabel}</span>
        </div>
      </div>
      <div class="ac-ts">${relTime(alert.fired_at)}</div>
    </div>`;

  // ── IN TRADE status
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

  // ── Position details
  html += `
    <div>
      <div class="ac-section-label">Position</div>
      <div class="ac-detail-grid">
        <div class="ac-detail-row"><span class="ac-detail-label">MARGIN</span><span class="ac-detail-val" style="color:#ffffff">$${fmt(alert.margin, 0)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">ADX</span><span class="ac-detail-val" style="color:${adxColor}">${fmt(alert.adx, 1)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">LEVERAGE</span><span class="ac-detail-val" style="color:#ffffff">${alert.leverage}x</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">RSI 5M</span><span class="ac-detail-val" style="color:${rsiColor(alert.rsi_5m)}">${fmt(alert.rsi_5m ?? 50, 1)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">DOLLAR RISK</span><span class="ac-detail-val" style="color:#ffaa00">$${fmt(alert.dollar_risk, 2)}</span></div>
        <div class="ac-detail-row"><span class="ac-detail-label">RSI 1H</span><span class="ac-detail-val" style="color:${rsiColor(alert.rsi_1h)}">${fmt(alert.rsi_1h ?? 50, 1)}</span></div>
      </div>
    </div>`;

  // ── Levels
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

  // ── Progress bar
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

  // ── Footer
  html += `<div class="ac-footer"><span class="ac-elapsed">Fired ${relTime(alert.fired_at)}</span>`;
  if (!inTrade) {
    const autoInfo = (state.auto_pending || {})[key];
    if (autoInfo) {
      const remaining = Math.max(0, Math.ceil(autoInfo.fire_at - Date.now() / 1000));
      const label = remaining > 0 ? `AUTO IN ${remaining}s` : 'OPENING…';
      html += `<button class="pill pill-open" style="background:#ffaa00;color:#000;cursor:default;min-width:100px" data-auto-key="${key}">${label}</button>`;
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

// ── Alerts render ─────────────────────────────────────────────────────────────

function renderAlerts() {
  if (!state) return;
  const container = document.getElementById('alerts-container');
  const alerts = (state.alerts || []).slice().reverse(); // newest first
  const pendings = (state.pending_alerts || []).slice().reverse();

  // Filter out pendings that already have a confirmed alert
  const confirmedKeys = new Set(alerts.map(a => `${a.symbol}${a.direction}`));
  const visiblePendings = pendings.filter(p => !confirmedKeys.has(`${p.symbol}${p.direction}`));

  if (alerts.length === 0 && visiblePendings.length === 0) {
    container.innerHTML = `
      <div class="alerts-empty">
        Scanning every 10s.<br>Alerts appear here when<br>TC conditions are met twice.
      </div>`;
    return;
  }

  const acc = state.account || {};
  const capReached = acc.cap_reached;
  const openTrades = state.open_trades || {};

  let html = '<div class="alerts-list">';

  // ── Pending cards (amber, no OPEN pill) ──────────────────────────────────
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
          ">● PENDING RECONFIRMATION</span>
        </div>
        <div class="alert-header-row">
          <div class="alert-sig">
            <span class="alert-sym">${p.symbol}</span>
            <span class="dir-pill ${isLong ? 'dir-long' : 'dir-short'}">${p.direction}</span>
          </div>
          <div class="alert-score">Score <span>${p.score}/7</span> · ADX <span style="color:${p.adx >= 30 ? '#00ff88' : '#666666'}">${fmt(p.adx, 1)}</span></div>
        </div>
        <div class="alert-grid">
          <div class="ag-row">
            <span class="ag-label">Trend</span>
            <span class="ag-val ${isLong ? 'trend-bull' : 'trend-bear'}">${p.trend}</span>
          </div>
          <div class="ag-row">
            <span class="ag-label">RSI 5m · 1h</span>
            <span class="ag-val"><span style="color:${rsiColor(p.rsi_5m)};font-weight:bold">${fmt(p.rsi_5m ?? 50, 1)}</span><span style="color:var(--muted)"> · </span><span style="color:${rsiColor(p.rsi_1h)};font-weight:bold">${fmt(p.rsi_1h ?? 50, 1)}</span></span>
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

  // ── Confirmed alert cards (new design) ───────────────────────────────────
  for (const alert of alerts) {
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
  renderMarketSnapshot();
  renderAlerts();
  renderTradeLog();
  updateAlertBadge();
}

// ── Trade log render ──────────────────────────────────────────────────────────

function renderTradeLog() {
  const container = document.getElementById('tradelog-container');
  if (!container || !state) return;
  const log = (state.trade_log || []).slice().reverse();

  if (log.length === 0) {
    container.innerHTML = '<div class="log-empty">No completed trades yet.</div>';
    return;
  }

  let html = '<div class="log-scroll"><table class="log-table"><thead><tr>'
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
  container.innerHTML = html;
}

async function clearTradeLog() {
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
