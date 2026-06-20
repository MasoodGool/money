"""Deterministic signal tests for BaselineTrendV2.

As with V1, we drive populate_entry_trend / populate_exit_trend directly with
hand-placed indicator columns (including the merged daily `ema50_1d`) so the
regime filter, widened RSI band, and regime-breakdown exit are asserted on
exact rows — no look-ahead, no dependence on the informative merge.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from freqtrade.enums import CandleType

STRAT_DIR = Path(__file__).resolve().parents[1] / "bot" / "user_data" / "strategies"
sys.path.insert(0, str(STRAT_DIR))

from baseline_trend_v2 import BaselineTrendV2  # noqa: E402


@pytest.fixture
def strat():
    # @informative makes __init__ read candle_type_def from config.
    return BaselineTrendV2({"candle_type_def": CandleType.SPOT})


def _frame(rows: dict) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["date"] = pd.date_range("2024-01-01", periods=len(df), freq="4h", tz="UTC")
    return df


def test_entry_fires_on_cross_when_daily_regime_is_up(strat):
    # ema20 crosses above ema50 at row 2; daily regime up (close > ema50_1d).
    df = _frame(
        {
            "ema20": [10, 11, 13, 14],
            "ema50": [12, 12, 12, 12],
            "rsi": [55, 55, 55, 55],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50],
            "close": [100, 100, 100, 100],
            "ema50_1d": [90, 90, 90, 90],  # close (100) > daily EMA50 -> up
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 0]


def test_daily_downtrend_blocks_entry_at_the_cross(strat):
    # Same clean cross, but price is below the daily EMA50 -> regime filter
    # vetoes the entry (this is the V1 whipsaw the filter is meant to kill).
    df = _frame(
        {
            "ema20": [10, 11, 13, 14],
            "ema50": [12, 12, 12, 12],
            "rsi": [55, 55, 55, 55],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50],
            "close": [100, 100, 100, 100],
            "ema50_1d": [110, 110, 110, 110],  # close (100) < daily EMA50 -> down
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).sum() == 0


def test_widened_rsi_band_allows_momentum_entries(strat):
    # RSI 70 was blocked by V1's 45–65 band; V2 (45–75) allows it.
    df = _frame(
        {
            "ema20": [10, 11, 13, 14],
            "ema50": [12, 12, 12, 12],
            "rsi": [70, 70, 70, 70],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50],
            "close": [100, 100, 100, 100],
            "ema50_1d": [90, 90, 90, 90],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 0]
    # …but a blown-off RSI of 80 is still rejected. Use a fresh frame:
    # populate_entry_trend mutates in place, so reusing `df` would carry over
    # the enter_long set above.
    df2 = _frame(
        {
            "ema20": [10, 11, 13, 14],
            "ema50": [12, 12, 12, 12],
            "rsi": [80, 80, 80, 80],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50],
            "close": [100, 100, 100, 100],
            "ema50_1d": [90, 90, 90, 90],
        }
    )
    out2 = strat.populate_entry_trend(df2, {"pair": "BTC/USDT"})
    assert out2["enter_long"].fillna(0).sum() == 0


def test_exit_fires_when_daily_regime_breaks_down(strat):
    # Exit when price closes back below the daily EMA50 on rows 2–3.
    df = _frame(
        {
            "close": [100, 100, 80, 80],
            "ema50_1d": [90, 90, 90, 90],
        }
    )
    out = strat.populate_exit_trend(df, {"pair": "BTC/USDT"})
    assert out["exit_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 1]


def test_no_signals_on_flat_or_nan(strat):
    flat = _frame(
        {
            "ema20": [12.0] * 6,
            "ema50": [12.0] * 6,
            "rsi": [55] * 6,
            "volume": [100] * 6,
            "volume_mean_20": [50] * 6,
            "close": [100] * 6,
            "ema50_1d": [90] * 6,
        }
    )
    assert strat.populate_entry_trend(flat.copy(), {"pair": "BTC/USDT"})["enter_long"].fillna(0).sum() == 0

    nan_row = _frame(
        {
            "ema20": [np.nan, 11, 13, 14],
            "ema50": [np.nan, 12, 12, 12],
            "rsi": [np.nan, 55, 55, 55],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [np.nan, 50, 50, 50],
            "close": [100, 100, 100, 100],
            "ema50_1d": [90, 90, 90, 90],
        }
    )
    out = strat.populate_entry_trend(nan_row, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 0]
