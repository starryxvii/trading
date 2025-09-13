// src/strategy/ultra/index.js
import { ema, atr } from '../../utils/indicators.js';
import { minutesET } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

import { relBps, mid, parseWindowsCSV, inWindowsET } from './core/utils.js';
import { presetDefaults } from './core/presets.js';
import { recentImbalance } from './core/fvg.js';
import { recentSwing, microBOS, detectSweep } from './core/swings.js';
import { computeDayRangeET, computeAsianRangeTodayET } from './core/ranges.js';
import { chooseDailyBias } from './core/bias.js';
import { DBG, rej, bindExitLog } from './core/dbg.js';

export function ultraSignalFactory(opts = {}) {
  const {
    preset = 'standard',
    debug = false,

    useSessionWindows = false,
    killzones = "02:00-05:00,08:30-10:00,13:30-15:00",
    firstMinGuard = 1,
    lastMinGuard = 1,
    cashSessionGuard = false,

    lookback = 250,
    imbalanceLookback,
    sweepTolBps = 3,
    minAtrBps,
    pdToleranceBps = 30,

    preferIFVG = true,
    requireMicroBOS,
    requireSweep = true,

    usePD = true,
    useOTE = true,
    oteLo = 0.62,
    oteHi = 0.79,

    bias = { enabled: true, gate: 'strict', emaPeriod: 50, slopeBps: 1, htf4h: 240, htf1h: 60, fallback15m: 15, bandBps: 8 },
    allowStrongSetupOverNeutralBias,

    confluence = { minScore: 3, sweepPts: 1, imbPts: 1, bosPts: 1, pdPts: 0, otePts: 1, htfPts: 1 },

    entryMode = 'edge',
    rr = 1.9,
    atrPeriod = 14,
    atrMult = 1.0,
    minStopBps = 5,
    breakevenAtR = 1.0,
    trailAfterR = 1.5,
    cooldownBars = 4,
    entryExpiryBars = 5,

    log = { enabled: false, level: 'info', json: true, basename: undefined },

    fvgMinBps,
    minBodyAtr,
    needFvgAtr
  } = opts;

  DBG.on = !!debug;
  bindExitLog();

  const P = presetDefaults(preset);
  const _useSessionWindows = (useSessionWindows !== undefined) ? useSessionWindows : (P.useSessionWindows ?? false);
  const _imbalanceLookback = (imbalanceLookback !== undefined) ? imbalanceLookback : (P.imbalanceLookback ?? 20);

  const _fvgMinBps = (fvgMinBps !== undefined) ? fvgMinBps : (P.fvgMinBps ?? 2.0);
  const _minAtrBps = (minAtrBps !== undefined) ? minAtrBps : (P.minAtrBps ?? 3);
  const _requireMicroBOS = (requireMicroBOS !== undefined) ? requireMicroBOS : (P.requireMicroBOS ?? true);
  const _allowStrong = (allowStrongSetupOverNeutralBias !== undefined) ? allowStrongSetupOverNeutralBias : (P.allowStrongSetupOverNeutralBias ?? true);
  const _minBodyAtr = (minBodyAtr !== undefined) ? minBodyAtr : 0.30;
  const _needFvgAtr = (needFvgAtr !== undefined) ? needFvgAtr : 0.85;

  const logger = createLogger({
    enabled: !!(debug || log?.enabled),
    level: log?.level ?? 'info',
    json: log?.json ?? true,
    basename: log?.basename
  });

  const windows = parseWindowsCSV(killzones);

  const api = ({ candles }) => {
    const bars = candles;
    const i = bars.length - 1;
    DBG.barsSeen++;
    const now = bars[i]?.time ?? Date.now();

    if (i < Math.max(lookback, 200)) { rej('earlyWarmup'); return null; }

    const m = minutesET(now);

    if (cashSessionGuard) {
      const openET = 9 * 60 + 30, closeET = 16 * 60;
      if (!(m >= openET + firstMinGuard && m <= closeET - lastMinGuard)) return null;
    } else {
      if (!(m >= firstMinGuard && m <= (24 * 60 - lastMinGuard))) return null;
    }
    if (_useSessionWindows && !inWindowsET(now, windows)) return null;

    const dBias = bias?.enabled ? chooseDailyBias(bars, bias) : 0;
    if (bias?.enabled && bias.gate === 'strict' && dBias === 0 && !_allowStrong) return null;

    const asian = computeAsianRangeTodayET(bars, i, 0, 5 * 60);
    const prevDay = computeDayRangeET(bars, i, -1);

    const A = atr(bars, Math.max(5, atrPeriod));
    const curATR = A[i];
    const price = bars[i].close;
    if (curATR === undefined) return null;
    const atrBps = relBps(curATR, price);
    if (atrBps < _minAtrBps) return null;

    let sw = detectSweep(bars, i, { asian, prevDay, tolBps: sweepTolBps, swingFallbackLookback: 30 });
    if (!sw && !requireSweep) {
      const db = bias?.enabled ? dBias : 0;
      if (db !== 0) sw = { side: db > 0 ? 'long' : 'short', ref: bars[i].close, kind: 'nosweep' };
    }
    if (!sw) return null;

    const imb = recentImbalance(bars, i, _imbalanceLookback, preferIFVG);
    if (!imb) return null;
    if ((sw.side === 'long' && imb.type !== 'bull') || (sw.side === 'short' && imb.type !== 'bear')) return null;

    const body = Math.abs(bars[i].close - bars[i].open);
    const bodyAtr = body / Math.max(1e-12, curATR);
    const imbSize = Math.abs(imb.top - imb.bottom);
    const imbBps = relBps(imbSize, price);
    const fvgAtr = imbSize / Math.max(1e-12, curATR);
    if (imbBps < _fvgMinBps || bodyAtr < _minBodyAtr || fvgAtr < _needFvgAtr) return null;

    if (_requireMicroBOS) {
      const dir = sw.side === 'long' ? 'up' : 'down';
      if (!microBOS(bars, i, dir, 30, 'wick')) return null;
    }

    if (usePD && prevDay) {
      const tolAbs = price * (pdToleranceBps / 10000);
      const lo = prevDay.lo - tolAbs;
      const hi = prevDay.hi + tolAbs;
      const priceOK = (price >= lo && price <= hi);
      const midOK = imb ? (imb.mid >= lo && imb.mid <= hi) : false;
      if (!(priceOK || midOK)) return null;
    }

    // OTE: compute using swing-to-swing range (proper retracement zone)
    if (useOTE && imb) {
      const ph = recentSwing(bars, i, 'down', 30);
      const pl = recentSwing(bars, i, 'up', 30);
      let oteOK = true;
      if (sw.side === 'long' && ph && pl && ph.price > pl.price) {
        const range = ph.price - pl.price;
        const z1 = ph.price - range * oteHi;
        const z2 = ph.price - range * oteLo;
        const loZ = Math.min(z1, z2), hiZ = Math.max(z1, z2);
        oteOK = (imb.mid >= loZ && imb.mid <= hiZ);
      } else if (sw.side === 'short' && ph && pl && ph.price > pl.price) {
        const range = ph.price - pl.price;
        const z1 = pl.price + range * oteLo;
        const z2 = pl.price + range * oteHi;
        const loZ = Math.min(z1, z2), hiZ = Math.max(z1, z2);
        oteOK = (imb.mid >= loZ && imb.mid <= hiZ);
      }
      if (!oteOK) return null;
    }

    const biasAgree = (dBias > 0 && sw.side === 'long') || (dBias < 0 && sw.side === 'short');
    const htfOK = bias?.enabled ? biasAgree : true;
    if (!htfOK) return null;

    // --- entry/stop/tp with min stop bps enforcement ---
    const entryEdge = (entryMode === 'ce') ? imb.mid : (sw.side === 'long' ? imb.bottom : imb.top);
    let stopRaw = sw.side === 'long' ? (imb.bottom - atrMult * curATR) : (imb.top + atrMult * curATR);

    // respect minStopBps (in absolute bps vs current price)
    const stopBps = relBps(Math.abs(entryEdge - stopRaw), price);
    if (stopBps < (minStopBps ?? 0)) {
      const want = (minStopBps / 10000) * price;
      stopRaw = (sw.side === 'long') ? (entryEdge - want) : (entryEdge + want);
    }

    const takeProfit = sw.side === 'long'
      ? (entryEdge + rr * Math.abs(entryEdge - stopRaw))
      : (entryEdge - rr * Math.abs(entryEdge - stopRaw));

    return {
      side: sw.side,
      entry: entryEdge,
      stop: stopRaw,
      takeProfit,
      _initRisk: Math.abs(entryEdge - stopRaw),
      _rr: rr,
      _entryExpiryBars: entryExpiryBars,
      _imb: imb,
      _breakevenAtR: breakevenAtR,
      _trailAfterR: trailAfterR,
      _cooldownBars: cooldownBars
    };
  };

  return api;
}

export default ultraSignalFactory;
