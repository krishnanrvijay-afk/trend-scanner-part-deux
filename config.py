import os

PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "SUI", "NEAR", "OP", "APT", "LINK", "ZEC", "ARB"]

SCAN_INTERVAL_SECONDS = 20
PRICE_INTERVAL_SECONDS = 1

ALERT_THRESHOLD = 8
TC_MIN_SCORE = 3
TC_ADX_MIN = 30
DEPTH_GATE_PCT = 60

J5_LONG_GATE = 20
J5_SHORT_GATE = 80

MARGIN_HARD_CAP_USDC = 25000
DEFAULT_MARGIN_USDC = 700
DEFAULT_LEVERAGE = 10

PAPER_MODE = os.getenv("PAPER_MODE", "true").strip().lower() != "false"

SESSION_BONUSES = {
    "EU": 0.5,
    "US": 0.5,
    "ASIA": 0.0,
}

COOLDOWN_SECONDS = 3600  # 60 minutes after trade close

# ── Phase 2: 5m pullback entry timing ────────────────────────────────────────
ENTRY_PULLBACK_RSI_SHORT = 55   # cross above then back below triggers SHORT entry
ENTRY_PULLBACK_RSI_LONG  = 45   # cross below then back above triggers LONG entry
ENTRY_TIMEOUT_MINUTES    = 60   # market-entry fallback if no pullback within 60 min

# ── Fixed-percentage SL / TP ──────────────────────────────────────────────────
SL_PCT           = 0.03   # 3.0% stop loss from entry
TP1_R_MULTIPLIER = 1.5    # TP1 at 1.5 × SL distance (4.5%)
TP2_R_MULTIPLIER = 2.0    # TP2 at 2.0 × SL distance (6.0%)

# ── Circuit breaker ───────────────────────────────────────────────────────────
CONSECUTIVE_LOSS_STOP = 5  # pause auto-entry after this many consecutive SL hits

# ── Trailing TP (active after TP1 hit) ───────────────────────────────────────
TRAILING_TP_PCT = 0.0015   # 0.15% trail from extreme price since TP1

# ── Dynamic leverage tiers ────────────────────────────────────────────────────
LEVERAGE_TIER_HIGH = 10   # ADX >= 60 AND score == 7
LEVERAGE_TIER_MID  = 8    # ADX >= 50 AND score >= 6
LEVERAGE_TIER_LOW  = 6    # all other cases

# ── Universe scanner ──────────────────────────────────────────────────────────
UNIVERSE_SCAN_ENABLED = False  # Universe scanner disabled — reintroduce in Phase 2
PROMOTED_SLOTS = 3
ROTATION_WINDOW_MINUTES = 120
UNIVERSE_SCAN_INTERVAL_MINUTES = 5
UNIVERSE_VOLUME_MIN_USD = 50_000_000
UNIVERSE_OI_MIN_USD = 10_000_000
UNIVERSE_FUNDING_MIN_ABS = 0.005
UNIVERSE_VOLUME_FALLBACK_MULTIPLIER = 0.5

HL_API_URL = "https://api.hyperliquid.xyz/info"
