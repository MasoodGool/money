"""RsiPullback — buy dips inside an uptrend (mean-reversion *within* trend).

A third distinct premise: instead of chasing breakouts or crossovers, only
buy when the long-term trend is up (price above the 200-EMA) AND price has
pulled back to oversold (RSI < 35). The idea is to buy fear in an otherwise
healthy uptrend and exit as it mean-reverts (RSI > 65) or via ROI/stop.

Textbook approach written cleanly (no inherited overfitting). Indicators use
closed candles only; no look-ahead.
"""

from pandas import DataFrame
import talib.abstract as ta

from freqtrade.strategy import IStrategy


class RsiPullback(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = False

    # Quick mean-reversion targets, decaying over time.
    minimal_roi = {"0": 0.10, "720": 0.05, "1440": 0.02}
    stoploss = -0.06

    process_only_new_candles = True
    use_exit_signal = True
    # 200-EMA warmup.
    startup_candle_count = 250

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema200"] = ta.EMA(dataframe, timeperiod=200)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["uptrend"] = dataframe["close"] > dataframe["ema200"]
        dataframe["oversold"] = dataframe["rsi"] < 35
        dataframe.loc[
            (
                dataframe["uptrend"]
                & dataframe["oversold"]
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Mean-reverted: RSI back to overbought-ish. ROI/stop are the backstops.
        dataframe.loc[dataframe["rsi"] > 65, "exit_long"] = 1
        return dataframe
