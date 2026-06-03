/* Trend Scanner Part Deux — dashboard.js */

let state = null;

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
}

// ── Pair table render ─────────────────────────────────────────────────────────

function renderPairTable() {
  if (!state) return;
  const tbody = document.getElementById('pair-tbody');

  const pairs = state.pair_states || [];
  if (pairs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:30px;">No data yet — first scan in progress…</td></tr>';
    return;
  }

  // Sort: Strong Bull/Bear first, then by max score desc
  const sorted = [...pairs].sort((a, b) => {
    const aMax = Math.max(a.long_score || 0, a.short_score || 0);
    const bMax = Math.max(b.long_score || 0, b.short_score || 0);
    return bMax - aMax;
  });

  let html = '';
  for (const p of sorted) {
    const trendClass = p.trend === 'Strong Bull' ? 'trend-bull'
      : p.trend === 'Strong Bear' ? 'trend-bear' : 'trend-neu';
    const trendLabel = p.trend === 'Strong Bull' ? '▲ S.Bull'
      : p.trend === 'Strong Bear' ? '▼ S.Bear' : '— Neutral';

    const livePrice = (state.prices && state.prices[p.symbol]) || p.price;

    html += `
      <tr>
        <td class="sym">${p.symbol}</td>
        <td class="${trendClass}">${trendLabel}</td>
        <td class="price-cell">${fmtPrice(livePrice)}</td>
        <td class="${scoreClass(p.long_score)}">${p.long_score ?? '—'}</td>
        <td class="${scoreClass(p.short_score)}">${p.short_score ?? '—'}</td>
        <td>${fmt(p.adx, 1)}</td>
        <td>${fmt(p.j5, 1)}</td>
        <td>${fmt(p.bid_pct, 1)}%</td>
        <td>${fmt(p.ask_pct, 1)}%</td>
      </tr>`;
  }
  tbody.innerHTML = html;
}

// ── Alerts render ─────────────────────────────────────────────────────────────

function renderAlerts() {
  if (!state) return;
  const container = document.getElementById('alerts-container');
  const alerts = (state.alerts || []).slice().reverse(); // newest first

  if (alerts.length === 0) {
    container.innerHTML = `
      <div class="alerts-empty">
        Scanning every 20s.<br>Alerts appear here when<br>TC conditions are met twice.
      </div>`;
    return;
  }

  const acc = state.account || {};
  const capReached = acc.cap_reached;
  const openTrades = state.open_trades || {};

  let html = '<div class="alerts-list">';
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
      const pnlClass = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
      const pnlSign = pnl >= 0 ? '+' : '';
      const r = trade.r ?? 0;
      const rClass = r >= 0 ? 'pnl-pos' : 'pnl-neg';
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
            <span class="ag-val ${pnlClass}">${pnlSign}$${fmt(pnl, 2)} <span style="font-size:10px;color:var(--muted)">${pnlSign}${fmt(r, 2)}R</span></span>
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
        <div class="alert-score">Score <span>${alert.score}/7</span> · ADX ${fmt(alert.adx, 1)}</div>
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
      const disabled = capReached ? 'disabled title="Margin cap reached"' : '';
      html += `
        <button class="pill pill-open" ${disabled}
          onclick="openTrade('${alert.symbol}', '${alert.direction}')">
          ▶ OPEN TRADE
        </button>`;
    } else {
      html += `
        <button class="pill pill-close"
          onclick="closeTrade('${alert.symbol}', '${alert.direction}')">
          ■ CLOSE TRADE
        </button>`;
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
