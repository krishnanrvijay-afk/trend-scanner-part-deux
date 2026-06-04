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
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE,
    COOLDOWN_MINUTES, PAPER_MODE,
    PROMOTED_SLOTS, ROTATION_WINDOW_MINUTES,
    UNIVERSE_VOLUME_MIN_USD, UNIVERSE_OI_MIN_USD,
    UNIVERSE_FUNDING_MIN_ABS, UNIVERSE_VOLUME_FALLBACK_MULTIPLIER,
)
from hl_client import HLClient

logger = logging.getLogger("scanner")

# ── Consecutive-scan confirmation state ──────────────────────────────────────
_prev_scores: dict[str, int] = {}
_cooldowns: dict[str, float] = {}
_pending: dict[str, dict] = {}
_confirmed_at: dict[str, float] = {}
CONFIRMED_SHOW_SECONDS = 30

# ── Universe scanner state ─────────────────────────────────────────────────────
_promoted_pairs: dict[str, dict] = {}   # symbol → slot entry
_universe_state: dict = {
    "last_scan_at": None,
    "total_pairs_scanned": 0,
    "pairs_surviving_filter": 0,
    "last_candidates": [],
}

logger.info(
    "[CONFIG] ALERT_THRESHOLD=%s | TC_MIN=%s | ADX_MIN=%s"
    " | DEPTH=%s%% | J_SHORT>80(ADX<50)/>55or<45(ADX>=50) | J_LONG<20(ADX<50)/<45or>55(ADX>=50)"
    " | P4_SHORT=rsi<40_rising(CAP)/rsi>60_falling(STD) P6_SHORT=vol>1.2x(CAP)/vol>1.5x(STD)"
    " | MARGIN_CAP=%s | DEFAULT_MARGIN=%s | LEVERAGE=%sx | PAPER_MODE=%s",
    ALERT_THRESHOLD, TC_MIN_SCORE, TC_ADX_MIN,
    DEPTH_GATE_PCT,
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE, PAPER_MODE,
)


def _in_cooldown(key: str) -> bool:
    return time.time() < _cooldowns.get(key, 0)


def _set_cooldown(key: str, reason: str = "UNKNOWN"):
    duration = int(COOLDOWN_MINUTES * 60)
    _cooldowns[key] = time.time() + duration
    logger.info("[COOLDOWN] %s cooldown started — reason=%s duration=%ss", key, reason, duration)


def _get_signal_state(symbol: str) -> str:
    """Returns per-symbol signal state for the SIGNAL column: none | pending | confirmed."""
    now = time.time()
    for direction in ("LONG", "SHORT"):
        key = f"{symbol}{direction}"
        if key in _pending:
            return "pending"
        if key in _confirmed_at and now - _confirmed_at[key] < CONFIRMED_SHOW_SECONDS:
            return "confirmed"
    return "none"


def get_pending() -> list[dict]:
    return list(_pending.values())


def get_cooldown_remaining(symbol: str, direction: str) -> int:
    """Returns seconds remaining in cooldown for this symbol-direction (0 if expired or not set)."""
    expires = _cooldowns.get(f"{symbol}{direction}", 0)
    return max(0, int(expires - time.time()))


def set_close_cooldown(symbol: str, direction: str):
    """Called by main.py when a trade fully closes — the ONLY place cooldown is started."""
    key = f"{symbol}{direction}"
    _set_cooldown(key, reason="TRADE_CLOSE")


def reset_scan_counter(symbol: str, direction: str):
    """Called by main.py when a trade fully closes — resets consecutive-scan confirmation state."""
    key = f"{symbol}{direction}"
    _prev_scores[key] = 0
    _pending.pop(key, None)
    logger.info("[RESET] %s %s scan counter reset on trade close", symbol, direction)


def get_promoted_pairs() -> list[dict]:
    """Returns current promoted pair entries for serialisation."""
    return list(_promoted_pairs.values())


def get_universe_state() -> dict:
    """Returns universe scanner state for serialisation."""
    return dict(_universe_state)


# ── Pure-pandas indicator helpers ─────────────────────────────────────────────

def _wilder_smooth(series: pd.Series, period: int) -> pd.Series:
    """Wilder's smoothing (EMA with alpha = 1/period)."""
    result = np.full(len(series), np.nan)
    # find first non-NaN index
    start = series.first_valid_index()
    if start is None:
        return pd.Series(result, index=series.index)
    i0 = series.index.get_loc(start)
    # seed with SMA of first `period` values
    seed_end = i0 + period
    if seed_end > len(series):
        return pd.Series(result, index=series.index)
    result[seed_end - 1] = series.iloc[i0:seed_end].mean()
    for i in range(seed_end, len(series)):
        result[i] = result[i - 1] * (1 - 1 / period) + series.iloc[i] * (1 / period)
    return pd.Series(result, index=series.index)


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return _wilder_smooth(tr, period)


def compute_adx(df: pd.DataFrame, period: int = 14) -> float:
    """Returns latest ADX value (scalar)."""
    if len(df) < period * 2 + 1:
        return 0.0
    high = df["high"]
    low = df["low"]
    close = df["close"]

    move_up = high.diff()
    move_down = -low.diff()

    plus_dm = pd.Series(np.where((move_up > move_down) & (move_up > 0), move_up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((move_down > move_up) & (move_down > 0), move_down, 0.0), index=df.index)

    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)

    atr_s = _wilder_smooth(tr.iloc[1:], period)
    plus_dm_s = _wilder_smooth(plus_dm.iloc[1:], period)
    minus_dm_s = _wilder_smooth(minus_dm.iloc[1:], period)

    plus_di = 100 * plus_dm_s / atr_s.replace(0, np.nan)
    minus_di = 100 * minus_dm_s / atr_s.replace(0, np.nan)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = _wilder_smooth(dx.dropna(), period)

    if adx.empty or pd.isna(adx.iloc[-1]):
        return 0.0
    return float(adx.iloc[-1])


def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = _wilder_smooth(gain.iloc[1:], period)
    avg_loss = _wilder_smooth(loss.iloc[1:], period)
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def compute_stoch_kdj(df: pd.DataFrame, k_period: int = 9, d_period: int = 3, smooth_k: int = 3) -> tuple[float, float, float]:
    """Returns (K, D, J) as scalars. J = 3K - 2D."""
    if len(df) < k_period + d_period + smooth_k:
        return 50.0, 50.0, 50.0

    low_min = df["low"].rolling(k_period).min()
    high_max = df["high"].rolling(k_period).max()
    denom = (high_max - low_min).replace(0, np.nan)
    raw_k = 100 * (df["close"] - low_min) / denom

    # Smooth %K
    smooth_k_series = raw_k.rolling(smooth_k).mean()
    d_series = smooth_k_series.rolling(d_period).mean()

    # Clamp K and D to [0, 100] before computing J
    k_val = max(0.0, min(100.0, float(smooth_k_series.iloc[-1]))) if pd.notna(smooth_k_series.iloc[-1]) else 50.0
    d_val = max(0.0, min(100.0, float(d_series.iloc[-1]))) if pd.notna(d_series.iloc[-1]) else 50.0
    # J is intentionally unbounded (raw KDJ convention); displayed in pair table for reference only
    j_val = 3 * k_val - 2 * d_val

    return k_val, d_val, j_val


# ── Trend classification ──────────────────────────────────────────────────────

def classify_trend(df_1h: pd.DataFrame) -> str:
    if len(df_1h) < 60:
        return "Neutral"
    close = df_1h["close"]
    ma10 = close.rolling(10).mean().iloc[-1]
    ma30 = close.rolling(30).mean().iloc[-1]
    ma60 = close.rolling(60).mean().iloc[-1]
    price = close.iloc[-1]

    if price > ma10 > ma30 > ma60:
        return "Strong Bull"
    elif price < ma10 < ma30 < ma60:
        return "Strong Bear"
    return "Neutral"


def get_ma_values(df_1h: pd.DataFrame) -> tuple[float, float, float]:
    close = df_1h["close"]
    ma10 = float(close.rolling(10).mean().iloc[-1])
    ma30 = float(close.rolling(30).mean().iloc[-1])
    ma60 = float(close.rolling(60).mean().iloc[-1])
    return ma10, ma30, ma60


# ── Per-indicator calcs ───────────────────────────────────────────────────────

def compute_rsi_5m(df_5m: pd.DataFrame) -> tuple[float, float]:
    """(rsi_current, rsi_prev) from 5m close."""
    if len(df_5m) < 16:
        return 50.0, 50.0
    rsi_s = compute_rsi(df_5m["close"], 14)
    rsi_s = rsi_s.dropna()
    if len(rsi_s) < 2:
        return 50.0, 50.0
    return float(rsi_s.iloc[-1]), float(rsi_s.iloc[-2])


def compute_rsi_1h(df_1h: pd.DataFrame) -> float:
    if len(df_1h) < 16:
        return 50.0
    rsi_s = compute_rsi(df_1h["close"], 14).dropna()
    if rsi_s.empty:
        return 50.0
    return float(rsi_s.iloc[-1])


def compute_volume_ma10(df_5m: pd.DataFrame) -> tuple[float, float]:
    """(last_vol, vol_ma10)."""
    if len(df_5m) < 11:
        return 0.0, 0.0
    vol = df_5m["volume"]
    ma = vol.rolling(10).mean()
    return float(vol.iloc[-1]), float(ma.iloc[-1])


def compute_j5(df_5m: pd.DataFrame) -> float:
    _, _, j = compute_stoch_kdj(df_5m, k_period=9, d_period=3, smooth_k=3)
    return j


def compute_depth_pcts(orderbook: dict) -> tuple[float, float]:
    bids = orderbook.get("bids", [])
    asks = orderbook.get("asks", [])
    bid_total = sum(b["sz"] for b in bids)
    ask_total = sum(a["sz"] for a in asks)
    total = bid_total + ask_total
    if total == 0:
        return 50.0, 50.0
    return bid_total / total * 100, ask_total / total * 100


def compute_atr_5m(df_5m: pd.DataFrame) -> float:
    if len(df_5m) < 16:
        return 0.0
    atr_s = compute_atr(df_5m, 14)
    val = atr_s.dropna()
    return float(val.iloc[-1]) if not val.empty else 0.0


# ── Gate status (for dots display and closest-pair ranking) ───────────────────

def compute_gates_status(
    trend: str, adx_1h: float,
    bid_pct: float, ask_pct: float,
    j5: float,
    ma10: float = 0.0, ma30: float = 0.0, ma60: float = 0.0,
    rsi_5m: float = 50.0, rsi_5m_prev: float = 50.0, rsi_1h: float = 50.0,
    last_vol: float = 0.0, vol_ma10: float = 0.0,
) -> dict:
    """Evaluate all 7 gate/criteria states for BOTH LONG and SHORT.

    Hard gates (T A D J) — must all pass to fire a signal:
      TREND — trend matches direction
      ADX   — adx_1h >= TC_ADX_MIN
      DEPTH — bid_pct >= DEPTH_GATE_PCT (LONG) / ask_pct >= DEPTH_GATE_PCT (SHORT)
      J     — tiered: ADX>=50 relaxed (j<45 or j>55), ADX<50 standard (<20 LONG, >80 SHORT)

    Soft criteria (MA RS VL) — scoring points exposed for the dot display:
      MA    — MA stack aligned for direction (P3)
      RSI   — both P4 and P5 pass (rsi_partial = exactly one passes)
      VOL   — volume spike above tier threshold (P6)

    Returns the direction with the most HARD gates passing; ties broken by trend alignment.
    gates_passing = hard-gate count (max 4).
    gates_total   = all 7 (used for closest-pair ranking).
    failing_gate  = name of the single failing gate when total == 6 (or hard == 3).
    """
    best: dict = {
        "gates_direction": "NONE",
        "trend_pass": False, "adx_pass": False, "depth_pass": False, "j_pass": False,
        "ma_pass": False, "rsi_pass": False, "rsi_partial": False, "vol_pass": False,
        "gates_passing": 0,   # hard gates (max 4)
        "gates_total":   0,   # all 7
        "failing_gate":  None,
    }

    for direction in ("LONG", "SHORT"):
        # ── Hard gates ─────────────────────────────────────────────────────
        trend_pass = (trend == "Strong Bull") if direction == "LONG" else (trend == "Strong Bear")
        adx_pass   = adx_1h >= TC_ADX_MIN
        if direction == "LONG":
            depth_pass = bid_pct >= DEPTH_GATE_PCT
            j_pass = (j5 < 45.0 or j5 > 55.0) if adx_1h >= 50 else (j5 < 20.0)
        else:
            depth_pass = ask_pct >= DEPTH_GATE_PCT
            j_pass = (j5 > 55.0 or j5 < 45.0) if adx_1h >= 50 else (j5 > 80.0)

        gates_passing = int(trend_pass) + int(adx_pass) + int(depth_pass) + int(j_pass)

        # ── Soft criteria (computed independently of score functions) ──────
        if direction == "LONG":
            ma_pass    = bool(ma10 and ma30 and ma60 and ma10 > ma30 > ma60)
            p4         = bool(rsi_5m < 40 and rsi_5m > rsi_5m_prev)
            p5         = bool(rsi_1h > 50)
            vol_thresh = 1.5
        else:
            ma_pass    = bool(ma10 and ma30 and ma60 and ma10 < ma30 < ma60)
            is_cap     = adx_1h >= 50 and j5 < 45.0
            if is_cap:
                p4 = bool(rsi_5m < 40 and rsi_5m > rsi_5m_prev)
                vol_thresh = 1.2
            else:
                p4 = bool(rsi_5m > 60 and rsi_5m < rsi_5m_prev)
                vol_thresh = 1.5
            p5 = bool(rsi_1h < 50)

        rsi_pass    = p4 and p5
        rsi_partial = (p4 or p5) and not rsi_pass
        vol_pass    = bool(vol_ma10 > 0 and last_vol > vol_thresh * vol_ma10)

        gates_total = gates_passing + int(ma_pass) + int(rsi_pass) + int(vol_pass)

        # ── Failing gate label ─────────────────────────────────────────────
        failing_gate: Optional[str] = None
        all_7 = [
            ("TREND", trend_pass), ("ADX", adx_pass), ("DEPTH", depth_pass), ("J", j_pass),
            ("MA", ma_pass), ("RSI", rsi_pass), ("VOL", vol_pass),
        ]
        if gates_total == 6:
            for name, passing in all_7:
                if not passing:
                    failing_gate = name
                    break
        elif gates_passing == 3:
            for name, passing in all_7[:4]:   # hard gates only
                if not passing:
                    failing_gate = name
                    break

        candidate = {
            "gates_direction": direction,
            "trend_pass":   trend_pass,
            "adx_pass":     adx_pass,
            "depth_pass":   depth_pass,
            "j_pass":       j_pass,
            "ma_pass":      ma_pass,
            "rsi_pass":     rsi_pass,
            "rsi_partial":  rsi_partial,
            "vol_pass":     vol_pass,
            "gates_passing": gates_passing,
            "gates_total":   gates_total,
            "failing_gate":  failing_gate,
        }

        # Keep candidate if more hard gates pass; ties → trend-aligned direction
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


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_tc_long(
    symbol: str,
    trend: str, adx_1h: float,
    ma10: float, ma30: float, ma60: float,
    rsi_5m: float, rsi_5m_prev: float, rsi_1h: float,
    last_vol: float, vol_ma10: float,
    bid_pct: float, j5: float,
) -> int:
    if trend != "Strong Bull": return 0
    if adx_1h < TC_ADX_MIN: return 0
    if bid_pct < 55.0: return 0

    # J gate: two-tier based on ADX strength
    if adx_1h >= 50:
        if j5 < 45.0:
            j_condition = "OVERSOLD"
        elif j5 > 55.0:
            j_condition = "MOMENTUM"
        else:
            return 0  # J in neutral zone — no confirmation
        logger.info("[GATE] %s LONG adx=%.1f tier=RELAXED j5=%.1f condition=%s pass.",
                    symbol, adx_1h, j5, j_condition)
    else:
        if j5 < 20.0:
            logger.info("[GATE] %s LONG adx=%.1f tier=STANDARD j5=%.1f condition=OVERSOLD pass.",
                        symbol, adx_1h, j5)
        else:
            return 0

    score = 2  # P1 + P2 free (guaranteed by gates)
    p3 = int(ma10 > ma30 > ma60)
    p4 = int(rsi_5m < 40 and rsi_5m > rsi_5m_prev)
    p5 = int(rsi_1h > 50)
    p6 = int(vol_ma10 > 0 and last_vol > 1.5 * vol_ma10)
    score += p3 + p4 + p5 + p6
    score += 1  # P7 free

    if score < TC_MIN_SCORE:
        reasons = []
        if not p3: reasons.append("P3 ma not aligned bull")
        if not p4: reasons.append("P4 rsi_5m not rising from oversold")
        if not p5: reasons.append("P5 rsi_1h below 50")
        if not p6: reasons.append("P6 volume not spiking")
        logger.info(
            "[SCORE DETAIL] %s LONG gates=PASS score=%d/7 P1=1 P2=1 P3=%d P4=%d P5=%d P6=%d P7=1 reason=%s",
            symbol, score, p3, p4, p5, p6, " ".join(reasons),
        )

    return score


def score_tc_short(
    symbol: str,
    trend: str, adx_1h: float,
    ma10: float, ma30: float, ma60: float,
    rsi_5m: float, rsi_5m_prev: float, rsi_1h: float,
    last_vol: float, vol_ma10: float,
    ask_pct: float, j5: float,
) -> int:
    if trend != "Strong Bear": return 0
    if adx_1h < TC_ADX_MIN: return 0
    if ask_pct < 55.0: return 0

    # J gate: two-tier based on ADX strength
    if adx_1h >= 50:
        if j5 > 55.0:
            j_condition = "OVERBOUGHT"
        elif j5 < 45.0:
            j_condition = "CAPITULATION"
        else:
            return 0  # J in neutral zone — no confirmation
        logger.info("[GATE] %s SHORT adx=%.1f tier=RELAXED j5=%.1f condition=%s pass.",
                    symbol, adx_1h, j5, j_condition)
    else:
        if j5 > 80.0:
            logger.info("[GATE] %s SHORT adx=%.1f tier=STANDARD j5=%.1f condition=OVERBOUGHT pass.",
                        symbol, adx_1h, j5)
        else:
            return 0

    # ── Tier determination (must come before point calculation) ─────────────
    is_capitulation = adx_1h >= 50 and j5 < 45.0
    tier = "CAPITULATION" if is_capitulation else "STANDARD"

    score = 2  # P1 + P2 free
    p3 = int(ma10 < ma30 < ma60)

    # P4 — tier-aware RSI confirmation
    if is_capitulation:
        # RSI oversold and ticking up: exhaustion bounce before continuation lower
        p4 = int(rsi_5m < 40 and rsi_5m > rsi_5m_prev)
    else:
        # RSI declining from overbought: standard momentum confirmation
        p4 = int(rsi_5m > 60 and rsi_5m < rsi_5m_prev)

    p5 = int(rsi_1h < 50)

    # P6 — tier-aware volume threshold
    if is_capitulation:
        p6 = int(vol_ma10 > 0 and last_vol > 1.2 * vol_ma10)
    else:
        p6 = int(vol_ma10 > 0 and last_vol > 1.5 * vol_ma10)

    score += p3 + p4 + p5 + p6
    score += 1  # P7 free

    # Tier log — fires whenever all 4 hard gates pass, regardless of score
    # Expose every sub-condition value so Railway logs make the evaluation unambiguous.
    vol_ratio = (last_vol / vol_ma10) if vol_ma10 > 0 else 0.0
    _prev_valid = rsi_5m_prev is not None and not (isinstance(rsi_5m_prev, float) and rsi_5m_prev != rsi_5m_prev)
    if is_capitulation:
        _oversold = rsi_5m < 40
        _rising   = (rsi_5m > rsi_5m_prev) if _prev_valid else False
        logger.info(
            "[TIER] %s SHORT tier=CAPITULATION P4=%d"
            " rsi_5m=%.2f rsi_5m_prev=%s"
            " condition=rsi<40_AND_rising"
            " evaluated=%.2f<40=%s rising=%s"
            " P6=%d vol=%.2fx MA10 threshold=1.2x",
            symbol, p4,
            rsi_5m, f"{rsi_5m_prev:.2f}" if _prev_valid else "NaN",
            rsi_5m, str(_oversold).upper(), str(_rising).upper(),
            p6, vol_ratio,
        )
    else:
        _overbought = rsi_5m > 60
        _falling    = (rsi_5m < rsi_5m_prev) if _prev_valid else False
        logger.info(
            "[TIER] %s SHORT tier=STANDARD P4=%d"
            " rsi_5m=%.2f rsi_5m_prev=%s"
            " condition=rsi>60_AND_falling"
            " evaluated=%.2f>60=%s falling=%s"
            " P6=%d vol=%.2fx MA10 threshold=1.5x",
            symbol, p4,
            rsi_5m, f"{rsi_5m_prev:.2f}" if _prev_valid else "NaN",
            rsi_5m, str(_overbought).upper(), str(_falling).upper(),
            p6, vol_ratio,
        )

    if score < TC_MIN_SCORE:
        reasons = []
        if not p3: reasons.append("P3 ma not aligned bear")
        if not p4: reasons.append(
            f"P4 rsi_5m not rising from oversold (rsi_5m={rsi_5m:.1f} prev={rsi_5m_prev:.1f})" if is_capitulation
            else f"P4 rsi_5m not falling from overbought (rsi_5m={rsi_5m:.1f} prev={rsi_5m_prev:.1f})"
        )
        if not p5: reasons.append("P5 rsi_1h above 50")
        if not p6: reasons.append(
            "P6 vol below 1.2x MA10" if is_capitulation else "P6 volume not spiking"
        )
        logger.info(
            "[SCORE DETAIL] %s SHORT gates=PASS tier=%s score=%d/7 P1=1 P2=1 P3=%d P4=%d P5=%d P6=%d P7=1 reason=%s",
            symbol, tier, score, p3, p4, p5, p6, " ".join(reasons),
        )

    return score


# ── SL / TP ───────────────────────────────────────────────────────────────────

def calc_sl_tp(entry_price: float, direction: str, atr: float, margin_usdc: float,
               leverage: int = 10, symbol: str = "?") -> dict:
    """Compute SL/TP levels from ATR.
    sl_distance = 1.5 × ATR, clamped to [0.3%, 3.0%] of entry — outside that range
    the ATR value is invalid (NaN bleed, wrong candle timeframe, etc.) and a 1.0%
    fallback is used instead.
    dollar_risk = 1R dollar loss = margin × leverage × sl_pct  (leverage-aware)."""
    sl_distance = 1.5 * atr
    sl_pct = (sl_distance / entry_price) * 100 if entry_price > 0 else 0

    # Reject ATR values that would produce nonsensical SL distances
    if atr <= 0 or sl_pct < 0.3 or sl_pct > 3.0:
        logger.warning(
            "[ATR WARNING] %s %s invalid ATR=%.6f (sl_pct=%.3f%%) — using fallback 1.0%%",
            symbol, direction, atr, sl_pct,
        )
        sl_pct = 1.0
        sl_distance = entry_price * 0.01

    if direction == "LONG":
        sl_price  = entry_price - sl_distance
        tp1_price = entry_price + 1.5 * sl_distance
        tp2_price = entry_price + 2.0 * sl_distance
    else:
        sl_price  = entry_price + sl_distance
        tp1_price = entry_price - 1.5 * sl_distance
        tp2_price = entry_price - 2.0 * sl_distance

    # dollar_risk = leverage-aware 1R dollar loss
    dollar_risk = margin_usdc * leverage * (sl_pct / 100)

    return {
        "sl_price":    round(sl_price, 6),
        "sl_pct":      round(sl_pct, 2),
        "sl_distance": round(sl_distance, 8),
        "dollar_risk": round(dollar_risk, 2),
        "tp1_price":   round(tp1_price, 6),
        "tp2_price":   round(tp2_price, 6),
    }


# ── Per-pair scan ─────────────────────────────────────────────────────────────

async def scan_pair(symbol: str, client: HLClient) -> dict:
    try:
        candles_5m_raw, candles_1h_raw, orderbook, price = await asyncio.gather(
            client.get_candles(symbol, "5m", 50),
            client.get_candles(symbol, "1h", 80),
            client.get_orderbook(symbol, 20),
            client.get_price(symbol),
        )
    except Exception as e:
        print(f"[scanner] Data fetch error for {symbol}: {e}")
        return {"symbol": symbol, "error": str(e)}

    if not candles_5m_raw or not candles_1h_raw or price is None:
        return {"symbol": symbol, "error": "Insufficient data"}

    df_5m = pd.DataFrame(candles_5m_raw)
    df_1h = pd.DataFrame(candles_1h_raw)

    trend = classify_trend(df_1h)
    ma10, ma30, ma60 = get_ma_values(df_1h)
    adx_1h = compute_adx(df_1h, 14)
    rsi_5m, rsi_5m_prev = compute_rsi_5m(df_5m)
    rsi_1h = compute_rsi_1h(df_1h)
    last_vol, vol_ma10 = compute_volume_ma10(df_5m)
    j5 = compute_j5(df_5m)
    bid_pct, ask_pct = compute_depth_pcts(orderbook)
    atr = compute_atr_5m(df_5m)

    long_score = score_tc_long(
        symbol, trend, adx_1h, ma10, ma30, ma60,
        rsi_5m, rsi_5m_prev, rsi_1h,
        last_vol, vol_ma10, bid_pct, j5,
    )
    short_score = score_tc_short(
        symbol, trend, adx_1h, ma10, ma30, ma60,
        rsi_5m, rsi_5m_prev, rsi_1h,
        last_vol, vol_ma10, ask_pct, j5,
    )
    logger.info("[SCORE] %s LONG=%s SHORT=%s | trend=%s adx=%.1f j5=%.1f bid=%.1f ask=%.1f",
                symbol, long_score, short_score, trend, adx_1h, j5, bid_pct, ask_pct)

    alerts = []
    for direction, score in [("LONG", long_score), ("SHORT", short_score)]:
        key = f"{symbol}{direction}"
        if score >= TC_MIN_SCORE:
            prev = _prev_scores.get(key, 0)
            if prev >= TC_MIN_SCORE and not _in_cooldown(key):
                # Second consecutive qualifying scan → emit full alert
                entry_price = price
                sl_tp = calc_sl_tp(entry_price, direction, atr, 700, leverage=10, symbol=symbol)
                logger.info(
                    "[TRADE] %s %s entry=%.6f atr=%.6f sl_distance=%.6f sl_price=%.6f risk_pct=%.2f%%",
                    symbol, direction, entry_price, atr,
                    sl_tp["sl_distance"], sl_tp["sl_price"], sl_tp["sl_pct"],
                )
                alerts.append({
                    "symbol": symbol,
                    "direction": direction,
                    "score": score,
                    "trend": trend,
                    "adx": round(adx_1h, 1),
                    "rsi_5m": round(rsi_5m, 1),
                    "rsi_1h": round(rsi_1h, 1),
                    "entry_price": entry_price,
                    "margin": 700,
                    "leverage": 10,
                    **sl_tp,
                    "fired_at": int(time.time()),
                })
                _pending.pop(key, None)
                _confirmed_at[key] = time.time()
            else:
                # First qualifying scan → mark as pending (awaiting reconfirmation)
                _pending[key] = {
                    "symbol": symbol,
                    "direction": direction,
                    "score": score,
                    "trend": trend,
                    "adx": round(adx_1h, 1),
                    "rsi_5m": round(rsi_5m, 1),
                    "rsi_1h": round(rsi_1h, 1),
                    "first_seen": int(time.time()),
                }
            _prev_scores[key] = score
        else:
            _prev_scores[key] = 0
            _pending.pop(key, None)

    return {
        "symbol": symbol,
        "price": price,
        "trend": trend,
        "long_score": long_score,
        "short_score": short_score,
        "adx": round(adx_1h, 1),
        "j5": round(max(0.0, min(100.0, j5)), 1),
        "bid_pct": round(bid_pct, 1),
        "ask_pct": round(ask_pct, 1),
        "rsi_5m": round(rsi_5m, 1),
        "rsi_1h": round(rsi_1h, 1),
        "ma10": round(ma10, 4),
        "ma30": round(ma30, 4),
        "ma60": round(ma60, 4),
        "alerts": alerts,
        "signal_state": _get_signal_state(symbol),
        "gates_status": compute_gates_status(
            trend, adx_1h, bid_pct, ask_pct, j5,
            ma10=ma10, ma30=ma30, ma60=ma60,
            rsi_5m=rsi_5m, rsi_5m_prev=rsi_5m_prev, rsi_1h=rsi_1h,
            last_vol=last_vol, vol_ma10=vol_ma10,
        ),
        "scanned_at": int(time.time()),
    }


async def run_universe_scan(client: HLClient, open_trade_symbols: set) -> None:
    """Universe scanner: fetch all HL perps, filter by volume/OI/funding, rank by
    ADX + trend + depth, fill promoted slots.  Runs every UNIVERSE_SCAN_INTERVAL_MINUTES
    as an independent background task — never touches the TC scan loop."""
    try:
        # Step 1 — fetch all HL pairs
        universe = await client.get_universe_metadata()
        if not universe:
            logger.warning("[UNIVERSE] metadata fetch returned empty — will retry next interval")
            return

        fixed_set    = set(PAIRS)
        promoted_set = set(_promoted_pairs.keys())
        _universe_state["total_pairs_scanned"] = len(universe)
        candidates = [p for p in universe
                      if p["symbol"] not in fixed_set and p["symbol"] not in promoted_set]

        # Step 2 — filter
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

        # Step 3 — rank survivors (ADX 0-3 + trend clarity 0-2 + depth imbalance 0-2)
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

        # Step 4 — evict expired slots (skip if active trade or in cooldown)
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
            logger.info("[UNIVERSE] %s evicted from slot %d (rotation window expired)", sym, slot)
            del _promoted_pairs[sym]

        # Fill empty slots
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
    all_symbols = list(PAIRS) + [s for s in _promoted_pairs if s not in PAIRS]
    # Sequential with 0.5s delay between pairs — spaces 12 pairs over ~6s to prevent 429 bursts
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

    return pair_states, new_alerts
