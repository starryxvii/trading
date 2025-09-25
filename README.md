# Trading

## A fast, efficient algorithm that trades a price-action setup:
-	Imbalance (FVG) as the entry area
-	Liquidity sweep to set direction
-	Micro BOS for structure confirmation
-	Session windows / killzones to avoid dead hours
-	Simple risk/money management with OCO, scale-out, and optional trails

> Data is pulled from [yahoo-finance2](https://github.com/gadicc/yahoo-finance2). On a 5m time-frame, Yahoo caps historical data at 60d.
## Quick Start
### Prerequisites

```
cp config/config.example.json config/config.json
npm install
npm run backtest
```

Results print to the console; trades CSV goes to `output/` if enabled.

## Strategy explained

### 1) Time fences

	•	Only evaluates bars inside your killzones (per ET) and optional cash-session guard for stocks.
	•	First/last minute guards avoid open/close junk.

### 2) Bias (HTF filter)

	•	A higher-timeframe EMA/slope band sets a daily bias (long / short / neutral).
	•	With strict gating, neutral days are skipped unless you allow “strong setup over neutral”.

### 3) Setup

- 	Find a fresh imbalance (FVG) with a minimum size (in bps) and minimum body/ATR quality.

- 	Look for a sweep of a nearby level (Asia range, previous day’s H/L, session H/L, or a local swing). <sub> If sweep is missing and `requireSweepMode=prefer`, the bias can stand in as direction. </sub>

- 	Confirm micro BOS in the sweep direction over a short lookback (different lookback when `nosweep` is used).

### 4) The entry & stop
- 	Entry at the FVG edge (or adaptive/CE depending on `entryMode`).
- 	Initial stop sits outside the FVG, padded by `atrMult` * ATR.
`minStopBps` ensures stops aren’t too tight.
- 	Hard guards on slippage:
- 	`maxSlipROnFill` blocks opening if the slip would exceed X “planned R”.
-	Optional re-anchor stop on fill so the planned R stays intact even if entry chases.

### 5) The target (TP)
- 	Hybrid by default:
- 	First try a key level (nearest opposite Asia/PD/session/swing) if it offers at least `rrMinForKey` R.
- 	Otherwise fall back to fixed RR.

### 6) Trade management
- 	Breakeven at `breakevenAtR`.
- 	Optional 1R trail after `trailAfterR`.
- 	Optional MFE trail: arm after armR, give back givebackR R from the MFE.
- 	Optional ATR trail: `atrTrailMult` * ATR behind price.
- 	Scale-out once at `scaleOutAtR` for `scaleOutFrac`, then extend final TP to `finalTP_R`.
- 	Optional volatility cut: if ATR spikes vs entry ATR, trim size unless the trade is already far in profit.

### 7) Daily risk & hygiene
- 	Max daily loss (in % of equity) stops new trades for the day.
- 	Daily trade cap and post-loss cooldown.
- 	OCO logic for exits; pessimistic tie-break favors stops.

## Output
-	Console summary: trades, win rate, PnL, PF, expectancy, drawdown, Sharpe/Sortino per trade, average hold time, exposure, streaks.
-	Optional CSV: `output/trades_*.csv` with per-trade details.

## Install notes
-	Yahoo 5m data ≤ 60 days. The runner auto-caps requests so you don’t get blocked.
-	Crypto uses 24/7 killzones; stocks default to cash session + flatten at close (can be changed in config).

## Project layout (high level)

- `config/config.json` - your settings (copy from config.example.json)
- `src/index.js` - entry point (backtest/live)
- `src/backtest/engine.js` - backtest loop
- `src/backtest/core/*` - fills, OCO, metrics, csv
- `src/strat/main.js` - signal factory
- `src/strat/core/*` - bias, fvg, ranges, swings, presets, utils
- `src/utils/*` - indicators, logger, sizing, time
- `src/data/yahoo.js` - data loader
- `src/broker/paper.js` - simple paper broker (for live mode)

## Running with different symbols/intervals

You can change these in config.json (will use by default), or pass flags:
```
npm run backtest --symbol BTC-USD --interval 5m --period 60d
```

## Config
`config/config.json`:
- 	`mode`: `"backtest"` (this runner)
- 	`symbol`: e.g. `"BTC-USD"` (crypto) / `"AAPL"` (stocks). Symbols are based off of [Yahoo Finance](https://finance.yahoo.com/lookup/).
- 	`interval`: e.g. "5m"
-	`period`: history window (e.g. "60d" for 5m)
-	`equity`, `riskPct`, `rr`: account and base RR
-	`report`: `{ "exportCsv": true, "outDir": "output" }`
-	`oco` / `triggerMode` / `flattenAtClose`: exit behavior
-	`scaleOutAtR`, `scaleOutFrac`, `finalTP_R`: scaling behavior
-	`maxDailyLossPct`, `dailyMaxTrades`, `postLossCooldownBars`
-	`mfeTrail` / `atrTrail` / `volScale`: optional management
-	`position`: `qtyStep`, `minQty`, `maxLeverage`
-	`ultra`: strategy knobs (killzones, ATR/FVG thresholds, sweep/BOS, TP mode, etc.)

> Tip: for stocks, consider enabling `cashSessionGuard` and `flattenAtClose`.
For crypto, keep 24/7 and tune killzones to your preference.

## Common issues

-	**No trades:** thresholds too tight (e.g., `fvgMinBps`, `minBodyAtr`, `minAtrBps`), or windows exclude most time. Loosen a bit and try again.
-	**Too many tiny stops:** increase `minStopBps` or `atrMult`.
-	**Targets feel far:** lower `rrMinForKey` or switch `tpMode` to `"rr"`.

## License

MIT. Use at your own risk. Markets bite.