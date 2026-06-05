import logging
import time
import asyncio
from typing import Optional
import numpy as np
import pandas as pd

from config import (
    PAIRS, TC_ADX_MIN, DEPTH_GATE_PCT,
    SL_PCT, TP1_R_MULTIPLIER, TP2_R_MULTIPLIER,
    LEVERAGE_TIER_HIGH, LEVERAGE_TIER_MID, LEVERAGE_TIER_LOW,
    COOLDOWN_SECONDS, CONSECUTIVE_LOSS_STOP,
    DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE,
    PAPER_MODE,
)
from hl_client import HLClient

logger = logging.getLogger("scanner")

# ── Module-level state ────────────────────────────────────────────────────────
_last_result:  dict[str, bool]  = {}   # key → last scan result (True/False)
_pending:      dict[str, dict]  = {}   # PENDING (first scan passed)
_confirmed_at: dict[str, float] = {}   # key → timestamp of ALERT confirmation
_cooldowns:    dict[str, float] = {}   # key → expiry timestamp

CONFIRMED_SHOW_SECONDS = 30  # show ALERT state in signal column for this long

logger.info(
    "[CONFIG] ADX=%d DEPTH=%d%% SL=%.1f%% TP1=%.1f%% TP2=%.1f%%"
    " COOLDOWN=%dmin CIRCUIT=%d LEVERAGE=%dx/%dx/%dx PAPER=%s CONDITIONS=4 NO_SCORING",
    TC_ADX_MIN, DEPTH_GATE_PCT,
    SL_PCT * 100, SL_PCT * TP1_R_MULTIPLIER * 100, SL_PCT * TP2_R_MULTIPLIER * 100,
    COOLDOWN_SECONDS // 60, CONSECUTIVE_LOSS_STOP,
    LEVERAGE_TIER_HIGH, LEVERAGE_TIER_MID, LEVERAGE_TIER_LOW, PAPER_MODE,
)


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


# ── 4-condition signal check ──────────────────────────────────────────────────

def check_tc_signal(
    direction: str,
    price: float,
    ma10: float, ma30: float, ma60: float,
    adx_1h: float,
    bid_pct: float, ask_pct: float,
) -> tuple[bool, dict]:
    """Check all four conditions. Returns (signal, conditions).

    C1 TREND  — price aligned with full MA stack direction.
    C2 ADX    — adx_1h >= TC_ADX_MIN.
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
    adx_pass = adx_1h >= TC_ADX_MIN
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
) -> dict:
    """Return best-direction 4-gate status for the pair table display."""
    best: dict = {
        "gates_direction": "NONE",
        "trend_pass": False, "adx_pass": False,
        "depth_pass": False, "ma_pass": False,
        "gates_passing": 0, "failing_gate": None,
    }
    for direction in ("LONG", "SHORT"):
        _, conds = check_tc_signal(direction, price, ma10, ma30, ma60, adx_1h, bid_pct, ask_pct)
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

def calc_sl_tp(entry_price: float, direction: str, symbol: str = "?") -> dict:
    sl_dist = entry_price * SL_PCT
    if direction == "LONG":
        sl_price  = entry_price - sl_dist
        tp1_price = entry_price + sl_dist * TP1_R_MULTIPLIER
        tp2_price = entry_price + sl_dist * TP2_R_MULTIPLIER
    else:
        sl_price  = entry_price + sl_dist
        tp1_price = entry_price - sl_dist * TP1_R_MULTIPLIER
        tp2_price = entry_price - sl_dist * TP2_R_MULTIPLIER
    sl_pct_val  = SL_PCT * 100
    tp1_pct_val = SL_PCT * TP1_R_MULTIPLIER * 100
    tp2_pct_val = SL_PCT * TP2_R_MULTIPLIER * 100
    logger.info(
        "[LEVELS] %s %s entry=%.4f sl=%.4f (%.1f%%) tp1=%.4f (%.1f%%) tp2=%.4f (%.1f%%)",
        symbol, direction, entry_price,
        sl_price, sl_pct_val, tp1_price, tp1_pct_val, tp2_price, tp2_pct_val,
    )
    return {
        "sl_price":    round(sl_price, 6),
        "sl_pct":      round(sl_pct_val, 2),
        "sl_distance": round(sl_dist, 8),
        "tp1_price":   round(tp1_price, 6),
        "tp2_price":   round(tp2_price, 6),
    }


# ── Dynamic leverage (ADX-based, no score) ────────────────────────────────────

def get_dynamic_leverage(adx: float) -> int:
    if adx >= 60:
        lev, tier = LEVERAGE_TIER_HIGH, "HIGH"
    elif adx >= 50:
        lev, tier = LEVERAGE_TIER_MID, "MID"
    else:
        lev, tier = LEVERAGE_TIER_LOW, "LOW"
    logger.info("[LEVERAGE] adx=%.1f tier=%s leverage=%dx", adx, tier, lev)
    return lev


# ── Per-pair scan ─────────────────────────────────────────────────────────────

async def scan_pair(symbol: str, client: HLClient) -> dict:
    try:
        candles_1h_raw, orderbook, price = await asyncio.gather(
            client.get_candles(symbol, "1h", 80),
            client.get_orderbook(symbol, 20),
            client.get_price(symbol),
        )
    except Exception as e:
        print(f"[scanner] Data fetch error for {symbol}: {e}")
        return {"symbol": symbol, "error": str(e)}

    if not candles_1h_raw or price is None:
        return {"symbol": symbol, "error": "Insufficient data"}

    df_1h = pd.DataFrame(candles_1h_raw)
    if len(df_1h) < 61:
        return {"symbol": symbol, "error": "Insufficient candles"}

    ma10, ma30, ma60   = get_ma_values(df_1h)
    adx_1h             = compute_adx(df_1h, 14)
    rsi_1h, _          = compute_rsi_1h_pair(df_1h)
    last_vol, vol_ma10 = compute_vol_1h(df_1h)
    j1h                = compute_j1h(df_1h)
    bid_pct, ask_pct   = compute_depth_pcts(orderbook)
    trend              = classify_trend(df_1h)

    vol_ratio   = round(last_vol / vol_ma10, 2) if vol_ma10 > 0 else 0.0
    j1h_clamped = round(max(0.0, min(100.0, j1h)), 1)

    alerts = []
    for direction in ("LONG", "SHORT"):
        key    = f"{symbol}{direction}"
        signal, conds = check_tc_signal(
            direction, price, ma10, ma30, ma60, adx_1h, bid_pct, ask_pct
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
            if last:
                # Second consecutive scan — fire confirmed alert
                _pending.pop(key, None)
                lev         = get_dynamic_leverage(adx_1h)
                sl_tp       = calc_sl_tp(price, direction, symbol)
                dollar_risk = round(DEFAULT_MARGIN_USDC * lev * SL_PCT, 2)
                alert_data  = {
                    "symbol":       symbol,
                    "direction":    direction,
                    "trend":        trend,
                    "adx":          round(adx_1h, 1),
                    "rsi_1h":       round(rsi_1h, 1),
                    "j1h":          j1h_clamped,
                    "volume_ratio": vol_ratio,
                    "entry_price":  price,
                    "margin":       DEFAULT_MARGIN_USDC,
                    "leverage":     lev,
                    "dollar_risk":  dollar_risk,
                    **sl_tp,
                    "fired_at":     int(time.time()),
                    "status":       "",
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

    return {
        "symbol":       symbol,
        "price":        price,
        "trend":        trend,
        "adx":          round(adx_1h, 1),
        "j5":           j1h_clamped,   # kept as j5 for JS compatibility
        "bid_pct":      round(bid_pct, 1),
        "ask_pct":      round(ask_pct, 1),
        "rsi_1h":       round(rsi_1h, 1),
        "vol_ratio":    vol_ratio,
        "ma10":         round(ma10, 4),
        "ma30":         round(ma30, 4),
        "ma60":         round(ma60, 4),
        "alerts":       alerts,
        "gates_status": compute_gates_status(
            price, ma10, ma30, ma60, adx_1h, bid_pct, ask_pct
        ),
        "scanned_at":   int(time.time()),
    }


async def run_full_scan(client: HLClient) -> tuple[list[dict], list[dict]]:
    results = []
    for i, sym in enumerate(PAIRS):
        if i > 0:
            await asyncio.sleep(0.5)
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
