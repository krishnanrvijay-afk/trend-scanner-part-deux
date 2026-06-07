"""
HL BOUNCE RESEARCH SCRIPT
==========================
Extends the pair research script with bounce-specific analysis.
Identifies which pairs are best suited for bounce trading based on:

1. J oscillation frequency (how often J reaches extremes)
2. J extreme duration (how long J stays at extremes)
3. J reversal success rate (does price reverse after J extreme)
4. Mean reversion speed (how fast price returns to MA after extreme)
5. Support/resistance bounce rate (MA30 bounce vs break frequency)
6. Volatility profile (ATR as % of price)
7. Liquidity score (volume consistency)

REQUIREMENTS
------------
pip install requests pandas numpy

RUN
---
python hl_bounce_research.py

OUTPUT FILES
------------
bounce_research.json  — load into bounce_research_dashboard.html
bounce_research.csv   — open in Excel/Numbers
"""

import requests
import pandas as pd
import numpy as np
import json
import csv
from datetime import datetime, timezone
import time

# ── CONFIG ────────────────────────────────────────────────────────────────────

PAIRS = [
    "BTC", "ETH", "SOL", "XRP", "DOGE",
    "SUI", "NEAR", "OP", "APT", "LINK",
    "ZEC", "ARB"
]

# Additional candidate pairs to evaluate for bounce
CANDIDATE_PAIRS = [
    "AVAX", "WIF", "PEPE", "BONK", "HYPE",
    "JUP", "RENDER", "FET", "RNDR", "INJ"
]

ALL_PAIRS = PAIRS + CANDIDATE_PAIRS

TIMEFRAMES = {
    "5m":  {"interval": "5",    "limit": 500},
    "15m": {"interval": "15",   "limit": 500},
    "1h":  {"interval": "60",   "limit": 500},
}

HL_API      = "https://api.hyperliquid.xyz/info"
J_OB        = 80   # overbought threshold
J_OS        = 20   # oversold threshold
REVERSAL_WINDOW = 3  # candles to check for reversal after J extreme

# ── HELPERS ───────────────────────────────────────────────────────────────────

def fetch_candles(symbol: str, interval: str, limit: int) -> pd.DataFrame:
    try:
        payload = {
            "type": "candleSnapshot",
            "req": {
                "coin": symbol,
                "interval": interval,
                "startTime": 0,
                "endTime": int(datetime.now(timezone.utc).timestamp() * 1000)
            }
        }
        resp = requests.post(HL_API, json=payload, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return pd.DataFrame()
        df = pd.DataFrame(data)
        df = df.rename(columns={"t":"timestamp","o":"open","h":"high","l":"low","c":"close","v":"volume"})
        for col in ["open","high","low","close","volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
        df = df.sort_values("timestamp").tail(limit).reset_index(drop=True)
        return df
    except Exception as e:
        return pd.DataFrame()


def compute_kdj(df: pd.DataFrame, period: int = 9) -> pd.Series:
    """Compute KDJ J line."""
    if len(df) < period:
        return pd.Series([np.nan] * len(df), index=df.index)
    low_min  = df["low"].rolling(period).min()
    high_max = df["high"].rolling(period).max()
    rsv = (df["close"] - low_min) / (high_max - low_min + 1e-10) * 100
    K = rsv.ewm(com=2, adjust=False).mean()
    D = K.ewm(com=2, adjust=False).mean()
    J = 3 * K - 2 * D
    return J


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"]  - prev_close).abs()
    ], axis=1).max(axis=1)
    atr = tr.ewm(span=period, adjust=False).mean()
    return atr


def compute_ma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


# ── BOUNCE ANALYSIS ───────────────────────────────────────────────────────────

def analyze_bounce(df: pd.DataFrame, tf_label: str) -> dict:
    """Core bounce analysis for one pair / timeframe."""
    if df.empty or len(df) < 60:
        return {"error": "insufficient data"}

    close  = df["close"]
    high   = df["high"]
    low    = df["low"]
    volume = df["volume"]
    n      = len(df)

    J      = compute_kdj(df)
    atr    = compute_atr(df)
    ma10   = compute_ma(close, 10)
    ma30   = compute_ma(close, 30)
    ma60   = compute_ma(close, 60)

    # ── J OSCILLATION ────────────────────────────────────────────────────────

    j_vals        = J.dropna()
    j_ob_mask     = j_vals > J_OB
    j_os_mask     = j_vals < J_OS
    j_ob_count    = int(j_ob_mask.sum())
    j_os_count    = int(j_os_mask.sum())
    j_total_extreme = j_ob_count + j_os_count
    j_extreme_pct  = round(j_total_extreme / len(j_vals) * 100, 1) if len(j_vals) else 0

    # ── J EXTREME DURATION ───────────────────────────────────────────────────
    # Count consecutive runs above OB or below OS

    def extreme_durations(mask_series):
        durations = []
        count = 0
        for val in mask_series:
            if val:
                count += 1
            else:
                if count > 0:
                    durations.append(count)
                count = 0
        if count > 0:
            durations.append(count)
        return durations

    ob_durations = extreme_durations(j_ob_mask.values)
    os_durations = extreme_durations(j_os_mask.values)
    all_durations = ob_durations + os_durations

    avg_extreme_duration = round(float(np.mean(all_durations)), 1) if all_durations else 0
    max_extreme_duration = int(max(all_durations)) if all_durations else 0

    # ── J REVERSAL SUCCESS RATE ───────────────────────────────────────────────
    # After J crosses above OB does price drop within REVERSAL_WINDOW candles
    # After J crosses below OS does price rise within REVERSAL_WINDOW candles

    ob_reversals_success = 0
    ob_reversals_total   = 0
    os_reversals_success = 0
    os_reversals_total   = 0

    j_arr = J.values
    c_arr = close.values

    for i in range(1, n - REVERSAL_WINDOW):
        if np.isnan(j_arr[i]):
            continue
        # OB cross — J just went above 80
        if j_arr[i] > J_OB and j_arr[i-1] <= J_OB:
            ob_reversals_total += 1
            future_low = np.min(c_arr[i+1:i+1+REVERSAL_WINDOW])
            if future_low < c_arr[i]:
                ob_reversals_success += 1
        # OS cross — J just went below 20
        if j_arr[i] < J_OS and j_arr[i-1] >= J_OS:
            os_reversals_total += 1
            future_high = np.max(c_arr[i+1:i+1+REVERSAL_WINDOW])
            if future_high > c_arr[i]:
                os_reversals_success += 1

    ob_reversal_rate = round(ob_reversals_success / ob_reversals_total * 100, 1) if ob_reversals_total else 0
    os_reversal_rate = round(os_reversals_success / os_reversals_total * 100, 1) if os_reversals_total else 0
    avg_reversal_rate = round((ob_reversal_rate + os_reversal_rate) / 2, 1) if (ob_reversals_total + os_reversals_total) else 0

    # ── MEAN REVERSION SPEED ──────────────────────────────────────────────────
    # After J extreme how many candles before price returns to MA10

    reversion_speeds = []
    ma10_arr = ma10.values

    for i in range(1, n - 20):
        if np.isnan(j_arr[i]) or np.isnan(ma10_arr[i]):
            continue
        is_extreme = j_arr[i] > J_OB or j_arr[i] < J_OS
        was_not    = j_arr[i-1] <= J_OB and j_arr[i-1] >= J_OS
        if is_extreme and was_not:
            # Find when price crosses back to MA10
            for k in range(1, 20):
                if i + k >= n:
                    break
                price_now = c_arr[i + k]
                ma_now    = ma10_arr[i + k]
                if np.isnan(ma_now):
                    continue
                # Price crossed MA10
                if (j_arr[i] > J_OB and price_now <= ma_now) or \
                   (j_arr[i] < J_OS and price_now >= ma_now):
                    reversion_speeds.append(k)
                    break

    avg_reversion_speed = round(float(np.mean(reversion_speeds)), 1) if reversion_speeds else None

    # ── MA30 BOUNCE vs BREAK RATE ─────────────────────────────────────────────
    # When price touches MA30 does it bounce or break through

    ma30_arr = ma30.values
    bounces  = 0
    breaks   = 0

    for i in range(2, n - 2):
        if np.isnan(ma30_arr[i]):
            continue
        ma_val = ma30_arr[i]
        # Price approached MA30 from above (potential bounce up)
        if low.iloc[i] <= ma_val <= close.iloc[i-1]:
            if close.iloc[i+1] > ma_val:
                bounces += 1
            else:
                breaks += 1
        # Price approached MA30 from below (potential bounce down)
        if high.iloc[i] >= ma_val >= close.iloc[i-1]:
            if close.iloc[i+1] < ma_val:
                bounces += 1
            else:
                breaks += 1

    total_touches    = bounces + breaks
    ma30_bounce_rate = round(bounces / total_touches * 100, 1) if total_touches else 0

    # ── VOLATILITY ────────────────────────────────────────────────────────────

    atr_vals    = atr.dropna()
    avg_atr_pct = round(float((atr_vals / close.iloc[-len(atr_vals):]).mean() * 100), 3) if len(atr_vals) else 0
    max_atr_pct = round(float((atr_vals / close.iloc[-len(atr_vals):]).max() * 100), 3) if len(atr_vals) else 0

    # ── VOLUME CONSISTENCY ────────────────────────────────────────────────────

    vol_mean = float(volume.mean())
    vol_cv   = round(float(volume.std() / vol_mean), 2) if vol_mean else 0
    # Lower CV = more consistent volume = better liquidity

    # ── BOUNCE SCORE (0-100) ──────────────────────────────────────────────────
    # Composite score for bounce suitability

    score = 0

    # J oscillation frequency (0-25 pts)
    if j_extreme_pct >= 30:   score += 25
    elif j_extreme_pct >= 20: score += 18
    elif j_extreme_pct >= 10: score += 10
    elif j_extreme_pct >= 5:  score += 5

    # Reversal success rate (0-30 pts)
    if avg_reversal_rate >= 70:   score += 30
    elif avg_reversal_rate >= 60: score += 22
    elif avg_reversal_rate >= 50: score += 14
    elif avg_reversal_rate >= 40: score += 7

    # J extreme duration — shorter is better for clean entries (0-15 pts)
    if avg_extreme_duration <= 2:   score += 15
    elif avg_extreme_duration <= 4: score += 10
    elif avg_extreme_duration <= 7: score += 5

    # Mean reversion speed — faster is better (0-15 pts)
    if avg_reversion_speed is not None:
        if avg_reversion_speed <= 3:   score += 15
        elif avg_reversion_speed <= 6: score += 10
        elif avg_reversion_speed <= 10: score += 5

    # MA30 bounce rate (0-15 pts)
    if ma30_bounce_rate >= 65:   score += 15
    elif ma30_bounce_rate >= 55: score += 10
    elif ma30_bounce_rate >= 45: score += 5

    # ── RATING ────────────────────────────────────────────────────────────────

    if score >= 75:   rating = "EXCELLENT"
    elif score >= 55: rating = "GOOD"
    elif score >= 35: rating = "FAIR"
    else:             rating = "POOR"

    return {
        "timeframe":            tf_label,
        "candles":              n,
        "price_now":            round(float(close.iloc[-1]), 6),

        # J oscillation
        "j_ob_count":           j_ob_count,
        "j_os_count":           j_os_count,
        "j_extreme_pct":        j_extreme_pct,
        "avg_extreme_duration": avg_extreme_duration,
        "max_extreme_duration": max_extreme_duration,

        # Reversal success
        "ob_reversals_total":   ob_reversals_total,
        "ob_reversal_rate":     ob_reversal_rate,
        "os_reversals_total":   os_reversals_total,
        "os_reversal_rate":     os_reversal_rate,
        "avg_reversal_rate":    avg_reversal_rate,

        # Mean reversion
        "avg_reversion_speed":  avg_reversion_speed,

        # MA bounce
        "ma30_touches":         total_touches,
        "ma30_bounce_rate":     ma30_bounce_rate,

        # Volatility
        "avg_atr_pct":          avg_atr_pct,
        "max_atr_pct":          max_atr_pct,

        # Liquidity
        "vol_mean":             round(vol_mean, 2),
        "vol_cv":               vol_cv,

        # Score
        "bounce_score":         score,
        "bounce_rating":        rating,
    }


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 65)
    print("  HL BOUNCE RESEARCH — pair suitability analysis")
    print("=" * 65)

    results = {}

    for symbol in ALL_PAIRS:
        print(f"\n[{symbol}] analyzing...")
        results[symbol] = {
            "is_current_pair": symbol in PAIRS,
            "timeframes": {}
        }

        for tf_key, tf_cfg in TIMEFRAMES.items():
            print(f"  → {tf_key}...", end=" ", flush=True)
            df    = fetch_candles(symbol, tf_cfg["interval"], tf_cfg["limit"])
            stats = analyze_bounce(df, tf_key)
            results[symbol]["timeframes"][tf_key] = stats

            if "error" not in stats:
                print(f"✓  score={stats['bounce_score']}  "
                      f"reversal={stats['avg_reversal_rate']}%  "
                      f"J_freq={stats['j_extreme_pct']}%  "
                      f"rating={stats['bounce_rating']}")
            else:
                print(f"✗ {stats['error']}")

            time.sleep(0.4)  # rate limit protection

        # Compute overall score as weighted average across timeframes
        scores = []
        for tf_key in TIMEFRAMES:
            d = results[symbol]["timeframes"].get(tf_key, {})
            if "bounce_score" in d:
                weight = {"5m": 0.25, "15m": 0.35, "1h": 0.40}[tf_key]
                scores.append(d["bounce_score"] * weight)

        overall = round(sum(scores), 1) if scores else 0
        if overall >= 75:   overall_rating = "EXCELLENT"
        elif overall >= 55: overall_rating = "GOOD"
        elif overall >= 35: overall_rating = "FAIR"
        else:               overall_rating = "POOR"

        results[symbol]["overall_score"]  = overall
        results[symbol]["overall_rating"] = overall_rating
        print(f"  OVERALL: {overall}/100 — {overall_rating}")

    # ── RANKING ───────────────────────────────────────────────────────────────

    ranked = sorted(
        results.items(),
        key=lambda x: x[1].get("overall_score", 0),
        reverse=True
    )

    print("\n" + "=" * 65)
    print("  BOUNCE PAIR RANKING")
    print("=" * 65)
    print(f"{'RANK':<5} {'PAIR':<8} {'SCORE':<8} {'RATING':<12} {'CURRENT'}")
    print("-" * 65)
    for rank, (sym, data) in enumerate(ranked, 1):
        is_current = "✓ current" if data["is_current_pair"] else "  candidate"
        print(f"{rank:<5} {sym:<8} {data['overall_score']:<8} "
              f"{data['overall_rating']:<12} {is_current}")

    # ── RECOMMENDATIONS ───────────────────────────────────────────────────────

    print("\n" + "=" * 65)
    print("  RECOMMENDATIONS")
    print("=" * 65)

    keep      = [s for s, d in ranked if d["is_current_pair"] and d["overall_score"] >= 55]
    drop      = [s for s, d in ranked if d["is_current_pair"] and d["overall_score"] < 35]
    add       = [s for s, d in ranked if not d["is_current_pair"] and d["overall_score"] >= 55]
    excellent = [s for s, d in ranked if d["overall_score"] >= 75]

    print(f"\nKEEP (current, good bounce):  {' '.join(keep) if keep else 'none'}")
    print(f"DROP (current, poor bounce):  {' '.join(drop) if drop else 'none'}")
    print(f"ADD  (new candidates):        {' '.join(add[:5]) if add else 'none'}")
    print(f"EXCELLENT bounce pairs:       {' '.join(excellent) if excellent else 'none'}")

    # ── JSON OUTPUT ───────────────────────────────────────────────────────────

    json_path = "bounce_research.json"
    with open(json_path, "w") as f:
        json.dump({"pairs": dict(ranked), "ranking": [s for s, _ in ranked]}, f, indent=2)
    print(f"\n✓ JSON saved → {json_path}")

    # ── CSV OUTPUT ────────────────────────────────────────────────────────────

    csv_path = "bounce_research.csv"
    rows = []
    for sym, data in ranked:
        for tf_key, stats in data["timeframes"].items():
            if "error" not in stats:
                row = {
                    "symbol":        sym,
                    "is_current":    data["is_current_pair"],
                    "overall_score": data["overall_score"],
                    "overall_rating":data["overall_rating"],
                    "timeframe":     tf_key,
                }
                row.update(stats)
                rows.append(row)

    if rows:
        with open(csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"✓ CSV saved → {csv_path}")

    print("\n" + "=" * 65)
    print("  DONE — load bounce_research.json into the dashboard")
    print("=" * 65)


if __name__ == "__main__":
    main()
