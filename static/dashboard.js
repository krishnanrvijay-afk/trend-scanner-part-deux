/* Trend Scanner Part Deux — dashboard.js */

let state = null;
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

  document.getElementById('margin-deployed').textContent =
    `${fmt(acc.margin_deployed, 0)} / ${fmt(acc.cap, 0)} USDC`;

  document.getElementById('trade-count').textContent =
    `${acc.trades_opened ?? 0} opened`;

  const pctLabel = document.getElementById('cap-pct-label');
  pctLabel.textContent = `${fmt(pct, 1)}%`;
  if (pct >= 90)       pctLabel.style.color = 'var(--red)';
  else if (pct >= 70)  pctLabel.style.color = 'var(--yellow)';
  else                 pctLabel.style.color = 'var(--text)';

  const bar = document.getElementById('cap-bar');
  bar.style.width = Math.min(pct, 100) + '%';
  bar.className = 'cap-bar-fill ' + (pct >= 90 ? 'cap-red' : pct >= 70 ? 'cap-yellow' : 'cap-green');

  const lastScan = state.last_scan_at;
  if (lastScan) {
    document.getElementById('scan-ago').textContent = relTime(lastScan);
  }

  const deployEl = document.getElementById('deploy-time');
  if (deployEl && state.deploy_time && !deployEl.dataset.set) {
    deployEl.textContent = 'DEPLOYED ' + state.deploy_time;
    deployEl.dataset.set = '1';
  }
}

// ── Pair table render ─────────────────────────────────────────────────────────
// Rows are updated in-place by data-symbol to preserve insertion order.
// Server returns pairs pre-sorted to match config.py PAIRS order.

function renderPairTable() {
  if (!state) return;
  const tbody = document.getElementById('pair-tbody');
  const pairs = state.pair_states || [];

  if (pairs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:30px;">No data yet — first scan in progress…</td></tr>';
    return;
  }

  // Clear any placeholder row (no data-symbol) left from the empty state
  const placeholder = tbody.querySelector('tr:not([data-symbol])');
  if (placeholder) tbody.innerHTML = '';

  for (const p of pairs) {
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
    const bidColor = bid >= 55 ? '#00ff88' : '#ffffff';
    const askColor = ask >= 55 ? '#ff4444' : '#ffffff';

    const cdSecs = cooldownEndsAt[p.symbol]
      ? Math.max(0, Math.ceil(cooldownEndsAt[p.symbol] - Date.now() / 1000))
      : 0;
    let sigCell;
    if (cdSecs > 0) {
      const cdM = Math.floor(cdSecs / 60);
      const cdS = cdSecs % 60;
      sigCell = `<span style="color:#666666;font-size:11px;white-space:nowrap" title="Cooldown active">🕐 ${cdM}m ${cdS < 10 ? '0' : ''}${cdS}s</span>`;
    } else {
      const sig = p.signal_state || 'none';
      sigCell = sig === 'confirmed' ? '<span style="color:#00ff88;font-size:15px" title="Confirmed">🔔</span>'
        : sig === 'pending' ? '<span style="color:#ffaa00;font-size:15px" title="Pending">⏳</span>'
        : '';
    }

    const cellsHtml = `
      <td class="sym">${p.symbol}</td>
      <td class="${trendClass}">${trendLabel}</td>
      <td class="price-cell">${fmtPrice(livePrice)}</td>
      <td style="color:${adxColor};text-align:right">${fmt(adx, 1)}</td>
      <td style="color:${j5Color};text-align:right">${fmt(j5, 1)}</td>
      <td style="color:${bidColor};text-align:right">${fmt(bid, 1)}%</td>
      <td style="color:${askColor};text-align:right">${fmt(ask, 1)}%</td>
      <td style="text-align:center">${sigCell}</td>`;

    let row = tbody.querySelector(`tr[data-symbol="${p.symbol}"]`);
    if (row) {
      row.innerHTML = cellsHtml;
    } else {
      row = document.createElement('tr');
      row.dataset.symbol = p.symbol;
      row.innerHTML = cellsHtml;
      tbody.appendChild(row);
    }
  }
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
            <span class="ag-label">First seen</span>
            <span class="ag-val" style="color:var(--muted)">${relTime(p.first_seen)}</span>
          </div>
        </div>
        <div class="alert-footer">
          <span class="alert-time" style="color:#ffaa00">Awaiting next scan…</span>
        </div>
      </div>`;
  }

  // ── Confirmed alert cards ─────────────────────────────────────────────────
  for (const alert of alerts) {
    const key = `${alert.symbol}${alert.direction}`;
    const trade = openTrades[key];
    const inTrade = !!trade;
    const isLong = alert.direction === 'LONG';

    const cardClass = inTrade
      ? (isLong ? 'alert-card in-trade' : 'alert-card in-trade-short')
      : 'alert-card';

    html += `<div class="${cardClass}">`;

    // IN TRADE badge
    if (inTrade) {
      const badgeClass = isLong ? 'in-trade-badge' : 'in-trade-badge short-badge';
      html += `
        <div class="${badgeClass}">
          <span>● IN TRADE</span>
          <span style="opacity:0.7">${elapsed(trade.opened_at)}</span>
        </div>`;

      // Live PnL row
      const pnl = trade.unrealized_pnl ?? 0;
      const pnlColor = pnl >= 0 ? '#00ff88' : '#ff4444';
      const pnlSign = pnl >= 0 ? '+' : '';
      const r = trade.r ?? 0;
      const rColor = r >= 0 ? '#00ff88' : '#ff4444';
      const rSign = r >= 0 ? '+' : '';
      const currentPrice = (state.prices && state.prices[alert.symbol]) || trade.current_price;

      html += `
        <div class="live-row">
          <div class="ag-row">
            <span class="ag-label">Entry</span>
            <span class="ag-val">${fmtPrice(trade.entry_price)}</span>
          </div>
          <div class="ag-row">
            <span class="ag-label">Current</span>
            <span class="ag-val">${fmtPrice(currentPrice)}</span>
          </div>
          <div class="ag-row">
            <span class="ag-label">PnL / R</span>
            <span class="ag-val"><span style="color:${pnlColor}">${pnlSign}$${fmt(pnl, 2)}</span> <span style="font-size:10px;color:${rColor}">${rSign}${fmt(r, 2)}R</span></span>
          </div>
        </div>`;
    }

    // Signal header row
    html += `
      <div class="alert-header-row">
        <div class="alert-sig">
          <span class="alert-sym">${alert.symbol}</span>
          <span class="dir-pill ${isLong ? 'dir-long' : 'dir-short'}">${alert.direction}</span>
        </div>
        <div class="alert-score">Score <span>${alert.score}/7</span> · ADX <span style="color:${alert.adx >= 30 ? '#00ff88' : '#666666'}">${fmt(alert.adx, 1)}</span></div>
      </div>`;

    // Info grid
    html += `<div class="alert-grid">`;

    if (!inTrade) {
      html += `
        <div class="ag-row">
          <span class="ag-label">Entry Zone</span>
          <span class="ag-val">${fmtPrice(alert.entry_price)}</span>
        </div>
        <div class="ag-row">
          <span class="ag-label">Margin · Lev</span>
          <span class="ag-val">${fmt(alert.margin, 0)} USDC · ${alert.leverage}x</span>
        </div>`;
    }

    html += `
      <div class="ag-row">
        <span class="ag-label">SL</span>
        <span class="ag-val sl-val">${fmtPrice(alert.sl_price)} <span style="font-size:10px">(${fmt(alert.sl_pct, 2)}%)</span></span>
      </div>
      <div class="ag-row">
        <span class="ag-label">Dollar Risk</span>
        <span class="ag-val sl-val">$${fmt(alert.dollar_risk, 2)}</span>
      </div>
      <div class="ag-row">
        <span class="ag-label">TP1 (1.5R)</span>
        <span class="ag-val tp1-val">${fmtPrice(alert.tp1_price)}</span>
      </div>
      <div class="ag-row">
        <span class="ag-label">TP2 (2.0R)</span>
        <span class="ag-val tp2-val">${fmtPrice(alert.tp2_price)}</span>
      </div>
      <div class="ag-row">
        <span class="ag-label">Trend</span>
        <span class="ag-val ${isLong ? 'trend-bull' : 'trend-bear'}">${alert.trend}</span>
      </div>
    </div>`;

    // Footer: timestamp + action pill
    html += `<div class="alert-footer">`;
    html += `<span class="alert-time">${relTime(alert.fired_at)}</span>`;

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

    html += `</div></div>`; // footer + card
  }

  html += '</div>';
  container.innerHTML = html;
}

// ── Render all ────────────────────────────────────────────────────────────────

function renderAll() {
  renderHeader();
  renderPairTable();
  renderAlerts();
  renderTradeLog();
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

// Initial load
poll();

// Price refresh every 1 second
setInterval(poll, 1000);
