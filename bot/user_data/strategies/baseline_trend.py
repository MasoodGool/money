"""BaselineTrend — the honest, deliberately-simple Phase 1 strategy.

The deliverable in Phase 1 is the *validation pipeline*, not alpha. This
strategy is allowed to lose; it exists so the backtest discipline, the
signal unit tests, and the freqtrade -> Concierge execution path all have
something real to chew on.

Rules (4h timeframe):
  Entry (long): EMA(20) crosses above EMA(50)
                AND RSI(14) in [45, 65]
                AND volume > its 20-period average
  Exit:         EMA(20) crosses below EMA(50)  (plus ROI table / stoploss)

No look-ahead: every indicator is computed from closed candles only, and
crosses are detected with qtpylib (which compares the current value against
the immediately prior one — never a future bar).
"""

from pandas import DataFrame
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib

from freqtrade.strategy import IStrategy


class BaselineTrend(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = False

    # Conservative ROI table: 8% immediately, decaying to 4% after 24h and
    # 2% after 48h (freqtrade keys are minutes).
    minimal_roi = {
        "0": 0.08,
        "1440": 0.04,
        "2880": 0.02,
    }

    # Fixed -5% protective stop.
    stoploss = -0.05

    # Trade only on closed candles; never act on the still-forming bar.
    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False

    # EMA(50) + the 20-period volume mean need history before signals are
    # trustworthy; ask freqtrade for enough warmup candles.
    startup_candle_count = 60

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        # Rolling mean of the *prior* closed candles' volume (no future leak).
        dataframe["volume_mean_20"] = dataframe["volume"].rolling(window=20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Named boolean columns so the conditions are auditable and testable.
        dataframe["ema_cross_up"] = qtpylib.crossed_above(
            dataframe["ema20"], dataframe["ema50"]
        )
        dataframe["rsi_ok"] = (dataframe["rsi"] >= 45) & (dataframe["rsi"] <= 65)
        dataframe["volume_ok"] = dataframe["volume"] > dataframe["volume_mean_20"]

        dataframe.loc[
            (
                dataframe["ema_cross_up"]
                & dataframe["rsi_ok"]
                & dataframe["volume_ok"]
                & (dataframe["volume"] > 0)  # guard against dead/halted candles
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema_cross_down"] = qtpylib.crossed_below(
            dataframe["ema20"], dataframe["ema50"]
        )
        dataframe.loc[dataframe["ema_cross_down"], "exit_long"] = 1
        return dataframe
