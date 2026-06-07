import os

PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "SUI", "NEAR", "OP", "APT", "LINK", "ZEC", "ARB"]

SCAN_INTERVAL_SECONDS  = 20
PRICE_INTERVAL_SECONDS = 1

TC_ADX_MIN     = 30
DEPTH_GATE_PCT = 60

ACCOUNT_BALANCE         = 10000
MARGIN_PER_TRADE        = 2000
MAX_SIMULTANEOUS_TRADES = 2
MARGIN_HARD_CAP_USDC    = 25000
DEFAULT_LEVERAGE        = 10

PAPER_MODE = os.getenv("PAPER_MODE", "true").strip().lower() != "false"

COOLDOWN_SECONDS      = 3600
CONSECUTIVE_LOSS_STOP = 3
DAILY_LOSS_LIMIT      = -500

SL_PCT           = 0.03       # 3% fixed stop loss
SL_HALF_PCT      = 0.006      # 0.6% — 50% partial stop distance
TP1_MULTIPLIER   = 1.5        # 1.5R
TP2_MULTIPLIER   = 2.5        # 2.5R
TP3_MULTIPLIER   = 4.0        # 4.0R (HIGH_PROB only)
TRAILING_TP_PCT  = 0.0025     # 0.25% trailing from extreme

LEVERAGE_TIER1 = 10
LEVERAGE_TIER2 = 15
LEVERAGE_TIER3 = 25

BTC_REGIME_FILTER_ENABLED = True

UNIVERSE_SCAN_ENABLED = False

PAIR_ADX_OVERRIDES = {"NEAR": 42, "SUI": 40}

STALE_ALERT_SECONDS = 5400    # 90 minutes

HL_API_URL = "https://api.hyperliquid.xyz/info"
