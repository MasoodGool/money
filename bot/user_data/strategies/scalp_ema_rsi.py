"""ScalpEmaRsi — an aggressive high-frequency day-trading premise (15m).

This is the "aggressive day trading" flavor: a fast momentum scalp on the 15m
timeframe with tight targets and a tight stop, so it trades often and holds
briefly. It exists to be TESTED honestly, not because frequency is expected
to win — the whole point is to let the backtest show how the fee+slippage
drag (0.13%/side here) eats a high-frequency strategy alive.

Caveats to keep in mind when reading its backtest:
  - Low-timeframe backtests are the least trustworthy (optimistic fills,
    understated slippage). Run `lookahead-analysis` and treat results with
    extra suspicion.
  - Needs 15m data: `scripts/download-data.sh` now fetches it.
  - Backtest with TIMEFRAME unset (uses the 15m below) or TIMEFRAME=15m.

Indicators use closed candles only; no look-ahead.
"""

from pandas import DataFrame
import talib.abstract as ta

from freqtrade.strategy import IStrategy


class ScalpEmaRsi(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "15m"
    can_short = False

    # Scalp: grab a small move fast, then decay the target to flat.
    minimal_roi = {"0": 0.02, "30": 0.01, "60": 0.005, "120": 0}
    stoploss = -0.02

    process_only_new_candles = True
    use_exit_signal = True
    startup_candle_count = 50

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["volume_mean_20"] = dataframe["volume"].rolling(window=20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["fast_up"] = dataframe["ema9"] > dataframe["ema21"]
        # Momentum building but not yet overbought.
        dataframe["momentum"] = (dataframe["rsi"] > 50) & (dataframe["rsi"] < 70)
        dataframe["volume_ok"] = dataframe["volume"] > dataframe["volume_mean_20"]
        dataframe.loc[
            (
                dataframe["fast_up"]
                & dataframe["momentum"]
                & dataframe["volume_ok"]
                & (dataframe["close"] > dataframe["ema9"])
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Fast momentum flip; ROI/stop are the primary scalp exits.
        dataframe.loc[dataframe["ema9"] < dataframe["ema21"], "exit_long"] = 1
        return dataframe
