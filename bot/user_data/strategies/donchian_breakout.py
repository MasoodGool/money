"""DonchianBreakout — a clean BREAKOUT premise (different from EMA-cross).

The recurring lesson from BaselineTrend V1/V2 was that an EMA crossover is a
*lagging* entry with no edge. A Donchian breakout is a genuinely different
hypothesis: enter when price closes above the highest high of the last N
candles — i.e. it makes a new N-period high — and ride it with a trailing
stop (the one mechanic from V2 that demonstrably worked on winners).

No look-ahead: the channel is computed over the PRIOR N candles
(`.shift(1)`), so a "breakout" is measured against history that excludes the
current bar. Standard, textbook Donchian — not copied from a specific repo,
so there's no inherited overfitting to a particular backtest window.
"""

from pandas import DataFrame

from freqtrade.strategy import IStrategy


class DonchianBreakout(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = False

    # Far ROI backstop; the trailing stop is the real exit so winners run.
    minimal_roi = {"0": 0.30}
    stoploss = -0.08
    trailing_stop = True
    trailing_stop_positive = 0.04
    trailing_stop_positive_offset = 0.08
    trailing_only_offset_is_reached = True

    process_only_new_candles = True
    use_exit_signal = True
    startup_candle_count = 60

    # Channel length (candles). 20 * 4h ≈ 3.3 days of range.
    channel = 20

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Highest high / lowest low over the PRIOR `channel` candles. shift(1)
        # excludes the current bar -> a break is genuinely vs. closed history.
        dataframe["dc_upper"] = dataframe["high"].rolling(self.channel).max().shift(1)
        dataframe["dc_lower"] = dataframe["low"].rolling(self.channel).min().shift(1)
        dataframe["volume_mean_20"] = dataframe["volume"].rolling(20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["close"] > dataframe["dc_upper"])
                & (dataframe["volume"] > dataframe["volume_mean_20"])
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Trend failure: price breaks the lower channel. Winners are otherwise
        # ridden out by the trailing stop.
        dataframe.loc[dataframe["close"] < dataframe["dc_lower"], "exit_long"] = 1
        return dataframe
