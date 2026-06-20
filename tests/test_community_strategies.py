"""Deterministic signal tests for the alternative-premise strategies.

DonchianBreakout (breakout) and RsiPullback (dip-buy-in-uptrend) are driven
directly with hand-placed indicator columns so the entry/exit logic is
asserted on exact rows. (BbandRsi is community code tested by load + backtest,
not unit-tested here.)
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

STRAT_DIR = Path(__file__).resolve().parents[1] / "bot" / "user_data" / "strategies"
sys.path.insert(0, str(STRAT_DIR))

from donchian_breakout import DonchianBreakout  # noqa: E402
from rsi_pullback import RsiPullback  # noqa: E402
from scalp_ema_rsi import ScalpEmaRsi  # noqa: E402


def _frame(rows: dict) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["date"] = pd.date_range("2024-01-01", periods=len(df), freq="4h", tz="UTC")
    return df


# --- DonchianBreakout ---------------------------------------------------------

def test_breakout_enters_above_prior_channel_high_with_volume():
    strat = DonchianBreakout({})
    df = _frame(
        {
            # close breaks above the prior-channel high (dc_upper) at row 2.
            "close": [100, 100, 111, 100],
            "dc_upper": [110, 110, 110, 110],
            "dc_lower": [90, 90, 90, 90],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 0]


def test_breakout_needs_volume_confirmation():
    strat = DonchianBreakout({})
    df = _frame(
        {
            "close": [100, 100, 111, 100],
            "dc_upper": [110, 110, 110, 110],
            "dc_lower": [90, 90, 90, 90],
            "volume": [100, 100, 40, 100],  # thin volume at the break
            "volume_mean_20": [50, 50, 50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).sum() == 0


def test_breakout_exits_below_lower_channel():
    strat = DonchianBreakout({})
    df = _frame({"close": [100, 100, 89, 100], "dc_lower": [90, 90, 90, 90]})
    out = strat.populate_exit_trend(df, {"pair": "BTC/USDT"})
    assert out["exit_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 0]


# --- RsiPullback --------------------------------------------------------------

def test_pullback_buys_oversold_only_in_uptrend():
    strat = RsiPullback({})
    df = _frame(
        {
            "close": [100, 100, 100],
            "ema200": [90, 90, 110],   # uptrend on rows 0–1, downtrend on row 2
            "rsi": [30, 50, 30],       # oversold on rows 0 and 2
            "volume": [100, 100, 100],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    # Row 0: uptrend + oversold -> enter. Row 1: not oversold. Row 2: oversold
    # but NOT an uptrend (price below EMA200) -> blocked.
    assert out["enter_long"].fillna(0).astype(int).tolist() == [1, 0, 0]


def test_pullback_exits_when_rsi_recovers():
    strat = RsiPullback({})
    df = _frame({"close": [100, 100], "ema200": [90, 90], "rsi": [60, 70], "volume": [1, 1]})
    out = strat.populate_exit_trend(df, {"pair": "BTC/USDT"})
    assert out["exit_long"].fillna(0).astype(int).tolist() == [0, 1]


# --- ScalpEmaRsi (aggressive day-trading, 15m) --------------------------------

def test_scalp_enters_on_fast_momentum_with_volume():
    strat = ScalpEmaRsi({})
    df = _frame(
        {
            "ema9": [100, 100],
            "ema21": [99, 101],         # fast-up only on row 0
            "rsi": [55, 55],            # in the 50–70 momentum band
            "close": [101, 101],        # above ema9
            "volume": [100, 100],
            "volume_mean_20": [50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    # Row 0: ema9>ema21, rsi in band, vol ok, close>ema9 -> enter.
    # Row 1: ema9<ema21 -> no.
    assert out["enter_long"].fillna(0).astype(int).tolist() == [1, 0]


def test_scalp_blocks_when_overbought_or_thin_volume():
    strat = ScalpEmaRsi({})
    df = _frame(
        {
            "ema9": [100, 100],
            "ema21": [99, 99],
            "rsi": [75, 55],            # row 0 overbought; row 1 ok…
            "close": [101, 101],
            "volume": [100, 40],        # …but row 1 has thin volume
            "volume_mean_20": [50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).sum() == 0
