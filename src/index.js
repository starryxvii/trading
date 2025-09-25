// src/index.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { fetchHistorical, fetchLatestCandle } from "./data/yahoo.js";
import { backtest } from "./backtest/engine.js";
import { signalFactory } from "./strat/main.js";
import { positionSize } from "./utils/positionSizing.js";
import { PaperBroker } from "./broker/paper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- utils ----------------
function loadConfig() {
  const p = path.join(__dirname, "..", "config", "config.json");
  if (!fs.existsSync(p))
    throw new Error("Create config.json (see config.example.json)");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Guard: Yahoo 5m data is capped at 60d; keep user under that.
function capYahooRange(period, interval) {
  const asStr = String(period || "").trim();
  if (!asStr) return "60d";
  // Simple parser for forms like "60d", "30d", "3mo", etc.
  const m = asStr.match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (!m) return "60d";
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();

  // For 5m we hard-cap at 60d. (Yahoo’s practical max for 5m)
  if ((interval || "").toLowerCase() === "5m") {
    if (unit === "d" && n > 60) return "60d";
    // If user supplied months/years, snap to 60d for 5m
    if (unit !== "d") return "60d";
  }
  return asStr;
}

function inferAsset(symbol) {
  // very lightweight: crypto often looks like "BTC-USD", "ETH-USD"
  // You can override via config.asset
  return /-USD$/.test(symbol) ? "crypto" : "stocks";
}

function applyAssetDefaults(cfg, symbolFromArg) {
  const symbol = symbolFromArg || cfg.symbol || "BTC-USD";
  const asset = (cfg.asset || "").toLowerCase() || inferAsset(symbol);

  // clone to avoid mutating original cfg reference (use structuredClone if available)
  const deep = JSON.parse(JSON.stringify(cfg));
  deep._asset = asset; // keep a hint for logs

  // Ultra knobs that are sensible defaults per asset
  deep.ultra = deep.ultra || {};

  if (asset === "stocks") {
    // Trade only US cash session; avoid pre/after hours noise
    if (deep.ultra.useSessionWindows === undefined)
      deep.ultra.useSessionWindows = true;
    if (deep.ultra.cashSessionGuard === undefined)
      deep.ultra.cashSessionGuard = true;
    // Killzones (ET): avoid the open auction first minutes, focus on AM + PM
    if (!deep.ultra.killzones) deep.ultra.killzones = "09:35-11:30,13:30-15:55";
    if (deep.ultra.firstMinGuard === undefined) deep.ultra.firstMinGuard = 3;
    if (deep.ultra.lastMinGuard === undefined) deep.ultra.lastMinGuard = 3;

    // Slightly higher min stop and ATR floor for equities microstructure
    if (deep.ultra.minStopBps === undefined) deep.ultra.minStopBps = 12;
    if (deep.ultra.minAtrBps === undefined) deep.ultra.minAtrBps = 6.0;

    // Safer slip guard for thinner names
    if (deep.maxSlipROnFill === undefined) deep.maxSlipROnFill = 0.15;

    // Optional: flatten at close for stocks (leave configurable)
    if (deep.flattenAtClose === undefined) deep.flattenAtClose = true;
  } else {
    // Crypto defaults (24/7)
    if (deep.ultra.useSessionWindows === undefined)
      deep.ultra.useSessionWindows = true;
    if (!deep.ultra.killzones)
      deep.ultra.killzones = "02:00-05:00,07:00-11:00,13:00-16:00";
    if (deep.ultra.firstMinGuard === undefined) deep.ultra.firstMinGuard = 1;
    if (deep.ultra.lastMinGuard === undefined) deep.ultra.lastMinGuard = 1;

    if (deep.ultra.minStopBps === undefined) deep.ultra.minStopBps = 10;
    if (deep.ultra.minAtrBps === undefined) deep.ultra.minAtrBps = 5.0;

    if (deep.maxSlipROnFill === undefined) deep.maxSlipROnFill = 0.2;

    if (deep.flattenAtClose === undefined) deep.flattenAtClose = false;
  }

  return deep;
}

function buildSignal(cfg) {
  const strat = (cfg.strategy || "ultra").toLowerCase();
  if (strat === "ultra") return signalFactory({ ...cfg.ultra });
  return signalFactory({ ...cfg.ultra });
}

// ---------------- backtest ----------------
async function runBacktest(argv, cfg) {
  const symbolArg = argv["--symbol"];
  const cfg2 = applyAssetDefaults(cfg, symbolArg);
  const symbol = symbolArg || cfg2.symbol || "BTC-USD";
  const interval = argv["--interval"] || cfg2.interval || "5m";
  const rawPeriod = argv["--period"] || cfg2.period || "60d";
  const period = capYahooRange(rawPeriod, interval); // enforce <=60d for 5m

  const candles = await fetchHistorical(symbol, interval, period);
  const signal = buildSignal(cfg2);

  const results = backtest({
    candles,
    symbol,
    equity: cfg2.equity,
    riskPct: cfg2.riskPct,
    rr: cfg2.rr,
    signal,
    report: cfg2.report,
    interval,
    range: period,

    // costs & mgmt
    slippageBps: cfg2.slippageBps,
    feeBps: cfg2.feeBps,

    // scaling & targets
    scaleOutAtR: cfg2.scaleOutAtR,
    scaleOutFrac: cfg2.scaleOutFrac,
    finalTP_R: cfg2.finalTP_R,

    // daily risk
    maxDailyLossPct: cfg2.maxDailyLossPct,

    // trails
    atrTrailMult: cfg2.atrTrailMult ?? 0,
    atrTrailPeriod: cfg2.atrTrailPeriod ?? 14,
    mfeTrail: cfg2.mfeTrail ?? { enabled: false },

    // position mgmt
    pyramiding: cfg2.pyramiding ?? { enabled: false },
    volScale: cfg2.volScale ?? { enabled: false },

    // entry/exit behavior
    oco: cfg2.oco,
    triggerMode: cfg2.triggerMode,
    flattenAtClose: cfg2.flattenAtClose,

    // backtest policy
    dailyMaxTrades: cfg2?.backtest?.dailyMaxTrades ?? 0,
    postLossCooldownBars: cfg2?.backtest?.postLossCooldownBars ?? 0,
    entryChase: cfg2?.backtest?.entryChase ?? {
      enabled: true,
      afterBars: 2,
      maxSlipR: 0.12,
      convertOnExpiry: true,
    },

    // sizing limits
    qtyStep: cfg2?.position?.qtyStep ?? 0.001,
    minQty: cfg2?.position?.minQty ?? 0.001,
    maxLeverage: cfg2?.position?.maxLeverage ?? 2.0,

    // slip guards
    reanchorStopOnFill: cfg2.reanchorStopOnFill ?? true,
    maxSlipROnFill: cfg2.maxSlipROnFill ?? 0.2,
  });

  const m = results.metrics;
  console.log("\n=== Backtest Summary ===");
  const fmt2 = (x) =>
    x === Infinity ? "Inf" : Number.isFinite(x) ? x.toFixed(2) : "—";
  const fmt3 = (x) =>
    x === Infinity ? "Inf" : Number.isFinite(x) ? x.toFixed(3) : "—";

  console.table({
    Symbol: symbol,
    Trades: m.trades,
    WinRate: (m.winRate * 100).toFixed(1) + "%",
    ProfitFactor: fmt2(m.profitFactor),
    Expectancy: fmt2(m.expectancy),
    TotalR: fmt2(m.totalR),
    AvgR: fmt3(m.avgR),
    PnL: fmt2(m.totalPnL),
    ReturnPct: fmt2(m.returnPct * 100) + "%",
    MaxDDPct: fmt2(m.maxDrawdownPct * 100) + "%",
    Calmar: fmt2(m.calmar),
    Sharpe_tr: fmt2(m.sharpePerTrade),
    Sortino_tr: fmt2(m.sortinoPerTrade),
    AvgHoldMin: fmt2(m.avgHoldMin),
    ExposurePct: fmt2(m.exposurePct * 100) + "%",
    MaxWinStreak: m.maxConsecWins,
    MaxLossStreak: m.maxConsecLosses,
    StartEquity: (m.finalEquity - m.totalPnL).toFixed(2),
    FinalEquity: m.finalEquity.toFixed(2),
  });
}

// ---------------- live (paper) ----------------
async function runLive(argv, cfg) {
  const symbolArg = argv["--symbol"];
  const cfg2 = applyAssetDefaults(cfg, symbolArg);
  const symbol = symbolArg || cfg2.symbol || "BTC-USD";
  const interval = argv["--interval"] || cfg2.interval || "5m";
  const rr = cfg2.rr;
  const riskPct = cfg2.riskPct;

  const broker = new PaperBroker({
    equity: cfg2.equity,
    maxConcurrent: cfg2.maxConcurrentTrades,
    maxHoldMin: cfg2?.broker?.maxHoldMinLive ?? null,
    flattenWeekends: cfg2?.broker?.flattenWeekends ?? false,
    flattenFridayHourUTC: cfg2?.broker?.flattenFridayHourUTC ?? 21,
  });

  const signal = buildSignal(cfg2);

  // For live seeding, 5d is fine and within Yahoo limits for 5m
  let history = await fetchHistorical(symbol, interval, "5d");
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
          qtyStep: cfg2?.position?.qtyStep ?? 0.001,
          minQty: cfg2?.position?.minQty ?? 0.001,
          maxLeverage: cfg2?.position?.maxLeverage ?? 2.0,
        });
        if (size > 0) {
          broker.open({
            symbol,
            ...sig,
            size,
            time: latest.time,
            maxHoldMin: sig._maxHoldMin ?? cfg2?.broker?.maxHoldMinLive ?? null,
          });
          console.log(
            `[live] open ${sig.side} @ ${sig.entry} SL ${sig.stop} TP ${
              sig.takeProfit
            } size ${size.toFixed(4)}`
          );
        }
      }

      broker.mark({ symbol, price: latest.close, time: latest.time });
    } catch (e) {
      console.error("[live] loop error", e.message);
    }
  }, cfg2.pollMs || 15000);
}

// ---------------- main ----------------
(async () => {
  try {
    const cfg = loadConfig();
    const argv = process.argv.slice(2);
    const mode = argv[0] || "backtest";
    const argobj = {};
    for (let i = 1; i < argv.length; i += 2) argobj[argv[i]] = argv[i + 1];

    if (mode === "backtest") await runBacktest(argobj, cfg);
    else if (mode === "live") await runLive(argobj, cfg);
    else throw new Error("Unknown mode. Use backtest|live");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
