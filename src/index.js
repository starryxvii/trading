// src/index.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { fetchHistorical, fetchLatestCandle } from './data/yahoo.js';
import { backtest } from './backtest/engine.js';
import { ultraSignalFactory } from './strategy/ultra/index.js';
import { smcSignalFactory } from './strategy/smc.js';
import { positionSize } from './risk/positionSizing.js';
import { PaperBroker } from './broker/paper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- config ----------
function loadConfig() {
  const p = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(p)) throw new Error('Create config.json (see config.example.json)');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildSignal(cfg) {
  const strat = (cfg.strategy || 'ultra').toLowerCase();
  if (strat === 'ultra') return ultraSignalFactory({ ...cfg.ultra });
  if (strat === 'smc')   return smcSignalFactory({ ...cfg.smc, session: cfg.session, debug: cfg.debug });
  return ultraSignalFactory({ ...cfg.ultra });
}

// ---------- backtest ----------
async function runBacktest(argv, cfg) {
  const symbol   = argv['--symbol']   || cfg.symbol || 'BTC-USD';
  const interval = argv['--interval'] || cfg.interval;
  const period   = argv['--period']   || cfg.period;

  const candles = await fetchHistorical(symbol, interval, period);
  const signal  = buildSignal(cfg);

  const results = backtest({
    candles, symbol,
    equity:   cfg.equity,
    riskPct:  cfg.riskPct,
    rr:       cfg.rr,
    signal,
    report:   cfg.report,
    interval, range: period,

    // costs & mgmt
    slippageBps: cfg.slippageBps,
    feeBps:      cfg.feeBps,

    // scaling & targets
    scaleOutAtR: cfg.scaleOutAtR,
    scaleOutFrac: cfg.scaleOutFrac,
    finalTP_R:   cfg.finalTP_R,

    // daily risk
    maxDailyLossPct: cfg.maxDailyLossPct,

    // trails
    atrTrailMult:   cfg.atrTrailMult ?? 0,
    atrTrailPeriod: cfg.atrTrailPeriod ?? 14,
    mfeTrail:       cfg.mfeTrail ?? { enabled: false },

    // position mgmt
    pyramiding: cfg.pyramiding ?? { enabled: false },
    volScale:   cfg.volScale   ?? { enabled: false },

    // entry/exit behavior
    oco:          cfg.oco,
    triggerMode:  cfg.triggerMode,
    flattenAtClose: cfg.flattenAtClose,

    // backtest policy
    dailyMaxTrades:        cfg?.backtest?.dailyMaxTrades ?? 0,
    postLossCooldownBars:  cfg?.backtest?.postLossCooldownBars ?? 0,
    entryChase:            cfg?.backtest?.entryChase ?? { enabled: true, afterBars: 2, maxSlipR: 0.12, convertOnExpiry: true },

    // sizing limits
    qtyStep:     cfg?.position?.qtyStep ?? 0.001,
    minQty:      cfg?.position?.minQty  ?? 0.001,
    maxLeverage: cfg?.position?.maxLeverage ?? 2.0
  });

  const m = results.metrics;
  console.log('\n=== Backtest Summary ===');
  const fmt2 = x => (x === Infinity ? 'Inf' : Number.isFinite(x) ? x.toFixed(2) : '—');
  const fmt3 = x => (x === Infinity ? 'Inf' : Number.isFinite(x) ? x.toFixed(3) : '—');

  console.table({
    Symbol:         symbol,
    Trades:         m.trades,
    WinRate:        (m.winRate * 100).toFixed(1) + '%',
    ProfitFactor:   fmt2(m.profitFactor),
    Expectancy:     fmt2(m.expectancy),
    TotalR:         fmt2(m.totalR),
    AvgR:           fmt3(m.avgR),
    PnL:            fmt2(m.totalPnL),
    ReturnPct:      fmt2(m.returnPct * 100) + '%',
    MaxDDPct:       fmt2(m.maxDrawdownPct * 100) + '%',
    Calmar:         fmt2(m.calmar),
    Sharpe_tr:      fmt2(m.sharpePerTrade),
    Sortino_tr:     fmt2(m.sortinoPerTrade),
    AvgHoldMin:     fmt2(m.avgHoldMin),
    ExposurePct:    fmt2(m.exposurePct * 100) + '%',
    MaxWinStreak:   m.maxConsecWins,
    MaxLossStreak:  m.maxConsecLosses,
    StartEquity:    (m.finalEquity - m.totalPnL).toFixed(2),
    FinalEquity:    m.finalEquity.toFixed(2)
  });
}

// ---------- live (paper) ----------
async function runLive(argv, cfg) {
  const symbol   = argv['--symbol']   || cfg.symbol || 'BTC-USD';
  const interval = argv['--interval'] || cfg.interval;
  const rr       = cfg.rr;
  const riskPct  = cfg.riskPct;

  const broker = new PaperBroker({
    equity: cfg.equity,
    maxConcurrent: cfg.maxConcurrentTrades,
    maxHoldMin: cfg?.broker?.maxHoldMinLive ?? null,
    flattenWeekends: cfg?.broker?.flattenWeekends ?? false,
    flattenFridayHourUTC: cfg?.broker?.flattenFridayHourUTC ?? 21
  });

  const signal = buildSignal(cfg);

  let history = await fetchHistorical(symbol, interval, '5d');
  console.log(`[live] seeded candles: ${history.length}`);

  setInterval(async () => {
    try {
      const latest = await fetchLatestCandle(symbol, interval);
      if (!history.length || history[history.length - 1].time < latest.time) {
        history.push(latest);
      } else {
        history[history.length - 1] = latest;
      }

      const sig = signal({ candles: history });
      if (sig && !broker.hasOpenPosition(symbol)) {
        const size = positionSize({
          equity: broker.equity,
          entry: sig.entry,
          stop: sig.stop,
          riskFraction: riskPct / 100,
          qtyStep: cfg?.position?.qtyStep ?? 0.001,
          minQty:  cfg?.position?.minQty  ?? 0.001,
          maxLeverage: cfg?.position?.maxLeverage ?? 2.0
        });
        if (size > 0) {
          broker.open({
            symbol,
            ...sig,
            size,
            time: latest.time,
            maxHoldMin: sig._maxHoldMin ?? (cfg?.broker?.maxHoldMinLive ?? null)
          });
          console.log(`[live] open ${sig.side} @ ${sig.entry} SL ${sig.stop} TP ${sig.takeProfit} size ${size.toFixed(4)}`);
        }
      }

      broker.mark({ symbol, price: latest.close, time: latest.time });
    } catch (e) {
      console.error('[live] loop error', e.message);
    }
  }, cfg.pollMs || 15000);
}

// ---------- main ----------
(async () => {
  try {
    const cfg = loadConfig();
    const argv = process.argv.slice(2);
    const mode = argv[0] || 'backtest';
    const argobj = {};
    for (let i = 1; i < argv.length; i += 2) argobj[argv[i]] = argv[i + 1];

    if (mode === 'backtest') await runBacktest(argobj, cfg);
    else if (mode === 'live') await runLive(argobj, cfg);
    else throw new Error('Unknown mode. Use backtest|live');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
