"""BaselineTrendV2 — structural fixes after V1 failed the graduation bar.

V1's post-mortem: it lost money in BOTH a +58% bull market (in-sample) and a
-41% bear (out-of-sample). The mechanism was a backwards risk/reward —
ROI-capped winners (small) vs. a laggy EMA-cross exit + stop producing bigger
losers. Win rate ~50% but average loss > average win => negative expectancy.

The three changes here target exactly that:

  1. REGIME FILTER (cut whipsaws): only go long when the *daily* trend is up
     (price above the 1d EMA50). This kills the chop-driven exit_signal
     losses V1 suffered on SOL/ETH.

  2. LET WINNERS RUN (fix the asymmetry): replace V1's tight ROI cap +
     laggy EMA-cross exit with a TRAILING STOP. Winners ride the trend and
     only exit on a pullback from the peak; the ROI is a far backstop only.

  3. WIDER UNIVERSE (significance): the whitelist grows to 12 liquid pairs so
     a more selective strategy can still clear the >= 30-trade bar.

No look-ahead: 4h indicators use closed candles; the daily regime comes via
freqtrade's @informative merge, which shifts the daily series so only the
last CLOSED daily candle is visible on each 4h bar. (Recommended: confirm
with `freqtrade lookahead-analysis` before trusting the result.)
"""

from pandas import DataFrame
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib

from freqtrade.strategy import IStrategy, informative


class BaselineTrendV2(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = False

    # Far ROI backstop only — the trailing stop is the real profit-taker, so
    # winners are no longer capped at a small fixed target.
    minimal_roi = {"0": 0.20}

    # Initial disaster stop; the trailing stop takes over once in profit.
    stoploss = -0.06
    trailing_stop = True
    trailing_stop_positive = 0.03           # trail 3% below the peak …
    trailing_stop_positive_offset = 0.06    # … once the trade is +6% up
    trailing_only_offset_is_reached = True

    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False

    # Enough 4h history to warm up the 1d EMA50 (50 daily candles ~ 300 4h
    # bars) plus the 4h indicators, with margin.
    startup_candle_count = 500

    @informative("1d")
    def populate_indicators_1d(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Daily trend gauge. Merged into the 4h frame as `ema50_1d`, shifted
        # by freqtrade so it reflects only closed daily candles.
        dataframe["ema50"] = ta.EMA(dataframe, timeperiod=50)
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["volume_mean_20"] = dataframe["volume"].rolling(window=20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema_cross_up"] = qtpylib.crossed_above(
            dataframe["ema20"], dataframe["ema50"]
        )
        # Widened from V1's 45–65: with a regime filter in place we no longer
        # need to fear momentum, just avoid fully blown-off entries.
        dataframe["rsi_ok"] = (dataframe["rsi"] >= 45) & (dataframe["rsi"] <= 75)
        dataframe["volume_ok"] = dataframe["volume"] > dataframe["volume_mean_20"]
        # Regime gate: only long while price is above the daily EMA50.
        dataframe["regime_up"] = dataframe["close"] > dataframe["ema50_1d"]

        dataframe.loc[
            (
                dataframe["ema_cross_up"]
                & dataframe["rsi_ok"]
                & dataframe["volume_ok"]
                & dataframe["regime_up"]
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Winners are ridden by the trailing stop; this only bails when the
        # daily uptrend that justified the entry breaks down (price closes
        # back below the daily EMA50). Faster and cleaner than V1's 4h cross.
        dataframe["regime_down"] = dataframe["close"] < dataframe["ema50_1d"]
        dataframe.loc[dataframe["regime_down"], "exit_long"] = 1
        return dataframe
