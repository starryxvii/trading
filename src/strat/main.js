// src/strat/main.js
import { ema, atr } from "../utils/indicators.js";
import { minutesET } from "../utils/time.js";
import { createLogger } from "../utils/logger.js";

import { relBps, mid, parseWindowsCSV, inWindowsET } from "./core/utils.js";
import { presetDefaults } from "./core/presets.js";
import { recentImbalance } from "./core/fvg.js";
import { recentSwing, microBOS, detectSweep } from "./core/swings.js";
import {
  computeDayRangeET,
  computeAsianRangeTodayET,
  computeSessionRangesTodayET,
} from "./core/ranges.js";
import { chooseDailyBias } from "./core/bias.js";
import { DBG, rej, bindExitLog } from "./core/dbg.js";

export function signalFactory(opts = {}) {
  // ---------- defaults & options merge ----------
  const {
    preset = "standard",
    debug = false,

    useSessionWindows,
    killzones,
    firstMinGuard = 1,
    lastMinGuard = 1,
    cashSessionGuard = false,

    lookback = 250,
    imbalanceLookback,
    sweepTolBps,
    minAtrBps,
    pdToleranceBps,

    preferIFVG = true,
    requireMicroBOS,
    requireSweep,

    usePD,
    useOTE,
    oteLo,
    oteHi,

    bias = {
      enabled: true,
      gate: "strict",
      emaPeriod: 50,
      slopeBps: 1,
      htf4h: 240,
      htf1h: 60,
      fallback15m: 15,
      bandBps: 8,
    },
    allowStrongSetupOverNeutralBias,

    confluence = {
      minScore: 3,
      sweepPts: 1,
      imbPts: 1,
      bosPts: 1,
      pdPts: 0,
      otePts: 1,
      htfPts: 1,
    },

    // entry behavior
    entryMode = "edge",
    rr = 1.9,
    atrPeriod = 14,
    atrMult = 1.0,
    minStopBps = 5,
    breakevenAtR = 1.0,
    trailAfterR = 1.5,
    cooldownBars = 4,
    entryExpiryBars = 5,

    // TP logic
    tpMode, // 'rr' | 'key' | 'hybrid'
    rrMinForKey,

    // wick rejection
    wickRejection = {
      enabled: false,
      minWickAtr: 0.4,
      requirePierce: true,
      requireBodyDir: true,
    },

    // adaptive entry tuning
    entryAdaptive = { penBase: 0.35, penWeakAdd: 0.25, penMax: 0.7 },

    // sessions
    sessionLevels = [
      { name: "Asia", startMin: 0, endMin: 5 * 60 },
      { name: "London", startMin: 8 * 60, endMin: 13 * 60 },
      { name: "NewYork", startMin: 13 * 60, endMin: 21 * 60 },
    ],

    log = { enabled: false, level: "info", json: true, basename: undefined },

    fvgMinBps,
    minBodyAtr,
    needFvgAtr,

    // knobs
    allowImbalanceFallbackOnNeutral = true,
    microBosLookback = 32,
    microBosLookbackNosweep = 42,

    // signal spacing
    minGapBarsBetweenSignals: _minGapBarsBetweenSignals = 4,

    requireSweepMode = "prefer", // 'force' | 'prefer'
  } = opts;

  let _lastSignalBarIdx = -Infinity;

  DBG.on = !!debug;
  bindExitLog();

  const P = presetDefaults(preset);

  // resolve effective params (prefer explicit opts, otherwise preset, else fallback)
  const _useSessionWindows = useSessionWindows ?? (P.useSessionWindows ?? false);
  const _killzones = killzones ?? (P.killzones ?? "08:30-11:30,13:30-15:30");
  const _imbalanceLookback = imbalanceLookback ?? (P.imbalanceLookback ?? 20);
  const _sweepTolBps = sweepTolBps ?? (P.sweepTolBps ?? 3);
  const _minAtrBps = minAtrBps ?? (P.minAtrBps ?? 3);
  const _fvgMinBps = fvgMinBps ?? (P.fvgMinBps ?? 2.0);
  const _needFvgAtr = needFvgAtr ?? (P.needFvgAtr ?? 0.85);
  const _minBodyAtr = minBodyAtr ?? (P.minBodyAtr ?? 0.3);
  const _requireMicroBOS = requireMicroBOS ?? (P.requireMicroBOS ?? true);
  const _requireSweep = requireSweep ?? (P.requireSweep ?? true);
  const _allowStrong = allowStrongSetupOverNeutralBias ?? (P.allowStrongSetupOverNeutralBias ?? true);
  const _usePD = usePD ?? (P.usePD ?? true);
  const _useOTE = useOTE ?? (P.useOTE ?? true);
  const _pdToleranceBps = pdToleranceBps ?? (P.pdToleranceBps ?? 36);
  const _oteLo = oteLo ?? (P.oteLo ?? 0.6);
  const _oteHi = oteHi ?? (P.oteHi ?? 0.8);
  const _tpMode = tpMode ?? (P.tpMode ?? "hybrid");
  const _rrMinForKey = rrMinForKey ?? (P.rrMinForKey ?? 1.2);

  const logger = createLogger({
    enabled: !!(debug || log?.enabled),
    level: log?.level ?? "info",
    json: log?.json ?? true,
    basename: log?.basename,
  });

  const windows = parseWindowsCSV(_killzones);

  // ---------- helpers ----------
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  function wickRejectOK(side, imb, bar, atrVal, cfg) {
    if (!cfg?.enabled || !bar || !(atrVal > 0)) return true;
    const bodyUp = bar.close >= bar.open;
    const bodyDn = bar.close <= bar.open;
    const upperWick = Math.max(0, bar.high - Math.max(bar.open, bar.close));
    const lowerWick = Math.max(0, Math.min(bar.open, bar.close) - bar.low);
    const wick = side === "long" ? lowerWick : upperWick;
    const wickATR = wick / Math.max(1e-12, atrVal);

    let pierceOK = true;
    if (cfg.requirePierce) {
      pierceOK = side === "long"
        ? (bar.low <= imb.bottom && bar.close >= imb.bottom)
        : (bar.high >= imb.top && bar.close <= imb.top);
    }

    let bodyOK = true;
    if (cfg.requireBodyDir) bodyOK = side === "long" ? bodyUp : bodyDn;

    return wickATR >= (cfg.minWickAtr ?? 0.4) && pierceOK && bodyOK;
  }

  function chooseEntryPrice(side, imb, mode, atrVal, lastBar) {
    if (mode === "ce") return imb.mid;
    if (mode === "edge") return side === "long" ? imb.bottom : imb.top;
    if (mode === "adaptive") {
      const cfg = entryAdaptive || {};
      const penBase = clamp01(cfg.penBase ?? 0.35);
      const penWeakAdd = clamp01(cfg.penWeakAdd ?? 0.25);
      const penMax = clamp01(cfg.penMax ?? 0.7);
      const wickOK = wickRejectOK(side, imb, lastBar, atrVal, wickRejection);
      const pen = wickOK ? penBase : Math.min(penMax, penBase + penWeakAdd);
      return side === "long"
        ? imb.bottom + pen * (imb.mid - imb.bottom)
        : imb.top - pen * (imb.top - imb.mid);
    }
    return imb.mid;
  }

  function nearestOppositeKeyTP(side, entryPx, context, fallbackAbs) {
    const wantAbove = side === "long";
    const cands = [];

    if (context.prevDay?.hi) cands.push({ p: context.prevDay.hi, tag: "PDH" });
    if (context.prevDay?.lo) cands.push({ p: context.prevDay.lo, tag: "PDL" });
    if (context.asian?.hi) cands.push({ p: context.asian.hi, tag: "ASH" });
    if (context.asian?.lo) cands.push({ p: context.asian.lo, tag: "ASL" });

    for (const s of context.sessions || []) {
      if (Number.isFinite(s.hi)) cands.push({ p: s.hi, tag: `${s.name}H` });
      if (Number.isFinite(s.lo)) cands.push({ p: s.lo, tag: `${s.name}L` });
    }

    const swHi = recentSwing(context.bars, context.idx, "down", 40);
    const swLo = recentSwing(context.bars, context.idx, "up", 40);
    if (swHi) cands.push({ p: swHi.price, tag: "swingHi" });
    if (swLo) cands.push({ p: swLo.price, tag: "swingLo" });

    const filtered = cands.filter((c) => wantAbove ? c.p > entryPx : c.p < entryPx);
    if (!filtered.length) {
      return { tp: wantAbove ? entryPx + fallbackAbs : entryPx - fallbackAbs, tag: "rrFallback" };
    }
    const picked = filtered.reduce((best, cur) => {
      if (!best) return cur;
      return Math.abs(cur.p - entryPx) < Math.abs(best.p - entryPx) ? cur : best;
    }, null);

    return { tp: picked.p, tag: picked.tag };
  }

  // ---------- main factory API ----------
  const api = ({ candles }) => {
    const bars = candles;
    const i = bars.length - 1;
    DBG.barsSeen++;
    const now = bars[i]?.time ?? Date.now();

    // warmup
    if (i < Math.max(lookback, 200)) { rej("earlyWarmup"); return null; }

    // spacing
    if (i - _lastSignalBarIdx < Math.max(0, _minGapBarsBetweenSignals)) {
      rej("signalSpacing"); return null;
    }

    // session/time fences
    const m = minutesET(now);
    if (cashSessionGuard) {
      const openET = 9 * 60 + 30, closeET = 16 * 60;
      if (!(m >= openET + firstMinGuard && m <= closeET - lastMinGuard)) {
        rej("timeFence"); return null;
      }
    } else {
      if (!(m >= firstMinGuard && m <= 24 * 60 - lastMinGuard)) {
        rej("timeFence"); return null;
      }
    }
    if (_useSessionWindows && !inWindowsET(now, windows)) { rej("windowFence"); return null; }

    // bias
    const dBias = bias?.enabled ? chooseDailyBias(bars, bias) : 0;
    if (bias?.enabled && bias.gate === "strict" && dBias === 0 && !_allowStrong) {
      rej("biasNeutralStrict"); return null;
    }

    // ranges & ATR
    const asian = computeAsianRangeTodayET(bars, i, 0, 5 * 60);
    const prevDay = computeDayRangeET(bars, i, -1);
    const sessions = computeSessionRangesTodayET(bars, i, sessionLevels);

    const A = atr(bars, Math.max(5, atrPeriod));
    const curATR = A[i];
    const price = bars[i].close;
    if (curATR === undefined) { rej("atrTooSmall"); return null; }
    const atrBps = relBps(curATR, price);
    if (atrBps < _minAtrBps) { rej("atrTooSmall"); return null; }

    // imbalance
    const imb = recentImbalance(bars, i, _imbalanceLookback, preferIFVG);
    if (!imb) { rej("noImbalance"); return null; }

    // FVG/body quality
    const body = Math.abs(bars[i].close - bars[i].open);
    const bodyAtr = body / Math.max(1e-12, curATR);
    const imbSize = Math.abs(imb.top - imb.bottom);
    const imbBps = relBps(imbSize, price);
    const fvgAtr = imbSize / Math.max(1e-12, curATR);
    if (imbBps < _fvgMinBps || bodyAtr < _minBodyAtr || fvgAtr < _needFvgAtr) {
      rej("fvgTooSmall"); return null;
    }

    // sweep detection (with bias-aware nosweep fallback)
    let sw = detectSweep(bars, i, {
      asian, prevDay, extraLevels: sessions, tolBps: _sweepTolBps, swingFallbackLookback: 30,
    });

    const biasAgree = (dBias > 0 && sw?.side === "long") || (dBias < 0 && sw?.side === "short");

    if (!sw && requireSweepMode === "prefer" && dBias !== 0) {
      sw = { side: dBias > 0 ? "long" : "short", ref: bars[i].close, kind: "nosweep" };
    }
    if (!sw || (sw.kind === "nosweep" && _requireSweep === true && !biasAgree)) {
      rej("noSweep"); return null;
    }

    // align direction with imbalance
    if ((sw.side === "long" && imb.type !== "bull") || (sw.side === "short" && imb.type !== "bear")) {
      rej("noImbalance"); return null;
    }

    // wick quality gate
    if (!wickRejectOK(sw.side, imb, bars[i], curATR, wickRejection)) { rej("wickFail"); return null; }

    // structure (BOS) requirements
    let bosOK = true;
    const mustHaveBOS = _requireMicroBOS || (sw.kind === "nosweep" && requireSweepMode === "prefer");
    if (mustHaveBOS) {
      const dir = sw.side === "long" ? "up" : "down";
      const look = sw.kind === "nosweep" ? (microBosLookbackNosweep || 42) : (microBosLookback || 32);
      bosOK = microBOS(bars, i, dir, look, "wick");
      if (!bosOK) { rej("microBosFail"); return null; }
    }

    // PD (optional)
    if (_usePD && prevDay) {
      const tolAbs = price * (_pdToleranceBps / 10000);
      const lo = prevDay.lo - tolAbs, hi = prevDay.hi + tolAbs;
      const priceOK = price >= lo && price <= hi;
      const midOK = imb ? (imb.mid >= lo && imb.mid <= hi) : false;
      if (!(priceOK || midOK)) { rej("pdFail"); return null; }
    }

    // OTE as soft filter (no hard reject unless neutral bias)
    let otePass = true;
    if (_useOTE && imb) {
      const ph = recentSwing(bars, i, "down", 30);
      const pl = recentSwing(bars, i, "up", 30);
      if (ph && pl && ph.price > pl.price) {
        if (sw.side === "long") {
          const range = ph.price - pl.price;
          const z1 = ph.price - range * _oteHi, z2 = ph.price - range * _oteLo;
          const loZ = Math.min(z1, z2), hiZ = Math.max(z1, z2);
          otePass = imb.mid >= loZ && imb.mid <= hiZ;
        } else {
          const range = ph.price - pl.price;
          const z1 = pl.price + range * _oteLo, z2 = pl.price + range * _oteHi;
          const loZ = Math.min(z1, z2), hiZ = Math.max(z1, z2);
          otePass = imb.mid >= loZ && imb.mid <= hiZ;
        }
      }
    }

    if (bias?.enabled && dBias === 0 && _useOTE && !otePass) { rej("oteFailNeutral"); return null; }

    // If sweep came from Asia session, require HTF agreement
    if (sw?.kind === "asia" && !biasAgree) { rej("asiaNoBias"); return null; }

    // confluence score
    let score = 0;
    if (sw) score += confluence.sweepPts ?? 0;
    if (imb) score += confluence.imbPts ?? 0;
    if (bosOK) score += confluence.bosPts ?? 0;
    if (_usePD) score += confluence.pdPts ?? 0;
    if (_useOTE && otePass) score += confluence.otePts ?? 0;
    if (bias?.enabled && biasAgree) score += confluence.htfPts ?? 0;
    if ((confluence.minScore ?? 0) > 0 && score < confluence.minScore) { rej("scoreFail"); return null; }

    // entry/stop
    const entryEdge = chooseEntryPrice(sw.side, imb, entryMode, curATR, bars[i]);

    let stopRaw = sw.side === "long" ? (imb.bottom - atrMult * curATR) : (imb.top + atrMult * curATR);
    const stopBps = relBps(Math.abs(entryEdge - stopRaw), price);
    if (stopBps < (minStopBps ?? 0)) {
      const want = (minStopBps / 10000) * price;
      stopRaw = sw.side === "long" ? entryEdge - want : entryEdge + want;
    }
    const riskAbs = Math.abs(entryEdge - stopRaw);

    // TP selection
    let takeProfit, tpTag, rrTP;
    if ((_tpMode ?? "hybrid") === "rr") {
      takeProfit = sw.side === "long" ? entryEdge + rr * riskAbs : entryEdge - rr * riskAbs;
      tpTag = "rr"; rrTP = rr;
    } else {
      const { tp, tag } = nearestOppositeKeyTP(sw.side, entryEdge, { asian, prevDay, sessions, bars, idx: i }, rr * riskAbs);
      const rrToKey = Math.abs(tp - entryEdge) / Math.max(1e-12, riskAbs);
      const useKey = _tpMode === "key" || ((_tpMode ?? "hybrid") === "hybrid" && rrToKey >= (_rrMinForKey ?? 1.2));
      if (useKey) { takeProfit = tp; tpTag = tag; rrTP = rrToKey; }
      else { takeProfit = sw.side === "long" ? entryEdge + rr * riskAbs : entryEdge - rr * riskAbs; tpTag = "rrFallback"; rrTP = rr; }
    }

    if (DBG) DBG.accepted = (DBG.accepted || 0) + 1;

    if (logger.on) {
      logger.info({
        t: new Date(now).toISOString(),
        msg: "signal",
        side: sw.side,
        entry: entryEdge,
        stop: stopRaw,
        tp: takeProfit,
        gates: {
          bias: dBias,
          atrBps,
          sweep: sw?.kind ?? null,
          fvgBps: relBps(Math.abs(imb.top - imb.bottom), price),
          bodyAtr,
          fvgAtr,
          pd: _usePD,
          ote: _useOTE ? otePass : null,
          score,
          wickRej: wickRejection?.enabled ?? false,
          tpKind: tpTag,
          tpRR: rrTP,
        },
      });
    }

    _lastSignalBarIdx = i;

    return {
      side: sw.side,
      entry: entryEdge,
      stop: stopRaw,
      takeProfit,
      _initRisk: riskAbs,
      _rr: rr,
      _entryExpiryBars: entryExpiryBars,
      _imb: imb,
      _breakevenAtR: breakevenAtR,
      _trailAfterR: trailAfterR,
      _cooldownBars: cooldownBars,
    };
  };

  return api;
}

export default signalFactory;
