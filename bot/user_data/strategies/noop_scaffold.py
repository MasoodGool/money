"""Phase 0 placeholder strategy.

Exists only so the dry-run container boots and the freqtrade -> Concierge
webhook plumbing can be exercised end to end. It never emits an entry
signal. Replaced by BaselineTrend in Phase 1.
"""

from pandas import DataFrame

from freqtrade.strategy import IStrategy


class NoopScaffold(IStrategy):
    """Does nothing, on purpose. The scaffold deliverable is the pipeline."""

    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = False

    # Effectively "never exit on ROI"; the strategy never enters anyway.
    minimal_roi = {"0": 100.0}
    stoploss = -0.99

    process_only_new_candles = True
    startup_candle_count = 0

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["enter_long"] = 0
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["exit_long"] = 0
        return dataframe
