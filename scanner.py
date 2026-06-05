import logging
import time
import asyncio
from typing import Optional
import numpy as np
import pandas as pd

# ── Startup: validate pandas-ta availability ──────────────────────────────────
try:
    import pandas_ta as _pta
    logging.getLogger("scanner").info(
        "[STARTUP] pandas-ta version %s loaded", getattr(_pta, "__version__", "unknown")
    )
except ImportError:
    logging.getLogger("scanner").critical(
        "[STARTUP CRITICAL] pandas-ta not available — indicator calculations will fail"
    )

from config import (
    PAIRS, ALERT_THRESHOLD, TC_MIN_SCORE, TC_ADX_MIN,
    DEPTH_GATE_PCT,
    SCAN_INTERVAL_SECONDS,
    SL_PCT, TP1_R_MULTIPLIER, TP2_R_MULTIPLIER,
    ENTRY_PULLBACK_RSI_SHORT, ENTRY_PULLBACK_RSI_LONG, ENTRY_TIMEOUT_MINUTES,
    LEVERAGE_TIER_HIGH, LEVERAGE_TIER_MID, LEVERAGE_TIER_LOW,
    COOLDOWN_SECONDS,
    CONSECUTIVE_LOSS_STOP, TRAILING_TP_PCT,
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE,
    PAPER_MODE,
    PROMOTED_SLOTS, ROTATION_WINDOW_MINUTES,
    UNIVERSE_SCAN_ENABLED,
    UNIVERSE_VOLUME_MIN_USD, UNIVERSE_OI_MIN_USD,
    UNIVERSE_FUNDING_MIN_ABS, UNIVERSE_VOLUME_FALLBACK_MULTIPLIER,
)
from hl_client import HLClient

logger = logging.getLogger("scanner")

# ── Consecutive-scan confirmation state ──────────────────────────────────────
_prev_scores: dict[str, int] = {}
_cooldowns:   dict[str, float] = {}
_pending:     dict[str, dict] = {}
_confirmed_at: dict[str, float] = {}
CONFIRMED_SHOW_SECONDS = 30

# ── Phase-2 entry timing state ────────────────────────────────────────────────
_awaiting_entry:  dict[str, dict] = {}     # key → alert data (shown in UI)
_entry_queue:     list[dict]      = []      # fired alerts ready for auto-open
_entry_tasks:     dict[str, asyncio.Task] = {}
_hl_client_ref:   Optional[HLClient] = None  # set in run_full_scan

# ── Universe scanner state ────────────────────────────────────────────────────
_promoted_pairs: dict[str, dict] = {}
_universe_state: dict = {
    "last_scan_at": None,
    "total_pairs_scanned": 0,
    "pairs_surviving_filter": 0,
    "last_candidates": [],
}

logger.info(
    "[CONFIG] ALERT_THRESHOLD=%s | TC_MIN=%s | ADX_MIN=%s | DEPTH=%s%%"
    " | J_GATE=removed_display_only | SCORING=3of4_real_criteria"
    " | TIMEFRAME=1h_signal/5m_entry | SL=%.1f%%_FIXED | COOLDOWN=%smin"
    " | CIRCUIT_BREAKER=%s_losses | TRAILING_TP=%.2f%%"
    " | LEVERAGE=%sx(4/4+ADX60)/%sx(3/4+ADX50)/%sx(default) | PAPER=%s",
    ALERT_THRESHOLD, TC_MIN_SCORE, TC_ADX_MIN, DEPTH_GATE_PCT,
    SL_PCT * 100, COOLDOWN_SECONDS // 60,
    CONSECUTIVE_LOSS_STOP, TRAILING_TP_PCT * 100,
    LEVERAGE_TIER_HIGH, LEVERAGE_TIER_MID, LEVERAGE_TIER_LOW, PAPER_MODE,
)
logger.info(
    "[CONFIG] TC_ADX_MIN=%d confirmed | TC_MIN_SCORE=%d | DEPTH_GATE_PCT=%d"
    " | depth_score_threshold_fixed=DEPTH_GATE_PCT (was hardcoded 55)",
    TC_ADX_MIN, TC_MIN_SCORE, DEPTH_GATE_PCT,
)
logger.info("[CONFIG] TC_MIN_SCORE=%d ALERT_THRESHOLD=%d MAX_SCORE=4 confirmed | score_cap=enforced", TC_MIN_SCORE, ALERT_THRESHOLD)


# ── Cooldown helpers ──────────────────────────────────────────────────────────

def _in_cooldown(key: str) -> bool:
    return time.time() < _cooldowns.get(key, 0)


def _set_cooldown(key: str, reason: str = "UNKNOWN"):
    _cooldowns[key] = time.time() + COOLDOWN_SECONDS
    logger.info("[COOLDOWN] %s cooldown started — reason=%s duration=%ss",
                key, reason, COOLDOWN_SECONDS)


def _get_signal_state(symbol: str) -> str:
    now = time.time()
    key_long  = f"{symbol}LONG"
    key_short = f"{symbol}SHORT"
    if key_long in _awaiting_entry or key_short in _awaiting_entry:
        return "awaiting_entry"
    for key in (key_long, key_short):
        if key in _pending:
            return "pending"
        if key in _confirmed_at and now - _confirmed_at[key] < CONFIRMED_SHOW_SECONDS:
            return "confirmed"
    return "none"


def get_pair_signal_info(symbol: str) -> dict:
    """Return enriched scanner-level signal state for the Signal column.

    Priority: AWAITING_ENTRY → QUALIFYING → SCANNING.
    PAUSED / IN_TRADE / COOLDOWN are layered on top in main.py serialise().
    """
    key_long  = f"{symbol}LONG"
    key_short = f"{symbol}SHORT"

    for key, direction in [(key_long, "LONG"), (key_short, "SHORT")]:
        if key in _awaiting_entry:
            ae = _awaiting_entry[key]
            return {
                "signal_state": "AWAITING_ENTRY",
                "direction":    direction,
                "rsi_5m":       ae.get("rsi_5m_current"),
                "rsi_thresh":   ae.get("entry_rsi_threshold"),
            }

    for key, direction in [(key_long, "LONG"), (key_short, "SHORT")]:
        if key in _pending:
            return {
                "signal_state": "QUALIFYING",
                "direction":    direction,
                "rsi_5m":       None,
                "rsi_thresh":   None,
            }

    return {"signal_state": "SCANNING", "direction": None, "rsi_5m": None, "rsi_thresh": None}


def get_pending() -> list[dict]:
    return list(_pending.values())


def get_awaiting_entry() -> list[dict]:
    return list(_awaiting_entry.values())


def drain_entry_queue() -> list[dict]:
    fired, _entry_queue[:] = list(_entry_queue), []
    return fired


def get_cooldown_remaining(symbol: str, direction: str) -> int:
    expires = _cooldowns.get(f"{symbol}{direction}", 0)
    return max(0, int(expires - time.time()))


def set_close_cooldown(symbol: str, direction: str):
    key = f"{symbol}{direction}"
    _set_cooldown(key, reason="TRADE_CLOSE")
    # Cancel any pending entry task for this pair
    task = _entry_tasks.pop(key, None)
    if task and not task.done():
        task.cancel()
    _awaiting_entry.pop(key, None)


def reset_scan_counter(symbol: str, direction: str):
    key = f"{symbol}{direction}"
    _prev_scores[key] = 0
    _pending.pop(key, None)
    logger.info("[RESET] %s %s scan counter reset on trade close", symbol, direction)


def get_promoted_pairs() -> list[dict]:
    return list(_promoted_pairs.values())


def get_universe_state() -> dict:
    return dict(_universe_state)


# ── Pure-pandas indicator helpers ─────────────────────────────────────────────

def _wilder_smooth(series: pd.Series, period: int) -> pd.Series:
    result = np.full(len(series), np.nan)
    start = series.first_valid_index()
    if start is None:
        return pd.Series(result, index=series.index)
    i0 = series.index.get_loc(start)
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

    plus_dm  = pd.Series(np.where((move_up > move_down) & (move_up > 0), move_up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((move_down > move_up) & (move_down > 0), move_down, 0.0), index=df.index)

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


def compute_stoch_kdj(df: pd.DataFrame, k_period: int = 9, d_period: int = 3, smooth_k: int = 3) -> tuple[float, float, float]:
    if len(df) < k_period + d_period + smooth_k:
        return 50.0, 50.0, 50.0
    low_min  = df["low"].rolling(k_period).min()
    high_max = df["high"].rolling(k_period).max()
    denom    = (high_max - low_min).replace(0, np.nan)
    raw_k    = 100 * (df["close"] - low_min) / denom
    smooth_k_series = raw_k.rolling(smooth_k).mean()
    d_series = smooth_k_series.rolling(d_period).mean()
    k_val = max(0.0, min(100.0, float(smooth_k_series.iloc[-1]))) if pd.notna(smooth_k_series.iloc[-1]) else 50.0
    d_val = max(0.0, min(100.0, float(d_series.iloc[-1])))        if pd.notna(d_series.iloc[-1])       else 50.0
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


# ── 1h indicator extractions (used for scoring) ───────────────────────────────

def compute_rsi_1h_pair(df_1h: pd.DataFrame) -> tuple[float, float]:
    """Returns (rsi_current, rsi_prev) from 1h candles."""
    if len(df_1h) < 16:
        return 50.0, 50.0
    rsi_s = compute_rsi(df_1h["close"], 14).dropna()
    if len(rsi_s) < 2:
        return 50.0, 50.0
    return float(rsi_s.iloc[-1]), float(rsi_s.iloc[-2])


def compute_j1h(df_1h: pd.DataFrame) -> float:
    """KDJ J value from 1h OHLCV."""
    _, _, j = compute_stoch_kdj(df_1h, k_period=9, d_period=3, smooth_k=3)
    return j


def compute_vol_1h(df_1h: pd.DataFrame) -> tuple[float, float]:
    """(last_vol, vol_ma10) from 1h candles."""
    if len(df_1h) < 11:
        return 0.0, 0.0
    vol = df_1h["volume"]
    ma  = vol.rolling(10).mean()
    return float(vol.iloc[-1]), float(ma.iloc[-1])


# ── 5m RSI (entry-timing only — NOT used for scoring) ────────────────────────

def compute_rsi_5m_entry(candles_5m: list) -> Optional[float]:
    """Compute 5m RSI from raw candles list. Returns None on insufficient data."""
    if len(candles_5m) < 16:
        return None
    df   = pd.DataFrame(candles_5m)
    rsi_s = compute_rsi(df["close"], 14).dropna()
    if rsi_s.empty:
        return None
    return float(rsi_s.iloc[-1])


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


# ── Null / invalid data guard ─────────────────────────────────────────────────

def validate_market_data(symbol: str, direction: str, data: dict) -> bool:
    """Returns True if all required fields are present and non-zero/NaN. Logs on failure."""
    required = [
        "current_price", "adx_1h", "rsi_1h", "rsi_1h_prev",
        "j1h", "bid_pct", "ask_pct", "ma10", "ma30", "ma60",
    ]
    for field in required:
        val = data.get(field)
        if val is None or (isinstance(val, float) and val != val) or val == 0.0:
            logger.warning("[DATA INVALID] %s %s field=%s value=%s scan skipped",
                           symbol, direction, field, val)
            return False
    return True


# ── Fixed SL / TP (replaces ATR-based) ───────────────────────────────────────

def calc_sl_tp(entry_price: float, direction: str, symbol: str = "?") -> dict:
    """Compute SL/TP from fixed SL_PCT.
    SL = SL_PCT (3%) from entry. TP1 = 1.5×, TP2 = 2.0× SL distance.
    dollar_risk = DEFAULT_MARGIN_USDC × leverage × SL_PCT  (computed at open time via leverage)."""
    sl_dist = entry_price * SL_PCT

    if direction == "LONG":
        sl_price  = entry_price - sl_dist
        tp1_price = entry_price + sl_dist * TP1_R_MULTIPLIER
        tp2_price = entry_price + sl_dist * TP2_R_MULTIPLIER
    else:
        sl_price  = entry_price + sl_dist
        tp1_price = entry_price - sl_dist * TP1_R_MULTIPLIER
        tp2_price = entry_price - sl_dist * TP2_R_MULTIPLIER

    sl_pct_val   = SL_PCT * 100
    tp1_pct_val  = SL_PCT * TP1_R_MULTIPLIER * 100
    tp2_pct_val  = SL_PCT * TP2_R_MULTIPLIER * 100

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


# ── Dynamic leverage ──────────────────────────────────────────────────────────

def get_dynamic_leverage(adx: float, score: int) -> int:
    if adx >= 60 and score == 4:
        lev  = LEVERAGE_TIER_HIGH
        tier = "HIGH"
    elif adx >= 50 and score >= 3:
        lev  = LEVERAGE_TIER_MID
        tier = "MID"
    else:
        lev  = LEVERAGE_TIER_LOW
        tier = "LOW"
    logger.info("[LEVERAGE] adx=%.1f score=%d/4 tier=%s leverage=%dx", adx, score, tier, lev)
    return lev


# ── Gate status (7-dot display) ───────────────────────────────────────────────

def compute_gates_status(
    trend: str, adx_1h: float,
    bid_pct: float, ask_pct: float,
    j1h: float,
    ma10: float = 0.0, ma30: float = 0.0, ma60: float = 0.0,
    rsi_1h: float = 50.0, rsi_1h_prev: float = 50.0,
    last_vol: float = 0.0, vol_ma10: float = 0.0,
) -> dict:
    """Evaluate all 7 gate/criteria states for BOTH LONG and SHORT (1h indicators).

    Hard gates (T A D J): TREND · ADX · DEPTH · J
    Soft criteria (MA RS VL): MA stack · RSI confluence · Volume spike

    Returns best direction (most hard gates passing).
    gates_passing = hard count (max 4). gates_total = all 7.
    """
    best: dict = {
        "gates_direction": "NONE",
        "trend_pass": False, "adx_pass": False, "depth_pass": False,
        "ma_pass": False, "rsi_pass": False, "rsi_partial": False, "vol_pass": False,
        "gates_passing": 0,
        "gates_total":   0,
        "failing_gate":  None,
    }

    for direction in ("LONG", "SHORT"):
        trend_pass = (trend == "Strong Bull") if direction == "LONG" else (trend == "Strong Bear")
        adx_pass   = adx_1h >= TC_ADX_MIN

        if direction == "LONG":
            depth_pass = bid_pct >= DEPTH_GATE_PCT
        else:
            depth_pass = ask_pct >= DEPTH_GATE_PCT

        gates_passing = int(trend_pass) + int(adx_pass) + int(depth_pass)

        # Soft criteria — P1 P2 P3 P4 (mirrors score_tc_long/short exactly)
        is_cap     = adx_1h >= 50
        vol_thresh = 1.2 if is_cap else 1.5
        if direction == "LONG":
            p1_pass = bool(ma10 and ma30 and ma60 and ma10 > ma30 > ma60)
            p2_pass = bool(rsi_1h > 60 and rsi_1h < rsi_1h_prev) if is_cap \
                      else bool(rsi_1h < 40 and rsi_1h > rsi_1h_prev)
            p3_pass = bool(rsi_1h > 50)
        else:
            p1_pass = bool(ma10 and ma30 and ma60 and ma10 < ma30 < ma60)
            p2_pass = bool(rsi_1h < 40 and rsi_1h > rsi_1h_prev) if is_cap \
                      else bool(rsi_1h > 60 and rsi_1h < rsi_1h_prev)
            p3_pass = bool(rsi_1h < 50)
        p4_pass = bool(vol_ma10 > 0 and last_vol > vol_thresh * vol_ma10)

        # Backward-compat aliases kept for any existing code still reading them
        ma_pass     = p1_pass
        rsi_pass    = p2_pass and p3_pass
        rsi_partial = (p2_pass or p3_pass) and not rsi_pass
        vol_pass    = p4_pass

        gates_total = gates_passing + int(p1_pass) + int(p2_pass) + int(p3_pass) + int(p4_pass)

        failing_gate: Optional[str] = None
        all_7 = [
            ("TREND", trend_pass), ("ADX", adx_pass), ("DEPTH", depth_pass),
            ("P1", p1_pass), ("P2", p2_pass), ("P3", p3_pass), ("P4", p4_pass),
        ]
        if gates_total == 6:   # one criterion away from perfect 7
            for name, passing in all_7:
                if not passing:
                    failing_gate = name
                    break
        elif gates_passing == 2:   # one hard gate failing
            for name, passing in all_7[:3]:
                if not passing:
                    failing_gate = name
                    break

        candidate = {
            "gates_direction": direction,
            "trend_pass":   trend_pass,  "adx_pass":   adx_pass,
            "depth_pass":   depth_pass,
            "p1_pass":      p1_pass,     "p2_pass":    p2_pass,
            "p3_pass":      p3_pass,     "p4_pass":    p4_pass,
            # backward-compat
            "ma_pass":      ma_pass,     "rsi_pass":   rsi_pass,
            "rsi_partial":  rsi_partial, "vol_pass":   vol_pass,
            "gates_passing": gates_passing,
            "gates_total":   gates_total,
            "failing_gate":  failing_gate,
        }

        is_trend_aligned = (
            (direction == "LONG"  and trend == "Strong Bull") or
            (direction == "SHORT" and trend == "Strong Bear")
        )
        best_aligned = (
            (best["gates_direction"] == "LONG"  and trend == "Strong Bull") or
            (best["gates_direction"] == "SHORT" and trend == "Strong Bear")
        )
        if (gates_passing > best["gates_passing"] or
                (gates_passing == best["gates_passing"] and is_trend_aligned and not best_aligned)):
            best = candidate

    return best


# ── Scoring (1h indicators only) ──────────────────────────────────────────────

def score_tc_long(
    symbol: str,
    current_price: float,
    trend: str, adx_1h: float,
    ma10: float, ma30: float, ma60: float,
    rsi_1h: float, rsi_1h_prev: float,
    last_vol: float, vol_ma10: float,
    bid_pct: float, j1h: float,
) -> int:
    data = {
        "current_price": current_price, "adx_1h": adx_1h,
        "rsi_1h": rsi_1h, "rsi_1h_prev": rsi_1h_prev,
        "j1h": j1h, "bid_pct": bid_pct,
        "ma10": ma10, "ma30": ma30, "ma60": ma60,
    }
    if not validate_market_data(symbol, "LONG", data):
        return 0

    if trend != "Strong Bull": return 0
    if adx_1h < TC_ADX_MIN:   return 0
    if bid_pct < DEPTH_GATE_PCT: return 0

    is_cap = adx_1h >= 50

    p1 = int(ma10 > ma30 > ma60)

    # P2 — tier-aware RSI momentum (all 1h)
    if is_cap:
        p2 = int(rsi_1h > 60 and rsi_1h < rsi_1h_prev)   # momentum pullback
    else:
        p2 = int(rsi_1h < 40 and rsi_1h > rsi_1h_prev)   # oversold bounce

    p3 = int(rsi_1h > 50)
    p4 = int(vol_ma10 > 0 and last_vol > (1.2 if is_cap else 1.5) * vol_ma10)

    score = p1 + p2 + p3 + p4
    if score > 4:
        logger.error("[SCORE ERROR] %s LONG score=%d exceeds maximum of 4 — check scoring logic", symbol, score)
    score = min(score, 4)

    if score < TC_MIN_SCORE:
        reasons = []
        if not p1: reasons.append("P1 ma not aligned bull")
        if not p2: reasons.append(
            f"P2 rsi_1h momentum not confirmed ({rsi_1h:.1f} prev={rsi_1h_prev:.1f})" if is_cap
            else f"P2 rsi_1h not rising from oversold ({rsi_1h:.1f} prev={rsi_1h_prev:.1f})"
        )
        if not p3: reasons.append("P3 rsi_1h below 50")
        if not p4: reasons.append("P4 volume not spiking")
        logger.info(
            "[SCORE DETAIL] %s LONG gates=PASS score=%d/4 P1=%d P2=%d P3=%d P4=%d reason=%s",
            symbol, score, p1, p2, p3, p4, " ".join(reasons),
        )

    return score


def score_tc_short(
    symbol: str,
    current_price: float,
    trend: str, adx_1h: float,
    ma10: float, ma30: float, ma60: float,
    rsi_1h: float, rsi_1h_prev: float,
    last_vol: float, vol_ma10: float,
    ask_pct: float, j1h: float,
) -> int:
    data = {
        "current_price": current_price, "adx_1h": adx_1h,
        "rsi_1h": rsi_1h, "rsi_1h_prev": rsi_1h_prev,
        "j1h": j1h, "ask_pct": ask_pct,
        "ma10": ma10, "ma30": ma30, "ma60": ma60,
    }
    if not validate_market_data(symbol, "SHORT", data):
        return 0

    if trend != "Strong Bear": return 0
    if adx_1h < TC_ADX_MIN:   return 0
    if ask_pct < DEPTH_GATE_PCT: return 0

    is_cap = adx_1h >= 50
    tier = "CAPITULATION" if is_cap else "STANDARD"

    p1 = int(ma10 < ma30 < ma60)

    # P2 — tier-aware RSI momentum (all 1h)
    if is_cap:
        p2 = int(rsi_1h < 40 and rsi_1h > rsi_1h_prev)   # exhaustion bounce
    else:
        p2 = int(rsi_1h > 60 and rsi_1h < rsi_1h_prev)   # declining from overbought

    p3 = int(rsi_1h < 50)
    p4 = int(vol_ma10 > 0 and last_vol > (1.2 if is_cap else 1.5) * vol_ma10)

    score = p1 + p2 + p3 + p4
    if score > 4:
        logger.error("[SCORE ERROR] %s SHORT score=%d exceeds maximum of 4 — check scoring logic", symbol, score)
    score = min(score, 4)

    vol_ratio = (last_vol / vol_ma10) if vol_ma10 > 0 else 0.0
    logger.info(
        "[TIER] %s SHORT tier=%s P2=%d rsi_1h=%.2f rsi_1h_prev=%.2f"
        " P4=%d vol=%.2fx MA10 threshold=%s",
        symbol, tier, p2, rsi_1h, rsi_1h_prev, p4, vol_ratio,
        "1.2x" if is_cap else "1.5x",
    )

    if score < TC_MIN_SCORE:
        reasons = []
        if not p1: reasons.append("P1 ma not aligned bear")
        if not p2: reasons.append(
            f"P2 rsi_1h momentum not confirmed ({rsi_1h:.1f} prev={rsi_1h_prev:.1f})" if is_cap
            else f"P2 rsi_1h not falling from overbought ({rsi_1h:.1f} prev={rsi_1h_prev:.1f})"
        )
        if not p3: reasons.append("P3 rsi_1h above 50")
        if not p4: reasons.append("P4 volume not spiking")
        logger.info(
            "[SCORE DETAIL] %s SHORT gates=PASS tier=%s score=%d/4"
            " P1=%d P2=%d P3=%d P4=%d reason=%s",
            symbol, tier, score, p1, p2, p3, p4, " ".join(reasons),
        )

    return score


# ── Phase-2: 5m entry timing ──────────────────────────────────────────────────

def _fire_entry(key: str, alert_data: dict, entry_price: Optional[float], entry_type: str):
    ae = _awaiting_entry.pop(key, None)
    _entry_tasks.pop(key, None)
    if ae is None:
        return
    ep = entry_price or alert_data.get("entry_price")
    if ep:
        # Recompute SL/TP at actual entry price
        sl_tp = calc_sl_tp(ep, alert_data["direction"], alert_data["symbol"])
        lev = alert_data.get("leverage", DEFAULT_LEVERAGE)
        dollar_risk = DEFAULT_MARGIN_USDC * lev * SL_PCT
        alert_data = {**alert_data, **sl_tp, "entry_price": ep,
                      "dollar_risk": round(dollar_risk, 2)}
    fired = {
        **alert_data,
        "entry_type":  entry_type,
        "fired_at":    int(time.time()),
        "status":      "entry_triggered",
    }
    _entry_queue.append(fired)
    logger.info("[ENTRY] %s %s type=%s entry_price=%s",
                alert_data["symbol"], alert_data["direction"], entry_type, ep)


async def _run_entry_timing(key: str, symbol: str, direction: str, alert_data: dict):
    threshold  = ENTRY_PULLBACK_RSI_SHORT if direction == "SHORT" else ENTRY_PULLBACK_RSI_LONG
    timeout_at = time.time() + ENTRY_TIMEOUT_MINUTES * 60
    crossed    = False

    logger.info("[ENTRY TIMING] %s %s started — threshold=%.0f timeout=%smin",
                symbol, direction, threshold, ENTRY_TIMEOUT_MINUTES)

    while time.time() < timeout_at:
        await asyncio.sleep(10)

        if key not in _awaiting_entry:
            return  # cancelled by trade close / cooldown

        client = _hl_client_ref
        if client is None:
            continue

        try:
            candles_5m = await client.get_candles(symbol, "5m", 20)
            rsi = compute_rsi_5m_entry(candles_5m)
            if rsi is None:
                continue
        except Exception as exc:
            logger.warning("[ENTRY TIMING] %s %s fetch error: %s", symbol, direction, exc)
            continue

        _awaiting_entry[key]["rsi_5m_current"]  = round(rsi, 1)
        _awaiting_entry[key]["time_remaining_s"] = max(0, int(timeout_at - time.time()))

        if direction == "SHORT":
            if not crossed and rsi > threshold:
                crossed = True
                logger.info("[ENTRY TIMING] %s SHORT rsi=%.1f crossed above %.0f — waiting for reversal",
                            symbol, rsi, threshold)
            elif crossed and rsi <= threshold:
                try:
                    ep = await client.get_price(symbol) if client else None
                except Exception:
                    ep = None
                logger.info("[ENTRY] %s SHORT type=PULLBACK 5m_rsi=%.1f crossed_below_%.0f entry_price=%s",
                            symbol, rsi, threshold, ep)
                _fire_entry(key, alert_data, ep, "PULLBACK")
                return
        else:
            if not crossed and rsi < threshold:
                crossed = True
                logger.info("[ENTRY TIMING] %s LONG rsi=%.1f crossed below %.0f — waiting for reversal",
                            symbol, rsi, threshold)
            elif crossed and rsi >= threshold:
                try:
                    ep = await client.get_price(symbol) if client else None
                except Exception:
                    ep = None
                logger.info("[ENTRY] %s LONG type=PULLBACK 5m_rsi=%.1f crossed_above_%.0f entry_price=%s",
                            symbol, rsi, threshold, ep)
                _fire_entry(key, alert_data, ep, "PULLBACK")
                return

    # Timeout — enter at market
    logger.info("[ENTRY TIMEOUT] %s %s no pullback entry found within %smin entering at market",
                symbol, direction, ENTRY_TIMEOUT_MINUTES)
    try:
        ep = await _hl_client_ref.get_price(symbol) if _hl_client_ref else None
    except Exception:
        ep = None
    _fire_entry(key, alert_data, ep, "TIMEOUT")


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

    trend             = classify_trend(df_1h)
    ma10, ma30, ma60  = get_ma_values(df_1h)
    adx_1h            = compute_adx(df_1h, 14)
    rsi_1h, rsi_1h_prev = compute_rsi_1h_pair(df_1h)
    last_vol, vol_ma10 = compute_vol_1h(df_1h)
    j1h               = compute_j1h(df_1h)
    bid_pct, ask_pct  = compute_depth_pcts(orderbook)

    long_score  = score_tc_long(
        symbol, price, trend, adx_1h, ma10, ma30, ma60,
        rsi_1h, rsi_1h_prev, last_vol, vol_ma10, bid_pct, j1h,
    )
    short_score = score_tc_short(
        symbol, price, trend, adx_1h, ma10, ma30, ma60,
        rsi_1h, rsi_1h_prev, last_vol, vol_ma10, ask_pct, j1h,
    )
    logger.info("[SCORE] %s LONG=%s SHORT=%s | trend=%s adx=%.1f j1h=%.1f bid=%.1f ask=%.1f rsi_1h=%.1f",
                symbol, long_score, short_score, trend, adx_1h, j1h, bid_pct, ask_pct, rsi_1h)

    alerts = []
    for direction, score in [("LONG", long_score), ("SHORT", short_score)]:
        key = f"{symbol}{direction}"
        if score >= TC_MIN_SCORE:
            prev = _prev_scores.get(key, 0)
            _t_log = (trend == "Strong Bull") if direction == "LONG" else (trend == "Strong Bear")
            _a_log = adx_1h >= TC_ADX_MIN
            _d_log = (bid_pct if direction == "LONG" else ask_pct) >= DEPTH_GATE_PCT
            _h_log = int(_t_log) + int(_a_log) + int(_d_log)
            _c_log = 2 if (prev >= TC_MIN_SCORE and not _in_cooldown(key)) else 1
            logger.info("[CONSECUTIVE] %s %s count=%d score=%d/4 gates=%d/3 prev_score=%d",
                        symbol, direction, _c_log, score, _h_log, prev)
            if prev >= TC_MIN_SCORE and not _in_cooldown(key):
                # Signal confirmed — move to Phase-2 AWAITING_ENTRY
                if key not in _awaiting_entry and key not in _entry_tasks:
                    lev = get_dynamic_leverage(adx_1h, score)
                    sl_tp = calc_sl_tp(price, direction, symbol)
                    dollar_risk = round(DEFAULT_MARGIN_USDC * lev * SL_PCT, 2)
                    alert_data = {
                        "symbol":      symbol,
                        "direction":   direction,
                        "score":       score,
                        "trend":       trend,
                        "adx":         round(adx_1h, 1),
                        "rsi_1h":      round(rsi_1h, 1),
                        "rsi_1h_prev": round(rsi_1h_prev, 1),
                        "entry_price": price,
                        "margin":      DEFAULT_MARGIN_USDC,
                        "leverage":    lev,
                        "dollar_risk": dollar_risk,
                        **sl_tp,
                        "confirmed_at":      int(time.time()),
                        "timeout_at":        int(time.time() + ENTRY_TIMEOUT_MINUTES * 60),
                        "status":            "awaiting_entry",
                        "rsi_5m_current":    None,
                        "time_remaining_s":  ENTRY_TIMEOUT_MINUTES * 60,
                        "entry_rsi_threshold": (ENTRY_PULLBACK_RSI_SHORT if direction == "SHORT"
                                                 else ENTRY_PULLBACK_RSI_LONG),
                    }
                    _awaiting_entry[key] = alert_data
                    task = asyncio.create_task(
                        _run_entry_timing(key, symbol, direction, alert_data)
                    )
                    _entry_tasks[key] = task
                    _confirmed_at[key] = time.time()
                    logger.info("[AWAIT ENTRY] %s %s score=%d — Phase 2 started",
                                symbol, direction, score)
                    # Emit display-only alert so UI shows AWAITING state
                    alerts.append({**_awaiting_entry[key]})
            else:
                _pending[key] = {
                    "symbol": symbol, "direction": direction, "score": score,
                    "trend": trend, "adx": round(adx_1h, 1),
                    "rsi_1h": round(rsi_1h, 1), "first_seen": int(time.time()),
                }
                if prev < TC_MIN_SCORE:
                    logger.info("[STATE] %s %s gates=%d score=%d consecutive=1 state=QUALIFYING",
                                symbol, direction, _h_log, score)
            _prev_scores[key] = score
        else:
            _prev_scores[key] = 0
            _pending.pop(key, None)

    # ZEC verbose debug — logs every scan regardless of score
    if symbol == "ZEC":
        _zec_t  = int(trend == "Strong Bear")
        _zec_a  = int(adx_1h >= TC_ADX_MIN)
        _zec_d  = int(ask_pct >= DEPTH_GATE_PCT)
        _zec_h  = _zec_t + _zec_a + _zec_d
        _zec_ps = _prev_scores.get("ZECSHORT", 0)
        _zec_pl = _prev_scores.get("ZECLONG", 0)
        _zec_sig = get_pair_signal_info("ZEC")["signal_state"]
        logger.info(
            "[ZEC DEBUG] gates=%d/3(T%d·A%d·D%d) score_long=%d score_short=%d/4"
            " prev_long=%d prev_short=%d signal_state=%s"
            " | adx=%.1f ask_pct=%.1f trend=%s",
            _zec_h, _zec_t, _zec_a, _zec_d,
            long_score, short_score, _zec_pl, _zec_ps, _zec_sig,
            adx_1h, ask_pct, trend,
        )

    j1h_clamped = round(max(0.0, min(100.0, j1h)), 1)
    return {
        "symbol":    symbol,
        "price":     price,
        "trend":     trend,
        "long_score":  long_score,
        "short_score": short_score,
        "adx":       round(adx_1h, 1),
        "j5":        j1h_clamped,  # field name kept as j5 for JS compatibility
        "bid_pct":   round(bid_pct, 1),
        "ask_pct":   round(ask_pct, 1),
        "rsi_1h":    round(rsi_1h, 1),
        "ma10":      round(ma10, 4),
        "ma30":      round(ma30, 4),
        "ma60":      round(ma60, 4),
        "alerts":    alerts,
        "signal_state": _get_signal_state(symbol),
        "gates_status": compute_gates_status(
            trend, adx_1h, bid_pct, ask_pct, j1h,
            ma10=ma10, ma30=ma30, ma60=ma60,
            rsi_1h=rsi_1h, rsi_1h_prev=rsi_1h_prev,
            last_vol=last_vol, vol_ma10=vol_ma10,
        ),
        "scanned_at": int(time.time()),
    }


async def run_universe_scan(client: HLClient, open_trade_symbols: set) -> None:
    """Universe scanner: fetch all HL perps, filter by volume/OI/funding, rank by
    ADX + trend + depth, fill promoted slots."""
    try:
        universe = await client.get_universe_metadata()
        if not universe:
            logger.warning("[UNIVERSE] metadata fetch returned empty — will retry next interval")
            return

        fixed_set    = set(PAIRS)
        promoted_set = set(_promoted_pairs.keys())
        _universe_state["total_pairs_scanned"] = len(universe)
        candidates = [p for p in universe
                      if p["symbol"] not in fixed_set and p["symbol"] not in promoted_set]

        vol_threshold = UNIVERSE_VOLUME_MIN_USD

        def _passes(p: dict, vol_min: float) -> bool:
            return (p["volume_24h_usd"] >= vol_min
                    and p["open_interest_usd"] >= UNIVERSE_OI_MIN_USD
                    and abs(p["funding_rate"]) >= UNIVERSE_FUNDING_MIN_ABS)

        filtered = [p for p in candidates if _passes(p, vol_threshold)]
        relaxed = False
        if len(filtered) < 5:
            vol_threshold *= UNIVERSE_VOLUME_FALLBACK_MULTIPLIER
            filtered = [p for p in candidates if _passes(p, vol_threshold)]
            relaxed = True

        _universe_state["pairs_surviving_filter"] = len(filtered)
        logger.info("[UNIVERSE] %d candidates after filter%s",
                    len(filtered), " (volume relaxed)" if relaxed else "")

        if not filtered:
            _universe_state["last_scan_at"] = int(time.time())
            return

        async def _score(p: dict) -> Optional[dict]:
            try:
                candles_1h, ob = await asyncio.gather(
                    client.get_candles(p["symbol"], "1h", 80),
                    client.get_orderbook(p["symbol"], 20),
                )
                if not candles_1h:
                    return None
                df_1h = pd.DataFrame(candles_1h)
                adx   = compute_adx(df_1h, 14)
                trend = classify_trend(df_1h)
                bid_pct, ask_pct = compute_depth_pcts(ob)
                sc = 0
                if adx >= 60:   sc += 3
                elif adx >= 40: sc += 2
                elif adx >= 30: sc += 1
                if trend in ("Strong Bull", "Strong Bear"):
                    sc += 2
                max_depth = max(bid_pct, ask_pct)
                if max_depth >= 65:   sc += 2
                elif max_depth >= 55: sc += 1
                return {**p, "universe_score": sc, "adx": round(adx, 1), "trend": trend}
            except Exception as exc:
                logger.debug("[UNIVERSE] _score %s error: %s", p["symbol"], exc)
                return None

        raw = await asyncio.gather(*[_score(p) for p in filtered], return_exceptions=True)
        scored = sorted(
            [r for r in raw if isinstance(r, dict)],
            key=lambda x: x["universe_score"],
            reverse=True,
        )
        _universe_state["last_candidates"] = [
            {"symbol": c["symbol"], "score": c["universe_score"]} for c in scored[:10]
        ]

        now = time.time()
        to_evict: list[tuple[str, int]] = []
        for sym, entry in _promoted_pairs.items():
            if sym in open_trade_symbols:
                continue
            if _in_cooldown(f"{sym}LONG") or _in_cooldown(f"{sym}SHORT"):
                continue
            if now > entry["rotation_expires_at"]:
                to_evict.append((sym, entry["slot_number"]))

        for sym, slot in to_evict:
            logger.info("[UNIVERSE] %s evicted from slot %d", sym, slot)
            del _promoted_pairs[sym]

        used_slots  = {e["slot_number"] for e in _promoted_pairs.values()}
        empty_slots = sorted(s for s in range(1, PROMOTED_SLOTS + 1) if s not in used_slots)
        now_promoted = set(_promoted_pairs.keys())

        for candidate in scored:
            if not empty_slots:
                break
            sym = candidate["symbol"]
            if sym in now_promoted or sym in fixed_set:
                continue
            slot = empty_slots.pop(0)
            _promoted_pairs[sym] = {
                "symbol": sym,
                "slot_number": slot,
                "promoted_at": int(now),
                "universe_score": candidate["universe_score"],
                "rotation_expires_at": int(now + ROTATION_WINDOW_MINUTES * 60),
                "has_active_trade": False,
            }
            now_promoted.add(sym)
            logger.info("[UNIVERSE] %s promoted to slot %d (score %d/7)",
                        sym, slot, candidate["universe_score"])

        _universe_state["last_scan_at"] = int(time.time())

    except Exception as exc:
        logger.error("[UNIVERSE] scan error: %s", exc)
        _universe_state["last_scan_at"] = int(time.time())


async def run_full_scan(client: HLClient) -> tuple[list[dict], list[dict]]:
    global _hl_client_ref
    _hl_client_ref = client

    all_symbols = list(PAIRS) + [s for s in _promoted_pairs if s not in PAIRS]
    results = []
    for i, sym in enumerate(all_symbols):
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

    # Drain Phase-2 entry queue (ready-to-fire from 5m timing tasks)
    fired = drain_entry_queue()
    new_alerts.extend(fired)

    return pair_states, new_alerts
