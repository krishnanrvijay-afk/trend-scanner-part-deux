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
        order_type: str = "MARKET",
        limit_px: Optional[float] = None,
        sl_price: Optional[float] = None,
    ) -> dict:
        if self._paper_mode:
            price = entry_price or limit_px or await self.get_price(symbol) or 0.0
            size  = (margin_usdc * leverage) / price if price > 0 else 0.0
            if order_type == "LIMIT" and limit_px:
                return {
                    "status":    "pending",
                    "paper":     True,
                    "exchange":  "MEXC",
                    "order_id":  f"paper-{int(time.time())}",
                    "symbol":    symbol,
                    "direction": direction,
                    "limit_px":  limit_px,
                    "size":      size,
                    "margin":    margin_usdc,
                    "leverage":  leverage,
                    "timestamp": int(time.time()),
                }
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

            exec_px = limit_px if (order_type == "LIMIT" and limit_px) else price
            size    = round((margin_usdc * leverage) / exec_px, 6)
            # MEXC side: 1=open_long, 2=close_short, 3=open_short, 4=close_long
            side      = 1 if direction.upper() == "LONG" else 3
            # MEXC type: 5=market, 1=limit
            mexc_type = 1 if (order_type == "LIMIT" and limit_px) else 5

            ts   = str(int(time.time() * 1000))
            body = {
                "symbol":   f"{symbol}_USDT",
                "side":     side,
                "openType": 1,          # 1 = isolated margin
                "type":     mexc_type,
                "vol":      size,
                "leverage": leverage,
            }
            if mexc_type == 1:
                body["price"] = exec_px
            if sl_price:
                body["stopLossPrice"] = sl_price

            sig_params    = {**body, "timestamp": ts, "api_key": self._api_key}
            body["sign"]  = self._sign(sig_params)

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
                order_id = str(data.get("data", ""))
                base_resp = {
                    "status":    "ok",
                    "paper":     False,
                    "exchange":  "MEXC",
                    "symbol":    symbol,
                    "direction": direction,
                    "size":      size,
                    "margin":    margin_usdc,
                    "leverage":  leverage,
                    "timestamp": int(time.time()),
                    "order_id":  order_id,
                    "raw":       data,
                }
                if order_type == "LIMIT" and limit_px:
                    return {**base_resp, "status": "pending", "limit_px": exec_px}
                return {**base_resp, "entry_price": exec_px}
            return {"status": "error", "msg": data.get("message", "MEXC order rejected")}

        except Exception as e:
            return {"status": "error", "msg": str(e)}

    async def cancel_order(self, symbol: str, order_id: str) -> dict:
        if self._paper_mode:
            print(f"[MexcClient] cancel_order paper: {symbol} {order_id}")
            return {"status": "ok", "paper": True}
        try:
            if not self._api_key or not self._secret_key:
                return {"status": "error", "msg": "MEXC credentials not configured"}

            ts         = str(int(time.time() * 1000))
            params     = {
                "symbol":    f"{symbol}_USDT",
                "orderId":   order_id,
                "timestamp": ts,
                "api_key":   self._api_key,
            }
            params["sign"] = self._sign(params)

            resp = await self._http.delete(
                f"{MEXC_API_BASE}/api/v1/private/order/cancel",
                params=params,
                headers={
                    "ApiKey":       self._api_key,
                    "Request-Time": ts,
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("success"):
                return {"status": "ok", "raw": data}
            return {"status": "error", "msg": data.get("message", "MEXC cancel rejected")}
        except Exception as e:
            print(f"[MexcClient] cancel_order({symbol}, {order_id}) error: {e}")
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
