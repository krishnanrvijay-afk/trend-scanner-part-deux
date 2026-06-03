import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

DEPLOY_TIME = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

# Ensure the scanner logger emits at INFO level regardless of uvicorn's root config
_scanner_log = logging.getLogger("scanner")
if not _scanner_log.handlers:
    _sh = logging.StreamHandler()
    _sh.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
    _scanner_log.addHandler(_sh)
_scanner_log.setLevel(logging.INFO)
_scanner_log.propagate = False

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from config import (
    PAIRS, SCAN_INTERVAL_SECONDS, PRICE_INTERVAL_SECONDS,
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE, PAPER_MODE,
)
from hl_client import HLClient
from scanner import run_full_scan, get_pending

# ── App state ────────────────────────────────────────────────────────────────

class AppState:
    def __init__(self):
        self.pair_states: list[dict] = []
        self.alerts: list[dict] = []          # all alerts ever fired this session
        self.prices: dict[str, float] = {}    # live 1s price cache

        # Account / margin tracking
        self.margin_deployed: float = 0.0
        self.open_trades: dict[str, dict] = {}  # symbol+dir key → trade dict
        self.trades_opened: int = 0

        self.last_scan_at: Optional[int] = None
        self.scan_count: int = 0

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

            r_value = t.get("r_value", 1)
            r = round(pnl / (margin * (t.get("sl_pct", 1) / 100)), 2) if r_value else 0

            trades_serialised[k] = {
                **t,
                "current_price": current,
                "unrealized_pnl": round(pnl, 2),
                "r": r,
                "elapsed_s": int(time.time()) - t.get("opened_at", int(time.time())),
            }

        return {
            "pair_states": self.pair_states,
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
        }


app_state = AppState()
hl_client: Optional[HLClient] = None


# ── Background tasks ──────────────────────────────────────────────────────────

async def scan_loop():
    global app_state, hl_client
    while True:
        try:
            pair_states, new_alerts = await run_full_scan(hl_client)
            app_state.pair_states = pair_states

            # Update price cache from scan results
            for ps in pair_states:
                sym = ps.get("symbol")
                price = ps.get("price")
                if sym and price:
                    app_state.prices[sym] = price

            # Attach existing alert state (is_in_trade) to new alerts
            for alert in new_alerts:
                key = app_state.get_trade_key(alert["symbol"], alert["direction"])
                alert["is_in_trade"] = key in app_state.open_trades
                alert["alert_id"] = f"{alert['symbol']}{alert['direction']}{alert['fired_at']}"

            # Merge: don't duplicate alerts with same symbol+direction within cooldown window
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

            # Keep only last 50 alerts
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
        except Exception as e:
            print(f"[price_loop] Error: {e}")
        await asyncio.sleep(PRICE_INTERVAL_SECONDS)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global hl_client
    hl_client = HLClient()
    print("[startup] HLClient initialized")

    # Kick off background tasks
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
    global hl_client

    # Cap check
    if app_state.margin_deployed + req.margin_usdc > MARGIN_HARD_CAP_USDC:
        raise HTTPException(
            status_code=400,
            detail=f"Cap reached — {MARGIN_HARD_CAP_USDC} USDC limit. "
                   f"Deployed: {app_state.margin_deployed:.0f} USDC. "
                   f"Cannot open another {req.margin_usdc:.0f} USDC trade."
        )

    key = app_state.get_trade_key(req.symbol, req.direction)
    if key in app_state.open_trades:
        raise HTTPException(status_code=400, detail=f"Trade already open for {key}")

    result = await hl_client.open_position(
        req.symbol, req.direction, req.margin_usdc, req.leverage
    )
    if result.get("status") != "ok":
        raise HTTPException(status_code=500, detail=result.get("msg", "Failed to open trade"))

    # Find matching alert for SL/TP data
    alert = next(
        (a for a in reversed(app_state.alerts)
         if a["symbol"] == req.symbol and a["direction"] == req.direction),
        None
    )

    entry = result["entry_price"]
    size = result.get("size", (req.margin_usdc * req.leverage) / entry if entry else 0)

    trade = {
        "symbol": req.symbol,
        "direction": req.direction,
        "entry_price": entry,
        "size": size,
        "margin": req.margin_usdc,
        "leverage": req.leverage,
        "opened_at": int(time.time()),
        "paper": result.get("paper", True),
        "sl_price": alert["sl_price"] if alert else None,
        "sl_pct": alert["sl_pct"] if alert else None,
        "dollar_risk": alert["dollar_risk"] if alert else None,
        "tp1_price": alert["tp1_price"] if alert else None,
        "tp2_price": alert["tp2_price"] if alert else None,
        "r_value": alert["sl_price"] if alert else None,
        "score": alert["score"] if alert else None,
    }

    app_state.open_trades[key] = trade
    app_state.margin_deployed += req.margin_usdc
    app_state.trades_opened += 1

    # Mark alert as in-trade
    for a in app_state.alerts:
        if a["symbol"] == req.symbol and a["direction"] == req.direction:
            a["is_in_trade"] = True

    return {"status": "ok", "trade": trade}


class CloseTradeRequest(BaseModel):
    symbol: str
    direction: str


@app.post("/api/trade/close")
async def close_trade(req: CloseTradeRequest):
    global hl_client

    key = app_state.get_trade_key(req.symbol, req.direction)
    trade = app_state.open_trades.get(key)
    if not trade:
        raise HTTPException(status_code=404, detail=f"No open trade for {key}")

    result = await hl_client.close_position(req.symbol, req.direction, trade["size"])
    if result.get("status") != "ok":
        raise HTTPException(status_code=500, detail=result.get("msg", "Failed to close trade"))

    close_price = result.get("close_price", app_state.prices.get(req.symbol, trade["entry_price"]))

    # Calculate final PnL
    entry = trade["entry_price"]
    size = trade["size"]
    if req.direction == "LONG":
        pnl = (close_price - entry) * size
    else:
        pnl = (entry - close_price) * size

    # Release margin
    app_state.margin_deployed = max(0.0, app_state.margin_deployed - trade["margin"])
    closed_trade = {**trade, "close_price": close_price, "final_pnl": round(pnl, 2)}
    del app_state.open_trades[key]

    # Update alert is_in_trade flag
    for a in app_state.alerts:
        if a["symbol"] == req.symbol and a["direction"] == req.direction:
            a["is_in_trade"] = False

    return {"status": "ok", "closed": closed_trade}
