"""Deterministic signal tests for BaselineTrend.

We feed synthetic frames with hand-placed indicator values so we can assert
the entry/exit boolean columns fire on *exactly* the intended rows — and
never on a future-leaking one. populate_entry_trend / populate_exit_trend
read only the indicator columns, so the tests drive them directly with
known inputs rather than reverse-engineering a price series.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# Make the strategy importable without installing it as a package.
STRAT_DIR = Path(__file__).resolve().parents[1] / "bot" / "user_data" / "strategies"
sys.path.insert(0, str(STRAT_DIR))

from baseline_trend import BaselineTrend  # noqa: E402


@pytest.fixture
def strat():
    # Minimal config is enough: BaselineTrend uses no @informative methods and
    # no hyperopt params, so __init__ touches nothing exchange-specific.
    return BaselineTrend({})


def _frame(rows: dict) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["date"] = pd.date_range("2024-01-01", periods=len(df), freq="4h", tz="UTC")
    return df


def test_entry_fires_only_on_a_clean_cross_with_rsi_and_volume(strat):
    # ema20 crosses above ema50 at row 2; all gates open only there.
    df = _frame(
        {
            "ema20": [10, 11, 13, 14, 11],
            "ema50": [12, 12, 12, 12, 12],
            "rsi": [55, 55, 55, 55, 55],          # always in [45,65]
            "volume": [100, 100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50, 50],  # volume > mean everywhere
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    fired = out["enter_long"].fillna(0).astype(int).tolist()
    assert fired == [0, 0, 1, 0, 0]


def test_rsi_out_of_band_blocks_entry_at_the_cross(strat):
    df = _frame(
        {
            "ema20": [10, 11, 13, 14],
            "ema50": [12, 12, 12, 12],
            "rsi": [55, 55, 70, 55],  # 70 at the cross row -> blocked
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [50, 50, 50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).sum() == 0


def test_thin_volume_blocks_entry_at_the_cross(strat):
    df = _frame(
        {
            "ema20": [10, 11, 13, 14],
            "ema50": [12, 12, 12, 12],
            "rsi": [55, 55, 55, 55],
            "volume": [100, 100, 40, 100],     # below mean at the cross row
            "volume_mean_20": [50, 50, 50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    assert out["enter_long"].fillna(0).sum() == 0


def test_exit_fires_only_on_downward_cross(strat):
    # ema20 dips below ema50 at row 3.
    df = _frame(
        {
            "ema20": [14, 14, 13, 11, 10],
            "ema50": [12, 12, 12, 12, 12],
        }
    )
    out = strat.populate_exit_trend(df, {"pair": "BTC/USDT"})
    fired = out["exit_long"].fillna(0).astype(int).tolist()
    assert fired == [0, 0, 0, 1, 0]


def test_flat_market_produces_no_signals(strat):
    df = _frame(
        {
            "ema20": [12.0] * 10,
            "ema50": [12.0] * 10,
            "rsi": [55] * 10,
            "volume": [100] * 10,
            "volume_mean_20": [50] * 10,
        }
    )
    e = strat.populate_entry_trend(df.copy(), {"pair": "BTC/USDT"})
    x = strat.populate_exit_trend(df.copy(), {"pair": "BTC/USDT"})
    assert e["enter_long"].fillna(0).sum() == 0
    assert x["exit_long"].fillna(0).sum() == 0


def test_nan_indicators_do_not_fire(strat):
    # Warmup rows with NaN indicators must never produce a signal.
    df = _frame(
        {
            "ema20": [np.nan, 11, 13, 14],
            "ema50": [np.nan, 12, 12, 12],
            "rsi": [np.nan, 55, 55, 55],
            "volume": [100, 100, 100, 100],
            "volume_mean_20": [np.nan, 50, 50, 50],
        }
    )
    out = strat.populate_entry_trend(df, {"pair": "BTC/USDT"})
    # Row 0 is all-NaN warmup (no fire); a valid cross at row 2 still fires.
    assert out["enter_long"].fillna(0).astype(int).tolist() == [0, 0, 1, 0]


def test_indicators_use_only_closed_candles(strat):
    # 80 candles (enough warmup for EMA50) of rising volume; volume_mean_20
    # must be a *trailing* mean (no future leak) and NaN before 20 exist.
    n = 80
    df = _frame(
        {
            "open": np.linspace(100, 130, n),
            "high": np.linspace(101, 131, n),
            "low": np.linspace(99, 129, n),
            "close": np.linspace(100, 130, n),
            "volume": np.arange(1, n + 1, dtype=float),
        }
    )
    out = strat.populate_indicators(df, {"pair": "BTC/USDT"})

    # First 19 rolling means are undefined.
    assert out["volume_mean_20"].iloc[:19].isna().all()
    # Row 19 == trailing mean of volume[0..19] == mean(1..20) == 10.5.
    assert out["volume_mean_20"].iloc[19] == pytest.approx(10.5)
    # RSI/EMA populated after warmup.
    assert not np.isnan(out["ema50"].iloc[-1])
    assert not np.isnan(out["rsi"].iloc[-1])
