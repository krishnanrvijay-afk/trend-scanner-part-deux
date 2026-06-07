import os
import time
import httpx
import asyncio
from typing import Optional
from config import HL_API_URL, PAPER_MODE


class HLClient:
    def __init__(self):
        self._http = httpx.AsyncClient(timeout=10.0)
        self._paper_mode = PAPER_MODE
        self._exchange = None
        self._info = None
        self._wallet_address = os.getenv("HL_WALLET_ADDRESS", "")

        if not self._paper_mode:
            self._init_live_client()

    def _init_live_client(self):
        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.info import Info
            from eth_account import Account

            private_key = os.getenv("HL_PRIVATE_KEY", "")
            if not private_key:
                raise ValueError("HL_PRIVATE_KEY not set — required for live trading")

            acct = Account.from_key(private_key)
            self._wallet_address = acct.address
            self._info = Info(HL_API_URL)
            self._exchange = Exchange(acct, HL_API_URL)
        except Exception as e:
            print(f"[HLClient] Failed to init live client: {e}")

    async def _post(self, payload: dict) -> dict | list:
        resp = await self._http.post(HL_API_URL, json=payload)
        resp.raise_for_status()
        return resp.json()

    async def get_price(self, symbol: str) -> Optional[float]:
        try:
            data = await self._post({"type": "allMids"})
            raw = data.get(symbol)
            if raw is None:
                return None
            return float(raw)
        except Exception as e:
            print(f"[HLClient] get_price({symbol}) error: {e}")
            return None

    async def get_all_prices(self) -> dict[str, float]:
        try:
            data = await self._post({"type": "allMids"})
            return {k: float(v) for k, v in data.items() if v is not None}
        except Exception as e:
            print(f"[HLClient] get_all_prices error: {e}")
            return {}

    async def get_candles(self, symbol: str, interval: str, limit: int = 50) -> list[dict]:
        try:
            now_ms = int(time.time() * 1000)
            interval_ms_map = {
                "1m": 60_000,
                "5m": 300_000,
                "15m": 900_000,
                "1h": 3_600_000,
                "4h": 14_400_000,
                "1d": 86_400_000,
            }
            interval_ms = interval_ms_map.get(interval, 300_000)
            start_ms = now_ms - interval_ms * (limit + 5)

            payload = {
                "type": "candleSnapshot",
                "req": {
                    "coin": symbol,
                    "interval": interval,
                    "startTime": start_ms,
                    "endTime": now_ms,
                },
            }
            data = await self._post(payload)

            candles = []
            for c in data:
                candles.append({
                    "time": c.get("t", 0),
                    "open": float(c.get("o", 0)),
                    "high": float(c.get("h", 0)),
                    "low": float(c.get("l", 0)),
                    "close": float(c.get("c", 0)),
                    "volume": float(c.get("v", 0)),
                })

            candles.sort(key=lambda x: x["time"])
            return candles[-limit:] if len(candles) > limit else candles
        except Exception as e:
            print(f"[HLClient] get_candles({symbol}, {interval}) error: {e}")
            return []

    async def get_orderbook(self, symbol: str, depth: int = 20) -> dict:
        try:
            data = await self._post({"type": "l2Book", "coin": symbol})
            levels = data.get("levels", [[], []])
            bids = levels[0] if len(levels) > 0 else []
            asks = levels[1] if len(levels) > 1 else []

            def parse_level(lvl):
                if isinstance(lvl, dict):
                    return {"px": float(lvl.get("px", 0)), "sz": float(lvl.get("sz", 0))}
                return {"px": 0.0, "sz": 0.0}

            return {
                "bids": [parse_level(b) for b in bids[:depth]],
                "asks": [parse_level(a) for a in asks[:depth]],
            }
        except Exception as e:
            print(f"[HLClient] get_orderbook({symbol}) error: {e}")
            return {"bids": [], "asks": []}

    async def get_funding_rate(self, symbol: str) -> Optional[float]:
        try:
            data = await self._post({"type": "metaAndAssetCtxs"})
            meta = data[0]
            asset_ctxs = data[1]
            universe = meta.get("universe", [])

            for i, asset in enumerate(universe):
                if asset.get("name") == symbol:
                    if i < len(asset_ctxs):
                        fr = asset_ctxs[i].get("funding", None)
                        if fr is not None:
                            return float(fr)
            return None
        except Exception as e:
            print(f"[HLClient] get_funding_rate({symbol}) error: {e}")
            return None

    # ── HL public endpoints used for universe metadata ──────────────────────
    # Single bulk call: POST /info {"type": "metaAndAssetCtxs"}
    # Returns [meta, assetCtxs] where:
    #   meta.universe[i]  = {name, szDecimals, maxLeverage, onlyIsolated, ...}
    #   assetCtxs[i]      = {funding, openInterest, prevDayPx, dayNtlVlm,
    #                         premium, oraclePx, markPx, midPx, impactPxs}
    # Volume  → dayNtlVlm          (24h notional, already in USD)
    # OI USD  → openInterest * markPx  (openInterest is in token units)
    # Funding → funding             (per-8h rate as decimal, e.g. 0.0001 = 0.01%)
    # One call covers all three fields — no per-asset fetches needed.
    async def get_universe_metadata(self) -> list[dict]:
        try:
            data = await self._post({"type": "metaAndAssetCtxs"})
            meta = data[0]
            asset_ctxs = data[1]
            universe = meta.get("universe", [])
            result = []
            for i, asset in enumerate(universe):
                if i >= len(asset_ctxs):
                    break
                ctx = asset_ctxs[i]
                symbol = asset.get("name", "")
                if not symbol:
                    continue
                try:
                    mark_px   = float(ctx.get("markPx") or ctx.get("oraclePx") or 0)
                    oi_tokens = float(ctx.get("openInterest") or 0)
                    oi_usd    = oi_tokens * mark_px
                    volume_usd = float(ctx.get("dayNtlVlm") or 0)
                    funding    = float(ctx.get("funding") or 0)
                except (TypeError, ValueError):
                    continue
                result.append({
                    "symbol": symbol,
                    "volume_24h_usd": volume_usd,
                    "open_interest_usd": oi_usd,
                    "funding_rate": funding,
                    "mark_px": mark_px,
                })
            return result
        except Exception as e:
            print(f"[HLClient] get_universe_metadata error: {e}")
            return []

    async def get_open_positions(self) -> list[dict]:
        if self._paper_mode:
            return []
        try:
            if self._info and self._wallet_address:
                state = self._info.user_state(self._wallet_address)
                positions = state.get("assetPositions", [])
                result = []
                for p in positions:
                    pos = p.get("position", {})
                    result.append({
                        "symbol": pos.get("coin"),
                        "size": float(pos.get("szi", 0)),
                        "entry_price": float(pos.get("entryPx", 0)),
                        "unrealized_pnl": float(pos.get("unrealizedPnl", 0)),
                    })
                return result
        except Exception as e:
            print(f"[HLClient] get_open_positions error: {e}")
        return []

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
            size = (margin_usdc * leverage) / price if price > 0 else 0.0
            return {
                "status": "ok",
                "paper": True,
                "symbol": symbol,
                "direction": direction,
                "entry_price": price,
                "size": size,
                "margin": margin_usdc,
                "leverage": leverage,
                "timestamp": int(time.time()),
            }

        try:
            if not self._exchange:
                return {"status": "error", "msg": "Live client not initialized"}

            price = entry_price or await self.get_price(symbol) or 0.0
            size = round((margin_usdc * leverage) / price, 6) if price > 0 else 0.0
            is_buy = direction.upper() == "LONG"

            order_result = self._exchange.order(
                symbol,
                is_buy,
                size,
                price,
                {"limit": {"tif": "Ioc"}},
            )
            return {
                "status": "ok",
                "paper": False,
                "symbol": symbol,
                "direction": direction,
                "entry_price": price,
                "size": size,
                "margin": margin_usdc,
                "leverage": leverage,
                "timestamp": int(time.time()),
                "raw": order_result,
            }
        except Exception as e:
            return {"status": "error", "msg": str(e)}

    async def close_position(self, symbol: str, direction: str, size: float) -> dict:
        if self._paper_mode:
            price = await self.get_price(symbol) or 0.0
            return {
                "status": "ok",
                "paper": True,
                "symbol": symbol,
                "close_price": price,
                "timestamp": int(time.time()),
            }

        try:
            if not self._exchange:
                return {"status": "error", "msg": "Live client not initialized"}

            is_buy = direction.upper() == "SHORT"
            price = await self.get_price(symbol) or 0.0
            order_result = self._exchange.order(
                symbol,
                is_buy,
                abs(size),
                price,
                {"limit": {"tif": "Ioc"}},
            )
            return {
                "status": "ok",
                "paper": False,
                "symbol": symbol,
                "close_price": price,
                "timestamp": int(time.time()),
                "raw": order_result,
            }
        except Exception as e:
            return {"status": "error", "msg": str(e)}

    async def get_position_pnl(self, symbol: str) -> Optional[float]:
        if self._paper_mode:
            return None
        positions = await self.get_open_positions()
        for p in positions:
            if p["symbol"] == symbol:
                return p["unrealized_pnl"]
        return None

    async def get_24h_change(self, symbol: str) -> Optional[float]:
        """Return 24h price change % using the most recent daily candle (close vs open)."""
        try:
            candles = await self.get_candles(symbol, "1d", 2)
            if not candles:
                return None
            candle = candles[-1]
            open_price  = candle.get("open",  0)
            close_price = candle.get("close", 0)
            if not open_price:
                return None
            return round((close_price - open_price) / open_price * 100, 2)
        except Exception as e:
            print(f"[HLClient] get_24h_change({symbol}) error: {e}")
            return None

    async def close(self):
        await self._http.aclose()
