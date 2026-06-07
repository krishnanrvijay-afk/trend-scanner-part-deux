"""MEXC Futures client — paper and live modes."""

import hashlib
import hmac
import os
import time
from typing import Optional

import httpx

from config import PAPER_MODE

MEXC_API_BASE = "https://contract.mexc.com"


class MexcClient:
    def __init__(self):
        self._http       = httpx.AsyncClient(timeout=10.0)
        self._paper_mode = PAPER_MODE
        self._api_key    = os.getenv("MEXC_API_KEY",    "")
        self._secret_key = os.getenv("MEXC_SECRET_KEY", "")

    def _sign(self, params: dict) -> str:
        query = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        return hmac.new(
            self._secret_key.encode(),
            query.encode(),
            hashlib.sha256,
        ).hexdigest()

    # ── Public price ──────────────────────────────────────────────────────────

    async def get_price(self, symbol: str) -> Optional[float]:
        try:
            resp = await self._http.get(
                f"{MEXC_API_BASE}/api/v1/contract/ticker",
                params={"symbol": f"{symbol}_USDT"},
            )
            resp.raise_for_status()
            data = resp.json()
            px = data.get("data", {}).get("lastPrice")
            return float(px) if px else None
        except Exception as e:
            print(f"[MexcClient] get_price({symbol}) error: {e}")
            return None

    # ── Open position ─────────────────────────────────────────────────────────

    async def open_position(
        self,
        symbol: str,
        direction: str,
        margin_usdc: float,
        leverage: int,
        entry_price: Optional[float] = None,
    ) -> dict:
        if self._paper_mode:
            price = entry_price or await self.get_price(symbol) or 0.0
            size  = (margin_usdc * leverage) / price if price > 0 else 0.0
            return {
                "status":      "ok",
                "paper":       True,
                "exchange":    "MEXC",
                "symbol":      symbol,
                "direction":   direction,
                "entry_price": price,
                "size":        size,
                "margin":      margin_usdc,
                "leverage":    leverage,
                "timestamp":   int(time.time()),
            }

        try:
            if not self._api_key or not self._secret_key:
                return {"status": "error", "msg": "MEXC_API_KEY / MEXC_SECRET_KEY not configured"}

            price = entry_price or await self.get_price(symbol) or 0.0
            if not price:
                return {"status": "error", "msg": "Failed to fetch MEXC price"}

            size = round((margin_usdc * leverage) / price, 6)
            # MEXC side: 1=open_long, 2=close_short, 3=open_short, 4=close_long
            side = 1 if direction.upper() == "LONG" else 3

            ts = str(int(time.time() * 1000))
            body = {
                "symbol":    f"{symbol}_USDT",
                "side":      side,
                "openType":  1,         # 1 = isolated margin
                "type":      5,         # 5 = market order
                "vol":       size,
                "leverage":  leverage,
            }
            sig_params = {**body, "timestamp": ts, "api_key": self._api_key}
            body["sign"] = self._sign(sig_params)

            resp = await self._http.post(
                f"{MEXC_API_BASE}/api/v1/private/order/submit",
                json=body,
                headers={
                    "ApiKey":       self._api_key,
                    "Request-Time": ts,
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()

            if data.get("success"):
                return {
                    "status":      "ok",
                    "paper":       False,
                    "exchange":    "MEXC",
                    "symbol":      symbol,
                    "direction":   direction,
                    "entry_price": price,
                    "size":        size,
                    "margin":      margin_usdc,
                    "leverage":    leverage,
                    "timestamp":   int(time.time()),
                    "raw":         data,
                }
            return {"status": "error", "msg": data.get("message", "MEXC order rejected")}

        except Exception as e:
            return {"status": "error", "msg": str(e)}

    # ── Close position ────────────────────────────────────────────────────────

    async def close_position(self, symbol: str, direction: str, size: float) -> dict:
        if self._paper_mode:
            price = await self.get_price(symbol) or 0.0
            return {
                "status":      "ok",
                "paper":       True,
                "exchange":    "MEXC",
                "symbol":      symbol,
                "close_price": price,
                "timestamp":   int(time.time()),
            }

        try:
            if not self._api_key or not self._secret_key:
                return {"status": "error", "msg": "MEXC credentials not configured"}

            price = await self.get_price(symbol) or 0.0
            side  = 4 if direction.upper() == "LONG" else 2   # 4=close_long, 2=close_short

            ts = str(int(time.time() * 1000))
            body = {
                "symbol":   f"{symbol}_USDT",
                "side":     side,
                "openType": 1,
                "type":     5,
                "vol":      abs(size),
                "leverage": 1,
            }
            sig_params = {**body, "timestamp": ts, "api_key": self._api_key}
            body["sign"] = self._sign(sig_params)

            resp = await self._http.post(
                f"{MEXC_API_BASE}/api/v1/private/order/submit",
                json=body,
                headers={
                    "ApiKey":       self._api_key,
                    "Request-Time": ts,
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()

            if data.get("success"):
                return {
                    "status":      "ok",
                    "paper":       False,
                    "exchange":    "MEXC",
                    "symbol":      symbol,
                    "close_price": price,
                    "timestamp":   int(time.time()),
                    "raw":         data,
                }
            return {"status": "error", "msg": data.get("message", "MEXC close rejected")}

        except Exception as e:
            return {"status": "error", "msg": str(e)}

    async def get_position_pnl(self, symbol: str) -> Optional[float]:
        return None  # live PnL query not required for paper mode

    async def close(self):
        await self._http.aclose()
