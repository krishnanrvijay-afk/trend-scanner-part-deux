import logging
import time
import asyncio
from typing import Optional
import numpy as np
import pandas as pd

from config import (
    PAIRS, ALERT_THRESHOLD, TC_MIN_SCORE, TC_ADX_MIN,
    DEPTH_GATE_PCT, J5_LONG_GATE, J5_SHORT_GATE,
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE,
    COOLDOWN_MINUTES, PAPER_MODE,
)
from hl_client import HLClient

logger = logging.getLogger("scanner")

# ── Consecutive-scan confirmation state ──────────────────────────────────────
_prev_scores: dict[str, int] = {}
_cooldowns: dict[str, float] = {}
_pending: dict[str, dict] = {}

logger.info(
    "[CONFIG] ALERT_THRESHOLD=%s | TC_MIN=%s | ADX_LONG=%s | ADX_SHORT=%s"
    " | DEPTH=%s%% | J_LONG<%s | J_SHORT>%s"
    " | MARGIN_CAP=%s | DEFAULT_MARGIN=%s | LEVERAGE=%sx | PAPER_MODE=%s",
    ALERT_THRESHOLD, TC_MIN_SCORE, TC_ADX_MIN, TC_ADX_MIN,
    DEPTH_GATE_PCT, J5_LONG_GATE, J5_SHORT_GATE,
    MARGIN_HARD_CAP_USDC, DEFAULT_MARGIN_USDC, DEFAULT_LEVERAGE, PAPER_MODE,
)


def _in_cooldown(key: str) -> bool:
    return time.time() < _cooldowns.get(key, 0)


def _set_cooldown(key: str):
    _cooldowns[key] = time.time() + COOLDOWN_MINUTES * 60


def get_pending() -> list[dict]:
    return list(_pending.values())


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
    # J is intentionally unbounded (raw KDJ convention); gate logic uses raw J,
    # display layer clamps to [0, 100]
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


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_tc_long(
    trend: str, adx_1h: float,
    ma10: float, ma30: float, ma60: float,
    rsi_5m: float, rsi_5m_prev: float, rsi_1h: float,
    last_vol: float, vol_ma10: float,
    bid_pct: float, j5: float,
) -> int:
    if trend != "Strong Bull": return 0
    if adx_1h < TC_ADX_MIN: return 0
    if bid_pct < 55.0: return 0
    if j5 >= J5_LONG_GATE: return 0

    score = 2  # P1 + P2 free (guaranteed by gates)
    if ma10 > ma30 > ma60: score += 1                          # P3
    if rsi_5m < 40 and rsi_5m > rsi_5m_prev: score += 1       # P4
    if rsi_1h > 50: score += 1                                 # P5
    if vol_ma10 > 0 and last_vol > 1.5 * vol_ma10: score += 1 # P6
    score += 1                                                  # P7 free
    return score


def score_tc_short(
    trend: str, adx_1h: float,
    ma10: float, ma30: float, ma60: float,
    rsi_5m: float, rsi_5m_prev: float, rsi_1h: float,
    last_vol: float, vol_ma10: float,
    ask_pct: float, j5: float,
) -> int:
    if trend != "Strong Bear": return 0
    if adx_1h < TC_ADX_MIN: return 0
    if ask_pct < 55.0: return 0
    if j5 <= J5_SHORT_GATE: return 0

    score = 2  # P1 + P2 free
    if ma10 < ma30 < ma60: score += 1                          # P3
    if rsi_5m > 60 and rsi_5m < rsi_5m_prev: score += 1       # P4
    if rsi_1h < 50: score += 1                                 # P5
    if vol_ma10 > 0 and last_vol > 1.5 * vol_ma10: score += 1 # P6
    score += 1                                                  # P7 free
    return score


# ── SL / TP ───────────────────────────────────────────────────────────────────

def calc_sl_tp(entry_price: float, direction: str, atr: float, margin_usdc: float) -> dict:
    sl_distance = 1.5 * atr
    if direction == "LONG":
        sl_price = entry_price - sl_distance
        tp1_price = entry_price + 1.5 * sl_distance
        tp2_price = entry_price + 2.0 * sl_distance
    else:
        sl_price = entry_price + sl_distance
        tp1_price = entry_price - 1.5 * sl_distance
        tp2_price = entry_price - 2.0 * sl_distance

    sl_pct = (sl_distance / entry_price) * 100 if entry_price > 0 else 0
    dollar_risk = margin_usdc * (sl_pct / 100)

    return {
        "sl_price": round(sl_price, 6),
        "sl_pct": round(sl_pct, 2),
        "dollar_risk": round(dollar_risk, 2),
        "tp1_price": round(tp1_price, 6),
        "tp2_price": round(tp2_price, 6),
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
        trend, adx_1h, ma10, ma30, ma60,
        rsi_5m, rsi_5m_prev, rsi_1h,
        last_vol, vol_ma10, bid_pct, j5
    )
    short_score = score_tc_short(
        trend, adx_1h, ma10, ma30, ma60,
        rsi_5m, rsi_5m_prev, rsi_1h,
        last_vol, vol_ma10, ask_pct, j5
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
                sl_tp = calc_sl_tp(entry_price, direction, atr, 700)
                alerts.append({
                    "symbol": symbol,
                    "direction": direction,
                    "score": score,
                    "trend": trend,
                    "adx": round(adx_1h, 1),
                    "entry_price": entry_price,
                    "margin": 700,
                    "leverage": 10,
                    **sl_tp,
                    "fired_at": int(time.time()),
                })
                _pending.pop(key, None)
                _set_cooldown(key)
            else:
                # First qualifying scan → mark as pending (awaiting reconfirmation)
                _pending[key] = {
                    "symbol": symbol,
                    "direction": direction,
                    "score": score,
                    "trend": trend,
                    "adx": round(adx_1h, 1),
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
        "scanned_at": int(time.time()),
    }


async def run_full_scan(client: HLClient) -> tuple[list[dict], list[dict]]:
    tasks = [scan_pair(sym, client) for sym in PAIRS]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    pair_states, new_alerts = [], []
    for result in results:
        if isinstance(result, Exception):
            print(f"[scanner] Exception: {result}")
            continue
        pair_states.append(result)
        new_alerts.extend(result.get("alerts", []))

    return pair_states, new_alerts
