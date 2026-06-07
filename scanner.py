import logging
import time
import asyncio
from datetime import datetime, timezone
from typing import Optional
import numpy as np
import pandas as pd

from config import (
    PAIRS, TC_ADX_MIN, DEPTH_GATE_PCT, PAIR_ADX_OVERRIDES,
    SL_PCT, SL_HALF_PCT, TP1_MULTIPLIER, TP2_MULTIPLIER, TP3_MULTIPLIER,
    LEVERAGE_TIER1, LEVERAGE_TIER2, LEVERAGE_TIER3,
    COOLDOWN_SECONDS, CONSECUTIVE_LOSS_STOP,
    MARGIN_PER_TRADE,
    PAPER_MODE,
    BTC_REGIME_FILTER_ENABLED,
)
from hl_client import HLClient

logger = logging.getLogger("scanner")

# ── Module-level state ────────────────────────────────────────────────────────
_last_result:     dict[str, bool]  = {}   # key → last scan result (True/False)
_pending:         dict[str, dict]  = {}   # PENDING (first scan passed)
_confirmed_at:    dict[str, float] = {}   # key → timestamp of ALERT confirmation
_cooldowns:       dict[str, float] = {}   # key → expiry timestamp
_btc_regime:      str              = "Neutral"  # updated each BTC scan
_last_known_good: dict[str, dict]  = {}   # symbol → last successful scan result
_candle_cache:    dict[str, dict]  = {}   # "{symbol}_1h" → {candles, hour, last_ts}

CONFIRMED_SHOW_SECONDS = 30  # show ALERT state in signal column for this long

_overrides_str = " ".join(f"{k}:{v}" for k, v in PAIR_ADX_OVERRIDES.items()) or "none"
logger.info(
    "[CONFIG] MARGIN=%d | SL=3%%(FIXED) | SL_HALF=0.6%% | TP=1.5R/2.5R/4.0R(HIGH)/2.5R(STRONG)/1.5R(REG)"
    " | COOLDOWN=60min | CIRCUIT_BREAKER=3 | DAILY_LOSS=-500 | LEVERAGE=%dx/%dx/%dx"
    " | WALLS=enabled | CANDLE_CACHE=1h | RATE_LIMIT=stagger_0.3s_backoff_2s"
    " | EXCHANGE=HL+MEXC | BTC_REGIME=on | ADX_OVERRIDES=%s | PAPER=%s",
    MARGIN_PER_TRADE,
    LEVERAGE_TIER1, LEVERAGE_TIER2, LEVERAGE_TIER3,
    _overrides_str, PAPER_MODE,
)


# ── BTC regime ────────────────────────────────────────────────────────────────

def get_btc_regime() -> str:
    """Return latest BTC trend regime — updated each time BTC is scanned."""
    return _btc_regime


# ── Cooldown helpers ──────────────────────────────────────────────────────────

def _in_cooldown(key: str) -> bool:
    return time.time() < _cooldowns.get(key, 0)


def _set_cooldown(key: str, reason: str = "UNKNOWN"):
    _cooldowns[key] = time.time() + COOLDOWN_SECONDS
    logger.info("[COOLDOWN] %s started reason=%s duration=%ds", key, reason, COOLDOWN_SECONDS)


# ── Signal-state helpers ──────────────────────────────────────────────────────

def get_pair_signal_info(symbol: str) -> dict:
    """Return scanner-level signal state.
    Priority: ALERT (recently confirmed) → PENDING (first scan passed) → SCANNING.
    """
    key_long  = f"{symbol}LONG"
    key_short = f"{symbol}SHORT"
    now = time.time()
    for key, direction in [(key_long, "LONG"), (key_short, "SHORT")]:
        if key in _confirmed_at and now - _confirmed_at[key] < CONFIRMED_SHOW_SECONDS:
            return {"signal_state": "ALERT", "direction": direction}
    for key, direction in [(key_long, "LONG"), (key_short, "SHORT")]:
        if key in _pending:
            return {"signal_state": "PENDING", "direction": direction}
    return {"signal_state": "SCANNING", "direction": None}


def get_pending() -> list[dict]:
    return list(_pending.values())


def get_cooldown_remaining(symbol: str, direction: str) -> int:
    expires = _cooldowns.get(f"{symbol}{direction}", 0)
    return max(0, int(expires - time.time()))


def set_close_cooldown(symbol: str, direction: str):
    key = f"{symbol}{direction}"
    _set_cooldown(key, reason="TRADE_CLOSE")
    _pending.pop(key, None)
    _last_result[key] = False
    _confirmed_at.pop(key, None)


def reset_scan_counter(symbol: str, direction: str):
    key = f"{symbol}{direction}"
    _last_result[key] = False
    _pending.pop(key, None)
    _confirmed_at.pop(key, None)
    logger.info("[RESET] %s %s scan counter reset", symbol, direction)


def clear_all_scanner_state():
    """Wipe all per-pair scan state — used by the log-clear endpoint."""
    _last_result.clear()
    _pending.clear()
    _confirmed_at.clear()
    _cooldowns.clear()
    logger.info("[CLEAR] all scanner state cleared (counters + cooldowns)")


# ── Pure-pandas indicator helpers ─────────────────────────────────────────────

def _wilder_smooth(series: pd.Series, period: int) -> pd.Series:
    result = np.full(len(series), np.nan)
    start  = series.first_valid_index()
    if start is None:
        return pd.Series(result, index=series.index)
    i0       = series.index.get_loc(start)
    seed_end = i0 + period
    if seed_end > len(series):
        return pd.Series(result, index=series.index)
    result[seed_end - 1] = series.iloc[i0:seed_end].mean()
    for i in range(seed_end, len(series)):
        result[i] = result[i - 1] * (1 - 1 / period) + series.iloc[i] * (1 / period)
    return pd.Series(result, index=series.index)


def compute_adx(df: pd.DataFrame, period: int = 14) -> float:
    if len(df) < period * 2 + 1:
        return 0.0
    high  = df["high"]
    low   = df["low"]
    close = df["close"]
    move_up   = high.diff()
    move_down = -low.diff()
    plus_dm  = pd.Series(
        np.where((move_up > move_down) & (move_up > 0), move_up, 0.0), index=df.index
    )
    minus_dm = pd.Series(
        np.where((move_down > move_up) & (move_down > 0), move_down, 0.0), index=df.index
    )
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr_s      = _wilder_smooth(tr.iloc[1:], period)
    plus_dm_s  = _wilder_smooth(plus_dm.iloc[1:], period)
    minus_dm_s = _wilder_smooth(minus_dm.iloc[1:], period)
    plus_di  = 100 * plus_dm_s  / atr_s.replace(0, np.nan)
    minus_di = 100 * minus_dm_s / atr_s.replace(0, np.nan)
    dx  = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = _wilder_smooth(dx.dropna(), period)
    if adx.empty or pd.isna(adx.iloc[-1]):
        return 0.0
    return float(adx.iloc[-1])


def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta    = series.diff()
    gain     = delta.clip(lower=0)
    loss     = (-delta).clip(lower=0)
    avg_gain = _wilder_smooth(gain.iloc[1:], period)
    avg_loss = _wilder_smooth(loss.iloc[1:], period)
    rs  = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def compute_stoch_kdj(
    df: pd.DataFrame,
    k_period: int = 9,
    d_period: int = 3,
    smooth_k: int = 3,
) -> tuple[float, float, float]:
    if len(df) < k_period + d_period + smooth_k:
        return 50.0, 50.0, 50.0
    low_min  = df["low"].rolling(k_period).min()
    high_max = df["high"].rolling(k_period).max()
    denom    = (high_max - low_min).replace(0, np.nan)
    raw_k    = 100 * (df["close"] - low_min) / denom
    smooth_k_series = raw_k.rolling(smooth_k).mean()
    d_series        = smooth_k_series.rolling(d_period).mean()
    k_val = float(smooth_k_series.iloc[-1]) if pd.notna(smooth_k_series.iloc[-1]) else 50.0
    d_val = float(d_series.iloc[-1])        if pd.notna(d_series.iloc[-1])        else 50.0
    k_val = max(0.0, min(100.0, k_val))
    d_val = max(0.0, min(100.0, d_val))
    j_val = 3 * k_val - 2 * d_val
    return k_val, d_val, j_val


# ── Trend classification ──────────────────────────────────────────────────────

def classify_trend(df_1h: pd.DataFrame) -> str:
    if len(df_1h) < 60:
        return "Neutral"
    close = df_1h["close"]
    ma10  = close.rolling(10).mean().iloc[-1]
    ma30  = close.rolling(30).mean().iloc[-1]
    ma60  = close.rolling(60).mean().iloc[-1]
    price = close.iloc[-1]
    if price > ma10 > ma30 > ma60:
        return "Strong Bull"
    elif price < ma10 < ma30 < ma60:
        return "Strong Bear"
    return "Neutral"


def get_trend_strength(adx: float, trend: str) -> str:
    """Return ADX-tiered trend strength label."""
    if trend == "Neutral":
        return "NEUTRAL"
    if adx >= 60:
        return "HIGH_PROB"
    elif adx >= 40:
        return "STRONG"
    elif adx >= 25:
        return "REGULAR"
    return "NEUTRAL"


def get_ma_values(df_1h: pd.DataFrame) -> tuple[float, float, float]:
    close = df_1h["close"]
    return (
        float(close.rolling(10).mean().iloc[-1]),
        float(close.rolling(30).mean().iloc[-1]),
        float(close.rolling(60).mean().iloc[-1]),
    )


# ── Indicator extractions ─────────────────────────────────────────────────────

def compute_rsi_1h_pair(df_1h: pd.DataFrame) -> tuple[float, float]:
    if len(df_1h) < 16:
        return 50.0, 50.0
    rsi_s = compute_rsi(df_1h["close"], 14).dropna()
    if len(rsi_s) < 2:
        return 50.0, 50.0
    return float(rsi_s.iloc[-1]), float(rsi_s.iloc[-2])


def compute_j1h(df_1h: pd.DataFrame) -> float:
    _, _, j = compute_stoch_kdj(df_1h, k_period=9, d_period=3, smooth_k=3)
    return j


def compute_vol_1h(df_1h: pd.DataFrame) -> tuple[float, float]:
    if len(df_1h) < 11:
        return 0.0, 0.0
    vol = df_1h["volume"]
    ma  = vol.rolling(10).mean()
    return float(vol.iloc[-1]), float(ma.iloc[-1])


# ── Orderbook depth ───────────────────────────────────────────────────────────

def compute_depth_pcts(orderbook: dict) -> tuple[float, float]:
    bids      = orderbook.get("bids", [])
    asks      = orderbook.get("asks", [])
    bid_total = sum(b["sz"] for b in bids)
    ask_total = sum(a["sz"] for a in asks)
    total     = bid_total + ask_total
    if total == 0:
        return 50.0, 50.0
    return bid_total / total * 100, ask_total / total * 100


# ── Wall detection ────────────────────────────────────────────────────────────

def compute_walls(orderbook: dict, current_price: float, symbol: str = "?") -> dict:
    """Find the largest single price level within 2% of current price on each side."""
    if current_price <= 0:
        return {"bid_wall": None, "ask_wall": None}
    pct_range = current_price * 0.02

    bid_wall_price: Optional[float] = None
    bid_wall_sz = 0.0
    for b in orderbook.get("bids", []):
        px, sz = b.get("px", 0.0), b.get("sz", 0.0)
        if px > 0 and (current_price - px) <= pct_range and sz > bid_wall_sz:
            bid_wall_sz  = sz
            bid_wall_price = px

    ask_wall_price: Optional[float] = None
    ask_wall_sz = 0.0
    for a in orderbook.get("asks", []):
        px, sz = a.get("px", 0.0), a.get("sz", 0.0)
        if px > 0 and (px - current_price) <= pct_range and sz > ask_wall_sz:
            ask_wall_sz  = sz
            ask_wall_price = px

    if bid_wall_price is not None or ask_wall_price is not None:
        logger.info(
            "[WALL] %s bid_wall=%s ask_wall=%s",
            symbol,
            f"{bid_wall_price:.4f}" if bid_wall_price else "None",
            f"{ask_wall_price:.4f}" if ask_wall_price else "None",
        )
    return {"bid_wall": bid_wall_price, "ask_wall": ask_wall_price}


# ── 4-condition signal check ──────────────────────────────────────────────────

def check_tc_signal(
    direction: str,
    price: float,
    ma10: float, ma30: float, ma60: float,
    adx_1h: float,
    bid_pct: float, ask_pct: float,
    adx_min: int = TC_ADX_MIN,
) -> tuple[bool, dict]:
    """Check all four conditions. Returns (signal, conditions).

    C1 TREND  — price aligned with full MA stack direction.
    C2 ADX    — adx_1h >= adx_min (global TC_ADX_MIN or per-pair override).
    C3 DEPTH  — orderbook depth >= DEPTH_GATE_PCT on the correct side.
    C4 MA     — MA10/MA30/MA60 strictly stacked (implied by C1, shown separately).
    """
    if direction == "LONG":
        trend_pass = bool(price > ma10 > ma30 > ma60)
        ma_pass    = bool(ma10 > ma30 > ma60)
        depth_pass = bid_pct >= DEPTH_GATE_PCT
    else:
        trend_pass = bool(price < ma10 < ma30 < ma60)
        ma_pass    = bool(ma10 < ma30 < ma60)
        depth_pass = ask_pct >= DEPTH_GATE_PCT
    adx_pass = adx_1h >= adx_min
    signal   = trend_pass and adx_pass and depth_pass  # ma_pass implied by trend_pass
    return signal, {
        "trend_pass": trend_pass,
        "adx_pass":   adx_pass,
        "depth_pass": depth_pass,
        "ma_pass":    ma_pass,
    }


# ── Gate status (4-dot display) ───────────────────────────────────────────────

def compute_gates_status(
    price: float,
    ma10: float, ma30: float, ma60: float,
    adx_1h: float,
    bid_pct: float, ask_pct: float,
    adx_min: int = TC_ADX_MIN,
) -> dict:
    """Return best-direction 4-gate status for the pair table display."""
    best: dict = {
        "gates_direction": "NONE",
        "trend_pass": False, "adx_pass": False,
        "depth_pass": False, "ma_pass": False,
        "gates_passing": 0, "failing_gate": None,
    }
    for direction in ("LONG", "SHORT"):
        _, conds = check_tc_signal(direction, price, ma10, ma30, ma60, adx_1h, bid_pct, ask_pct, adx_min)
        n = sum([conds["trend_pass"], conds["adx_pass"], conds["depth_pass"], conds["ma_pass"]])

        failing: Optional[str] = None
        if n == 3:
            for name, v in [
                ("TREND", conds["trend_pass"]),
                ("ADX",   conds["adx_pass"]),
                ("DEPTH", conds["depth_pass"]),
                ("MA",    conds["ma_pass"]),
            ]:
                if not v:
                    failing = name
                    break

        is_trend_aligned   = conds["trend_pass"]
        best_trend_aligned = best.get("trend_pass", False)

        if (n > best["gates_passing"] or
                (n == best["gates_passing"] and is_trend_aligned and not best_trend_aligned)):
            best = {
                "gates_direction": direction,
                "trend_pass":  conds["trend_pass"],
                "adx_pass":    conds["adx_pass"],
                "depth_pass":  conds["depth_pass"],
                "ma_pass":     conds["ma_pass"],
                "gates_passing": n,
                "failing_gate":  failing,
            }
    return best


# ── Fixed SL / TP ─────────────────────────────────────────────────────────────

def calc_sl_tp(entry_price: float, direction: str, trend_strength: str = "REGULAR", symbol: str = "?") -> dict:
    sl_dist  = entry_price * SL_PCT
    sl_half  = entry_price * SL_HALF_PCT
    if direction == "LONG":
        sl_price      = entry_price - sl_dist
        sl_half_price = entry_price - sl_half
        tp1_price     = entry_price + sl_dist * TP1_MULTIPLIER
        tp2_price     = entry_price + sl_dist * TP2_MULTIPLIER
        tp3_price     = entry_price + sl_dist * TP3_MULTIPLIER
    else:
        sl_price      = entry_price + sl_dist
        sl_half_price = entry_price + sl_half
        tp1_price     = entry_price - sl_dist * TP1_MULTIPLIER
        tp2_price     = entry_price - sl_dist * TP2_MULTIPLIER
        tp3_price     = entry_price - sl_dist * TP3_MULTIPLIER
    sl_pct_val = SL_PCT * 100
    tp_info = "TP1+TP2+TP3" if trend_strength == "HIGH_PROB" else ("TP1+TP2" if trend_strength == "STRONG" else "TP1")
    logger.info(
        "[LEVELS] %s %s %s entry=%.4f sl=%.4f (%.1f%%) sl_half=%.4f tp1=%.4f tp2=%.4f tp3=%.4f",
        symbol, direction, tp_info, entry_price,
        sl_price, sl_pct_val, sl_half_price, tp1_price, tp2_price, tp3_price,
    )
    result = {
        "sl_price":      round(sl_price, 6),
        "sl_half_price": round(sl_half_price, 6),
        "sl_pct":        round(sl_pct_val, 2),
        "sl_distance":   round(sl_dist, 8),
        "tp1_price":     round(tp1_price, 6),
    }
    if trend_strength in ("HIGH_PROB", "STRONG"):
        result["tp2_price"] = round(tp2_price, 6)
    if trend_strength == "HIGH_PROB":
        result["tp3_price"] = round(tp3_price, 6)
    return result


# ── Dynamic leverage (ADX-based) ──────────────────────────────────────────────

def get_dynamic_leverage(adx: float, symbol: str = "?", direction: str = "?") -> int:
    if adx >= 60:
        lev, tier = LEVERAGE_TIER3, 3
    elif adx >= 50:
        lev, tier = LEVERAGE_TIER2, 2
    else:
        lev, tier = LEVERAGE_TIER1, 1
    logger.info(
        "[LEVERAGE] %s %s adx=%.1f tier=%d leverage=%dx",
        symbol, direction, adx, tier, lev,
    )
    return lev


# ── Per-pair scan ─────────────────────────────────────────────────────────────

async def scan_pair(symbol: str, client: HLClient) -> dict:
    global _btc_regime

    try:
        # 1h candle cache — skip network fetch if candle hour unchanged
        cache_key = f"{symbol}_1h"
        cached_1h = _candle_cache.get(cache_key)
        now_hour  = int(time.time()) // 3600

        if cached_1h and cached_1h.get("hour") == now_hour:
            logger.info("[CACHE] %s 1h candles unchanged using cached data", symbol)
            candles_1h_raw = cached_1h["candles"]
            orderbook, price, change_24h = await asyncio.gather(
                client.get_orderbook(symbol, 20),
                client.get_price(symbol),
                client.get_24h_change(symbol),
            )
        else:
            candles_1h_raw, orderbook, price, change_24h = await asyncio.gather(
                client.get_candles(symbol, "1h", 80),
                client.get_orderbook(symbol, 20),
                client.get_price(symbol),
                client.get_24h_change(symbol),
            )
            if candles_1h_raw:
                _candle_cache[cache_key] = {
                    "candles": candles_1h_raw,
                    "hour":    now_hour,
                    "last_ts": candles_1h_raw[-1]["time"],
                }
    except Exception as e:
        print(f"[scanner] Data fetch error for {symbol}: {e}")
        lkg = _last_known_good.get(symbol)
        if lkg:
            logger.info("[STALE DATA] %s using last known good from previous scan", symbol)
            stale = dict(lkg)
            stale["data_stale"] = True
            return stale
        return {"symbol": symbol, "error": str(e), "data_stale": True}

    if not candles_1h_raw or price is None:
        lkg = _last_known_good.get(symbol)
        if lkg:
            logger.info("[STALE DATA] %s null price/candles using last known good", symbol)
            stale = dict(lkg)
            stale["data_stale"] = True
            return stale
        return {"symbol": symbol, "error": "Insufficient data", "data_stale": True}

    df_1h = pd.DataFrame(candles_1h_raw)
    if len(df_1h) < 61:
        lkg = _last_known_good.get(symbol)
        if lkg:
            logger.info("[STALE DATA] %s insufficient candles using last known good", symbol)
            stale = dict(lkg)
            stale["data_stale"] = True
            return stale
        return {"symbol": symbol, "error": "Insufficient candles", "data_stale": True}

    ma10, ma30, ma60   = get_ma_values(df_1h)
    adx_1h             = compute_adx(df_1h, 14)
    rsi_1h, _          = compute_rsi_1h_pair(df_1h)
    last_vol, vol_ma10 = compute_vol_1h(df_1h)
    j1h                = compute_j1h(df_1h)
    bid_pct, ask_pct   = compute_depth_pcts(orderbook)
    trend              = classify_trend(df_1h)

    vol_ratio   = round(last_vol / vol_ma10, 2) if vol_ma10 > 0 else 0.0
    j1h_clamped = round(max(0.0, min(100.0, j1h)), 1)

    # Update BTC regime for use by subsequent pair scans
    if symbol == "BTC":
        _btc_regime = trend
        logger.info("[REGIME] BTC trend updated: %s", _btc_regime)

    # Per-pair ADX floor override
    adx_min = PAIR_ADX_OVERRIDES.get(symbol, TC_ADX_MIN)
    if adx_min != TC_ADX_MIN:
        logger.info(
            "[ADX OVERRIDE] %s minimum ADX=%d (global=%d)", symbol, adx_min, TC_ADX_MIN
        )

    # Trend strength determined once, used by alert data and calc_sl_tp
    trend_strength = get_trend_strength(adx_1h, trend)

    alerts = []
    for direction in ("LONG", "SHORT"):
        key    = f"{symbol}{direction}"
        signal, conds = check_tc_signal(
            direction, price, ma10, ma30, ma60, adx_1h, bid_pct, ask_pct, adx_min
        )

        depth_val = ask_pct if direction == "SHORT" else bid_pct
        logger.info(
            "[SCAN] %s %s trend=%s adx=%.1f %s depth=%.1f %s ma=%s signal=%s",
            symbol, direction,
            "PASS" if conds["trend_pass"] else "FAIL",
            adx_1h, "PASS" if conds["adx_pass"] else "FAIL",
            depth_val, "PASS" if conds["depth_pass"] else "FAIL",
            "PASS" if conds["ma_pass"] else "FAIL",
            "TRUE" if signal else "FALSE",
        )

        last = _last_result.get(key, False)

        if signal and not _in_cooldown(key):
            # ── BTC regime filter ─────────────────────────────────────────────
            if BTC_REGIME_FILTER_ENABLED and symbol != "BTC":
                regime = _btc_regime
                if regime == "Neutral":
                    logger.info(
                        "[REGIME] BTC=Neutral blocking %s %s signal", symbol, direction
                    )
                    _last_result[key] = False
                    _pending.pop(key, None)
                    continue
                if regime == "Strong Bear" and direction == "LONG":
                    logger.info(
                        "[REGIME] BTC=StrongBear blocking %s LONG signal", symbol
                    )
                    _last_result[key] = False
                    _pending.pop(key, None)
                    continue
                if regime == "Strong Bull" and direction == "SHORT":
                    logger.info(
                        "[REGIME] BTC=StrongBull blocking %s SHORT signal", symbol
                    )
                    _last_result[key] = False
                    _pending.pop(key, None)
                    continue

            if last:
                # Second consecutive scan — fire confirmed alert
                _pending.pop(key, None)
                lev         = get_dynamic_leverage(adx_1h, symbol, direction)
                sl_tp       = calc_sl_tp(price, direction, trend_strength, symbol)
                dollar_risk = round(MARGIN_PER_TRADE * lev * SL_PCT, 2)
                alert_data  = {
                    "symbol":         symbol,
                    "direction":      direction,
                    "trend":          trend,
                    "trend_strength": trend_strength,
                    "adx":            round(adx_1h, 1),
                    "rsi_1h":         round(rsi_1h, 1),
                    "j1h":            j1h_clamped,
                    "volume_ratio":   vol_ratio,
                    "entry_price":    price,
                    "margin":         MARGIN_PER_TRADE,
                    "leverage":       lev,
                    "dollar_risk":    dollar_risk,
                    "score":          4,
                    **sl_tp,
                    "fired_at":       int(time.time()),
                    "status":         "",
                }
                alerts.append(alert_data)
                _confirmed_at[key] = time.time()
                _last_result[key]  = False  # reset so next scan starts fresh
                logger.info(
                    "[ALERT] %s %s CONFIRMED consecutive=2 adx=%.1f lev=%dx",
                    symbol, direction, adx_1h, lev,
                )
            else:
                # First qualifying scan — PENDING
                _pending[key] = {
                    "symbol":     symbol,
                    "direction":  direction,
                    "trend":      trend,
                    "adx":        round(adx_1h, 1),
                    "rsi_1h":     round(rsi_1h, 1),
                    "first_seen": int(time.time()),
                }
                _last_result[key] = True
                logger.info("[STATE] %s %s consecutive=1 state=PENDING", symbol, direction)
        else:
            _last_result[key] = False
            _pending.pop(key, None)

    walls = compute_walls(orderbook, price, symbol)

    result = {
        "symbol":         symbol,
        "price":          price,
        "trend":          trend,
        "trend_strength": trend_strength,
        "adx":            round(adx_1h, 1),
        "j5":             j1h_clamped,   # kept as j5 for JS compatibility
        "bid_pct":        round(bid_pct, 1),
        "ask_pct":        round(ask_pct, 1),
        "bid_wall":       walls["bid_wall"],
        "ask_wall":       walls["ask_wall"],
        "change_24h":     change_24h,
        "rsi_1h":         round(rsi_1h, 1),
        "vol_ratio":      vol_ratio,
        "ma10":           round(ma10, 4),
        "ma30":           round(ma30, 4),
        "ma60":           round(ma60, 4),
        "alerts":         alerts,
        "gates_status":   compute_gates_status(
            price, ma10, ma30, ma60, adx_1h, bid_pct, ask_pct, adx_min
        ),
        "scanned_at":     int(time.time()),
    }
    _last_known_good[symbol] = result
    return result


async def run_full_scan(client: HLClient) -> tuple[list[dict], list[dict]]:
    """Returns (pair_states, new_alerts). Scans all pairs unconditionally."""
    results = []
    for i, sym in enumerate(PAIRS):
        if i > 0:
            await asyncio.sleep(0.3)
        try:
            result = await scan_pair(sym, client)
        except Exception as e:
            result = e
        results.append(result)

    pair_states, new_alerts = [], []
    for result in results:
        if isinstance(result, Exception):
            print(f"[scanner] Exception: {result}")
            continue
        pair_states.append(result)
        new_alerts.extend(result.get("alerts", []))

    return pair_states, new_alerts
