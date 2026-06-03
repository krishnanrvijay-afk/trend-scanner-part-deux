import asyncio
import csv
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

_EDT = timezone(timedelta(hours=-4))
DEPLOY_TIME = datetime.now(_EDT).strftime("%Y-%m-%d %H:%M EDT")

# Ensure the scanner logger emits at INFO level regardless of uvicorn's root config
_scanner_log = logging.getLogger("scanner")
if not _scanner_log.handlers:
    _sh = logging.StreamHandler()
    _sh.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
    _scanner_log.addHandler(_sh)
_scanner_log.setLevel(logging.INFO)
_scanner_log.propagate = False

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from config import (
    PAIRS, SCAN_INTERVAL_SECONDS, PRICE_INTERVAL_SECONDS,
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE, PAPER_MODE,
)
from hl_client import HLClient
from scanner import run_full_scan, get_pending, set_close_cooldown, reset_scan_counter, get_cooldown_remaining

# ── App state ─────────────────────────────────────────────────────────────────

class AppState:
    def __init__(self):
        self.pair_states: list[dict] = []
        self.alerts: list[dict] = []
        self.prices: dict[str, float] = {}
        self.margin_deployed: float = 0.0
        self.open_trades: dict[str, dict] = {}
        self.trades_opened: int = 0
        self.last_scan_at: Optional[int] = None
        self.scan_count: int = 0
        self.trade_log: list[dict] = []
        self.auto_pending: dict[str, dict] = {}   # key → {symbol, direction, fire_at}

    @property
    def cap_pct(self) -> float:
        return (self.margin_deployed / MARGIN_HARD_CAP_USDC) * 100

    @property
    def cap_reached(self) -> bool:
        return self.margin_deployed >= MARGIN_HARD_CAP_USDC

    def get_trade_key(self, symbol: str, direction: str) -> str:
        return f"{symbol}{direction}"

    def serialise(self) -> dict:
        trades_serialised = {}
        for k, t in self.open_trades.items():
            entry = t["entry_price"]
            current = self.prices.get(t["symbol"], entry)
            direction = t["direction"]
            size = t.get("size", 0)
            margin = t.get("margin", 0)

            if direction == "LONG":
                pnl = (current - entry) * size
            else:
                pnl = (entry - current) * size

            dollar_risk = t.get("dollar_risk") or (margin * (t.get("sl_pct", 1) / 100))
            r = round(pnl / dollar_risk, 2) if dollar_risk else 0

            trades_serialised[k] = {
                **t,
                "current_price": current,
                "unrealized_pnl": round(pnl, 2),
                "r": r,
                "elapsed_s": int(time.time()) - t.get("opened_at", int(time.time())),
            }

        # Augment each pair state with live cooldown remaining (computed at request time)
        pair_states_out = []
        for ps in self.pair_states:
            sym = ps.get("symbol", "")
            cd = max(
                get_cooldown_remaining(sym, "LONG"),
                get_cooldown_remaining(sym, "SHORT"),
            )
            pair_states_out.append({**ps, "cooldown_remaining_seconds": cd if cd > 0 else None})

        return {
            "pair_states": pair_states_out,
            "alerts": self.alerts,
            "pending_alerts": get_pending(),
            "prices": self.prices,
            "open_trades": trades_serialised,
            "account": {
                "margin_deployed": round(self.margin_deployed, 2),
                "cap": MARGIN_HARD_CAP_USDC,
                "cap_pct": round(self.cap_pct, 1),
                "cap_reached": self.cap_reached,
                "trades_opened": self.trades_opened,
                "paper_mode": PAPER_MODE,
            },
            "last_scan_at": self.last_scan_at,
            "scan_count": self.scan_count,
            "deploy_time": DEPLOY_TIME,
            "auto_pending": self.auto_pending,
            "trade_log": self.trade_log,
        }


app_state = AppState()
hl_client: Optional[HLClient] = None


# ── Alert retirement ──────────────────────────────────────────────────────────

def _retire_alert(symbol: str, direction: str):
    """Remove the originating alert when its trade fully closes. Prevents resurrection."""
    app_state.alerts = [
        a for a in app_state.alerts
        if not (a["symbol"] == symbol and a["direction"] == direction)
    ]


# ── Trade log helper ──────────────────────────────────────────────────────────

def _append_trade_log(trade: dict, exit_price: float, reason: str, pnl: float, r: float):
    app_state.trade_log.append({
        "timestamp_opened": trade.get("opened_at", 0),
        "timestamp_closed": int(time.time()),
        "symbol": trade["symbol"],
        "direction": trade["direction"],
        "score": trade.get("score"),
        "adx": trade.get("adx"),
        "entry_price": trade["entry_price"],
        "sl_price": trade.get("sl_price"),
        "tp1_price": trade.get("tp1_price"),
        "tp2_price": trade.get("tp2_price"),
        "exit_price": exit_price,
        "exit_reason": reason,
        "pnl_usd": round(pnl, 2),
        "r_value": r,
        "duration_seconds": int(time.time()) - trade.get("opened_at", int(time.time())),
    })


# ── Shared open trade logic ───────────────────────────────────────────────────

async def _do_open_trade(
    symbol: str, direction: str,
    margin_usdc: float, leverage: int,
    alert_data: Optional[dict] = None,
) -> tuple[Optional[dict], Optional[str]]:
    if app_state.margin_deployed + margin_usdc > MARGIN_HARD_CAP_USDC:
        return None, "cap_reached"
    key = app_state.get_trade_key(symbol, direction)
    if key in app_state.open_trades:
        return None, "already_open"

    result = await hl_client.open_position(symbol, direction, margin_usdc, leverage)
    if result.get("status") != "ok":
        return None, result.get("msg", "open_failed")

    entry = result["entry_price"]
    size = result.get("size", (margin_usdc * leverage) / entry if entry else 0)

    trade = {
        "symbol": symbol,
        "direction": direction,
        "entry_price": entry,
        "size": size,
        "remaining_size": size,
        "margin": margin_usdc,
        "leverage": leverage,
        "opened_at": int(time.time()),
        "paper": result.get("paper", True),
        "sl_price": alert_data["sl_price"] if alert_data else None,
        "sl_pct": alert_data["sl_pct"] if alert_data else None,
        "dollar_risk": alert_data["dollar_risk"] if alert_data else None,
        "tp1_price": alert_data["tp1_price"] if alert_data else None,
        "tp2_price": alert_data["tp2_price"] if alert_data else None,
        "score": alert_data.get("score") if alert_data else None,
        "adx": alert_data.get("adx") if alert_data else None,
        "tp1_hit": False,
    }

    app_state.open_trades[key] = trade
    app_state.margin_deployed += margin_usdc
    app_state.trades_opened += 1

    for a in app_state.alerts:
        if a["symbol"] == symbol and a["direction"] == direction:
            a["is_in_trade"] = True

    return trade, None


# ── Auto-entry (3s countdown) ─────────────────────────────────────────────────

async def _auto_open_trade(trade_key: str, alert: dict):
    await asyncio.sleep(3)
    app_state.auto_pending.pop(trade_key, None)
    if trade_key in app_state.open_trades or app_state.cap_reached:
        return
    trade, err = await _do_open_trade(
        alert["symbol"], alert["direction"],
        DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE, alert,
    )
    if trade:
        print(f"[auto-entry] {alert['symbol']} {alert['direction']} opened at {trade['entry_price']}")
    else:
        print(f"[auto-entry] {alert['symbol']} {alert['direction']} skipped: {err}")


# ── Auto-exit: TP1 partial / TP2 / SL ────────────────────────────────────────

async def _check_tp_sl_exits():
    to_process: list[tuple[str, str, float]] = []

    for key, trade in list(app_state.open_trades.items()):
        price = app_state.prices.get(trade["symbol"])
        if not price:
            continue
        direction = trade["direction"]
        tp1_hit = trade.get("tp1_hit", False)
        tp1 = trade.get("tp1_price")
        tp2 = trade.get("tp2_price")
        sl = trade.get("sl_price")

        if not tp1_hit:
            if tp1 and ((direction == "LONG" and price >= tp1) or (direction == "SHORT" and price <= tp1)):
                to_process.append((key, "TP1_PARTIAL", price))
                continue
            if sl and ((direction == "LONG" and price <= sl) or (direction == "SHORT" and price >= sl)):
                to_process.append((key, "SL", price))
        else:
            if tp2 and ((direction == "LONG" and price >= tp2) or (direction == "SHORT" and price <= tp2)):
                to_process.append((key, "TP2", price))
                continue
            if sl and ((direction == "LONG" and price <= sl) or (direction == "SHORT" and price >= sl)):
                to_process.append((key, "SL", price))

    for key, reason, close_price in to_process:
        await _execute_auto_exit(key, reason, close_price)


async def _execute_auto_exit(key: str, reason: str, close_price: float):
    trade = app_state.open_trades.get(key)
    if not trade:
        return

    sym = trade["symbol"]
    direction = trade["direction"]
    entry = trade["entry_price"]
    dollar_risk = trade.get("dollar_risk") or (trade["margin"] * (trade.get("sl_pct", 1) / 100))

    if reason == "TP1_PARTIAL":
        half = trade.get("remaining_size", trade["size"]) / 2
        pnl = ((close_price - entry) if direction == "LONG" else (entry - close_price)) * half
        r = round(pnl / (dollar_risk / 2), 2) if dollar_risk else 0
        _append_trade_log(trade, close_price, "TP1_PARTIAL", pnl, r)

        trade["tp1_hit"] = True
        trade["remaining_size"] = half
        trade["size"] = half
        trade["sl_price"] = entry
        app_state.open_trades[key] = trade
        print(f"[auto-exit] {sym} {direction} TP1 at {close_price:.4f} — partial, SL→entry {entry:.4f}, PnL=${pnl:.2f}")

    else:
        remaining = trade.get("remaining_size", trade["size"])
        pnl = ((close_price - entry) if direction == "LONG" else (entry - close_price)) * remaining
        r_basis = (dollar_risk / 2) if trade.get("tp1_hit") else dollar_risk
        r = round(pnl / r_basis, 2) if r_basis else 0
        _append_trade_log(trade, close_price, reason, pnl, r)

        app_state.margin_deployed = max(0.0, app_state.margin_deployed - trade["margin"])
        del app_state.open_trades[key]
        _retire_alert(sym, direction)
        set_close_cooldown(sym, direction)
        reset_scan_counter(sym, direction)
        print(f"[auto-exit] {sym} {direction} {reason} at {close_price:.4f}, PnL=${pnl:.2f}, R={r}")


# ── Background tasks ──────────────────────────────────────────────────────────

async def scan_loop():
    global app_state, hl_client
    while True:
        try:
            pair_states, new_alerts = await run_full_scan(hl_client)
            app_state.pair_states = pair_states

            for ps in pair_states:
                sym = ps.get("symbol")
                price = ps.get("price")
                if sym and price:
                    app_state.prices[sym] = price

            for alert in new_alerts:
                key = app_state.get_trade_key(alert["symbol"], alert["direction"])
                alert["is_in_trade"] = key in app_state.open_trades
                alert["alert_id"] = f"{alert['symbol']}{alert['direction']}{alert['fired_at']}"

            existing_keys = {
                (a["symbol"], a["direction"])
                for a in app_state.alerts
                if time.time() - a["fired_at"] < 90 * 60
            }
            for alert in new_alerts:
                k = (alert["symbol"], alert["direction"])
                if k not in existing_keys:
                    app_state.alerts.append(alert)
                    existing_keys.add(k)
                    if PAPER_MODE:
                        trade_key = app_state.get_trade_key(alert["symbol"], alert["direction"])
                        if trade_key not in app_state.open_trades and not app_state.cap_reached:
                            app_state.auto_pending[trade_key] = {
                                "symbol": alert["symbol"],
                                "direction": alert["direction"],
                                "fire_at": time.time() + 3,
                            }
                            asyncio.create_task(_auto_open_trade(trade_key, alert))
                            print(f"[auto-entry] {alert['symbol']} {alert['direction']} scheduled in 3s")

            app_state.alerts = app_state.alerts[-50:]
            app_state.last_scan_at = int(time.time())
            app_state.scan_count += 1
            print(f"[scan] #{app_state.scan_count} complete — {len(new_alerts)} new alerts")
        except Exception as e:
            print(f"[scan_loop] Error: {e}")

        await asyncio.sleep(SCAN_INTERVAL_SECONDS)


async def price_loop():
    global app_state, hl_client
    while True:
        try:
            prices = await hl_client.get_all_prices()
            for sym in PAIRS:
                if sym in prices:
                    app_state.prices[sym] = prices[sym]
            if PAPER_MODE and app_state.open_trades:
                await _check_tp_sl_exits()
        except Exception as e:
            print(f"[price_loop] Error: {e}")
        await asyncio.sleep(PRICE_INTERVAL_SECONDS)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global hl_client
    hl_client = HLClient()
    print("[startup] HLClient initialized")

    scan_task = asyncio.create_task(scan_loop())
    price_task = asyncio.create_task(price_loop())

    yield

    scan_task.cancel()
    price_task.cancel()
    await hl_client.close()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "paper_mode": PAPER_MODE,
            "scan_interval": SCAN_INTERVAL_SECONDS,
            "margin_cap": MARGIN_HARD_CAP_USDC,
        },
    )


@app.get("/api/state")
async def get_state():
    return app_state.serialise()


@app.get("/api/account")
async def get_account():
    return {
        "margin_deployed": round(app_state.margin_deployed, 2),
        "cap": MARGIN_HARD_CAP_USDC,
        "cap_pct": round(app_state.cap_pct, 1),
        "cap_reached": app_state.cap_reached,
        "trades_opened": app_state.trades_opened,
        "open_count": len(app_state.open_trades),
        "paper_mode": PAPER_MODE,
    }


class OpenTradeRequest(BaseModel):
    symbol: str
    direction: str
    margin_usdc: float = DEFAULT_MARGIN_USDC
    leverage: int = DEFAULT_LEVERAGE
    alert_id: Optional[str] = None


@app.post("/api/trade/open")
async def open_trade(req: OpenTradeRequest):
    trade_key = app_state.get_trade_key(req.symbol, req.direction)
    app_state.auto_pending.pop(trade_key, None)

    alert = next(
        (a for a in reversed(app_state.alerts)
         if a["symbol"] == req.symbol and a["direction"] == req.direction),
        None,
    )
    trade, err = await _do_open_trade(
        req.symbol, req.direction, req.margin_usdc, req.leverage, alert
    )
    if not trade:
        if err == "cap_reached":
            raise HTTPException(
                status_code=400,
                detail=f"Cap reached — {MARGIN_HARD_CAP_USDC} USDC limit. "
                       f"Deployed: {app_state.margin_deployed:.0f} USDC.",
            )
        elif err == "already_open":
            raise HTTPException(status_code=400, detail=f"Trade already open for {trade_key}")
        else:
            raise HTTPException(status_code=500, detail=err)
    return {"status": "ok", "trade": trade}


class CloseTradeRequest(BaseModel):
    symbol: str
    direction: str


@app.post("/api/trade/close")
async def close_trade(req: CloseTradeRequest):
    key = app_state.get_trade_key(req.symbol, req.direction)
    trade = app_state.open_trades.get(key)
    if not trade:
        raise HTTPException(status_code=404, detail=f"No open trade for {key}")

    result = await hl_client.close_position(req.symbol, req.direction, trade["size"])
    if result.get("status") != "ok":
        raise HTTPException(status_code=500, detail=result.get("msg", "Failed to close trade"))

    close_price = result.get("close_price", app_state.prices.get(req.symbol, trade["entry_price"]))
    entry = trade["entry_price"]
    remaining = trade.get("remaining_size", trade["size"])

    if req.direction == "LONG":
        pnl = (close_price - entry) * remaining
    else:
        pnl = (entry - close_price) * remaining

    dollar_risk = trade.get("dollar_risk") or (trade["margin"] * (trade.get("sl_pct", 1) / 100))
    r_basis = (dollar_risk / 2) if trade.get("tp1_hit") else dollar_risk
    r = round(pnl / r_basis, 2) if r_basis else 0
    _append_trade_log(trade, close_price, "MANUAL", pnl, r)

    app_state.margin_deployed = max(0.0, app_state.margin_deployed - trade["margin"])
    closed_trade = {**trade, "close_price": close_price, "final_pnl": round(pnl, 2)}
    del app_state.open_trades[key]
    _retire_alert(req.symbol, req.direction)
    set_close_cooldown(req.symbol, req.direction)
    reset_scan_counter(req.symbol, req.direction)

    return {"status": "ok", "closed": closed_trade}


# ── Trade log routes ──────────────────────────────────────────────────────────

@app.get("/api/tradelog")
async def get_tradelog():
    return app_state.trade_log


@app.get("/api/tradelog/csv")
async def download_tradelog_csv():
    fieldnames = [
        "timestamp_opened", "timestamp_closed", "symbol", "direction",
        "score", "adx", "entry_price", "sl_price", "tp1_price", "tp2_price",
        "exit_price", "exit_reason", "pnl_usd", "r_value", "duration_seconds",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for row in app_state.trade_log:
        writer.writerow({k: row.get(k, "") for k in fieldnames})
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    content = output.getvalue()
    return StreamingResponse(
        iter([content]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=trade_log_{today}.csv"},
    )


@app.delete("/api/tradelog")
async def clear_tradelog():
    app_state.trade_log.clear()
    return {"status": "ok", "cleared": True}
