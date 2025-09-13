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
    // generic knobs (may be overridden by preset)
    preset = 'standard',
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

    bias = { enabled: true, gate: 'strict', emaPeriod: 50, slopeBps: 1, htf4h: 240, htf1h: 60, fallback15m: 15, bandBps: 8 },
    allowStrongSetupOverNeutralBias,

    confluence = { minScore: 3, sweepPts: 1, imbPts: 1, bosPts: 1, pdPts: 0, otePts: 1, htfPts: 1 },

    /**
     * entryMode:
     *  - 'edge'  : use FVG edge (bottom for longs, top for shorts)
     *  - 'ce'    : use FVG mid (consequent encroachment)
     *  - 'adaptive' : ladder within the FVG (edge->toward mid) using wick strength
     */
    entryMode = 'edge',
    rr = 1.9,
    atrPeriod = 14,
    atrMult = 1.0,
    minStopBps = 5,
    breakevenAtR = 1.0,
    trailAfterR = 1.5,
    cooldownBars = 4,
    entryExpiryBars = 5,

    // wick rejection filter
    wickRejection = {
      enabled: false,
      /** min wick size vs ATR to count as a rejection */
      minWickAtr: 0.40,
      /** require the wick to pierce beyond the relevant FVG edge and close back inside */
      requirePierce: true,
      /** require candle body direction to align with trade side */
      requireBodyDir: true
    },

    // controls how far from the edge we place the limit when entryMode='adaptive'
    entryAdaptive = {
      /** base penetration (0=edge, 1=mid). will be increased if wick is weak */
      penBase: 0.35,
      /** extra penetration to apply when wick is weak */
      penWeakAdd: 0.25,
      /** cap penetration */
      penMax: 0.70
    },

    log = { enabled: false, level: 'info', json: true, basename: undefined },

    fvgMinBps,
    minBodyAtr,
    needFvgAtr
  } = opts;

  DBG.on = !!debug;
  bindExitLog();

  // --- Merge preset defaults comprehensively ---
  const P = presetDefaults(preset);

  const _useSessionWindows = (useSessionWindows !== undefined) ? useSessionWindows : (P.useSessionWindows ?? false);
  const _killzones = (killzones !== undefined) ? killzones : (P.killzones ?? "08:30-11:30,13:30-15:30");

  const _imbalanceLookback = (imbalanceLookback !== undefined) ? imbalanceLookback : (P.imbalanceLookback ?? 20);
  const _sweepTolBps       = (sweepTolBps !== undefined) ? sweepTolBps : (P.sweepTolBps ?? 3);
  const _minAtrBps         = (minAtrBps !== undefined) ? minAtrBps : (P.minAtrBps ?? 3);

  const _fvgMinBps   = (fvgMinBps !== undefined) ? fvgMinBps : (P.fvgMinBps ?? 2.0);
  const _needFvgAtr  = (needFvgAtr !== undefined) ? needFvgAtr : (P.needFvgAtr ?? 0.85);
  const _minBodyAtr  = (minBodyAtr !== undefined) ? minBodyAtr : (P.minBodyAtr ?? 0.30);

  const _requireMicroBOS = (requireMicroBOS !== undefined) ? requireMicroBOS : (P.requireMicroBOS ?? true);
  const _requireSweep    = (requireSweep !== undefined) ? requireSweep : (P.requireSweep ?? true);

  const _allowStrong = (allowStrongSetupOverNeutralBias !== undefined)
    ? allowStrongSetupOverNeutralBias
    : (P.allowStrongSetupOverNeutralBias ?? true);

  const _usePD  = (usePD  !== undefined) ? usePD  : (P.usePD  ?? true);
  const _useOTE = (useOTE !== undefined) ? useOTE : (P.useOTE ?? true);

  const _pdToleranceBps = (pdToleranceBps !== undefined) ? pdToleranceBps : (P.pdToleranceBps ?? 30);
  const _oteLo = (oteLo !== undefined) ? oteLo : (P.oteLo ?? 0.62);
  const _oteHi = (oteHi !== undefined) ? oteHi : (P.oteHi ?? 0.79);

  const logger = createLogger({
    enabled: !!(debug || log?.enabled),
    level: log?.level ?? 'info',
    json: log?.json ?? true,
    basename: log?.basename
  });

  const windows = parseWindowsCSV(_killzones);

  // --- helpers ---
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function wickRejectOK(side, imb, bar, atrVal, cfg) {
    if (!cfg?.enabled || !bar || !Number.isFinite(atrVal) || atrVal <= 0) return true;
    const bodyUp = bar.close >= bar.open;
    const bodyDn = bar.close <= bar.open;
    const upperWick = Math.max(0, bar.high - Math.max(bar.open, bar.close));
    const lowerWick = Math.max(0, Math.min(bar.open, bar.close) - bar.low);
    const wick = (side === 'long') ? lowerWick : upperWick;
    const wickATR = wick / Math.max(1e-12, atrVal);

    let pierceOK = true;
    if (cfg.requirePierce) {
      if (side === 'long') pierceOK = (bar.low <= imb.bottom) && (bar.close >= imb.bottom);
      else pierceOK = (bar.high >= imb.top) && (bar.close <= imb.top);
    }

    let bodyOK = true;
    if (cfg.requireBodyDir) bodyOK = (side === 'long') ? bodyUp : bodyDn;

    return (wickATR >= (cfg.minWickAtr ?? 0.40)) && pierceOK && bodyOK;
  }

  function chooseEntryPrice(side, imb, mode, atrVal, lastBar) {
  if (mode === 'ce') return imb.mid;
  if (mode === 'edge') return side === 'long' ? imb.bottom : imb.top;
  if (mode === 'adaptive') {
    // base penetration toward CE; adjust by wick strength
    const cfg = entryAdaptive || {};
    const penBase = clamp01(cfg.penBase ?? 0.35);
    const penWeakAdd = clamp01(cfg.penWeakAdd ?? 0.25);
    const penMax = clamp01(cfg.penMax ?? 0.7);

    // use the provided lastBar instead of referencing an out-of-scope `bars`
    const wickOK = wickRejectOK(side, imb, lastBar, atrVal, wickRejection);
    const pen = wickOK ? penBase : Math.min(penMax, penBase + penWeakAdd);

    if (side === 'long') {
      // from bottom (edge) toward mid
      return imb.bottom + pen * (imb.mid - imb.bottom);
    } else {
      // from top (edge) toward mid
      return imb.top - pen * (imb.top - imb.mid);
    }
  }
  // fallback
  return imb.mid;
}


  const api = ({ candles }) => {
    const bars = candles;
    const i = bars.length - 1;
    DBG.barsSeen++;
    const now = bars[i]?.time ?? Date.now();

    if (i < Math.max(lookback, 200)) { rej('earlyWarmup'); return null; }

    // --- time/session fences ---
    const m = minutesET(now);
    if (cashSessionGuard) {
      const openET = 9 * 60 + 30, closeET = 16 * 60;
      if (!(m >= openET + firstMinGuard && m <= closeET - lastMinGuard)) { rej('timeFence'); return null; }
    } else {
      if (!(m >= firstMinGuard && m <= (24 * 60 - lastMinGuard))) { rej('timeFence'); return null; }
    }
    if (_useSessionWindows && !inWindowsET(now, windows)) { rej('windowFence'); return null; }

    // --- bias ---
    const dBias = bias?.enabled ? chooseDailyBias(bars, bias) : 0;
    if (bias?.enabled && bias.gate === 'strict' && dBias === 0 && !_allowStrong) { rej('biasNeutralStrict'); return null; }

    // --- daily ranges (Asia + prev day) ---
    const asian = computeAsianRangeTodayET(bars, i, 0, 5 * 60);
    const prevDay = computeDayRangeET(bars, i, -1);

    // --- volatility / ATR ---
    const A = atr(bars, Math.max(5, atrPeriod));
    const curATR = A[i];
    const price = bars[i].close;
    if (curATR === undefined) { rej('atrTooSmall'); return null; }
    const atrBps = relBps(curATR, price);
    if (atrBps < _minAtrBps) { rej('atrTooSmall'); return null; }

    // --- sweep requirement (optional) ---
    let sw = detectSweep(bars, i, { asian, prevDay, tolBps: _sweepTolBps, swingFallbackLookback: 30 });
    if (!sw && !_requireSweep) {
      const db = bias?.enabled ? dBias : 0;
      if (db !== 0) sw = { side: db > 0 ? 'long' : 'short', ref: bars[i].close, kind: 'nosweep' };
    }
    if (!sw) { rej('noSweep'); return null; }

    // --- imbalance (FVG/IFVG) ---
    const imb = recentImbalance(bars, i, _imbalanceLookback, preferIFVG);
    if (!imb) { rej('noImbalance'); return null; }
    if ((sw.side === 'long' && imb.type !== 'bull') || (sw.side === 'short' && imb.type !== 'bear')) { rej('noImbalance'); return null; }

    // size/quality of imbalance and bar body
    const body = Math.abs(bars[i].close - bars[i].open);
    const bodyAtr = body / Math.max(1e-12, curATR);
    const imbSize = Math.abs(imb.top - imb.bottom);
    const imbBps = relBps(imbSize, price);
    const fvgAtr = imbSize / Math.max(1e-12, curATR);
    if (imbBps < _fvgMinBps || bodyAtr < _minBodyAtr || fvgAtr < _needFvgAtr) { rej('fvgTooSmall'); return null; }

    // wick rejection (optional, acts as quality gate)
    if (!wickRejectOK(sw.side, imb, bars[i], curATR, wickRejection)) { rej('wickFail'); return null; }

    // micro BOS (optional per preset)
    if (_requireMicroBOS) {
      const dir = sw.side === 'long' ? 'up' : 'down';
      if (!microBOS(bars, i, dir, 30, 'wick')) { rej('microBosFail'); return null; }
    }

    // PD fence (optional)
    if (_usePD && prevDay) {
      const tolAbs = price * (_pdToleranceBps / 10000);
      const lo = prevDay.lo - tolAbs;
      const hi = prevDay.hi + tolAbs;
      const priceOK = (price >= lo && price <= hi);
      const midOK = imb ? (imb.mid >= lo && imb.mid <= hi) : false;
      if (!(priceOK || midOK)) { rej('pdFail'); return null; }
    }

    // OTE zone (optional)
    if (_useOTE && imb) {
      const ph = recentSwing(bars, i, 'down', 30);
      const pl = recentSwing(bars, i, 'up', 30);
      let oteOK = true;
      if (sw.side === 'long' && ph && pl && ph.price > pl.price) {
        const range = ph.price - pl.price;
        const z1 = ph.price - range * _oteHi;
        const z2 = ph.price - range * _oteLo;
        const loZ = Math.min(z1, z2), hiZ = Math.max(z1, z2);
        oteOK = (imb.mid >= loZ && imb.mid <= hiZ);
      } else if (sw.side === 'short' && ph && pl && ph.price > pl.price) {
        const range = ph.price - pl.price;
        const z1 = pl.price + range * _oteLo;
        const z2 = pl.price + range * _oteHi;
        const loZ = Math.min(z1, z2), hiZ = Math.max(z1, z2);
        oteOK = (imb.mid >= loZ && imb.mid <= hiZ);
      }
      if (!oteOK) { rej('oteFail'); return null; }
    }

    // optional 'confluence' scoring (light—keeps current gates)
    let score = 0;
    if (sw) score += confluence.sweepPts ?? 0;
    if (imb) score += confluence.imbPts ?? 0;
    if (_requireMicroBOS) score += confluence.bosPts ?? 0; // only if checked
    if (_usePD) score += confluence.pdPts ?? 0;
    if (_useOTE) score += confluence.otePts ?? 0;
    const biasAgree = (dBias > 0 && sw.side === 'long') || (dBias < 0 && sw.side === 'short');
    if (bias?.enabled && biasAgree) score += confluence.htfPts ?? 0;

    if ((confluence.minScore ?? 0) > 0 && score < confluence.minScore) { rej('scoreFail'); return null; }

    // --- entry/stop/tp with min stop bps enforcement ---
    const entryEdge = chooseEntryPrice(sw.side, imb, entryMode, curATR, bars[i]);

    let stopRaw = sw.side === 'long'
      ? (imb.bottom - atrMult * curATR)
      : (imb.top    + atrMult * curATR);

    const stopBps = relBps(Math.abs(entryEdge - stopRaw), price);
    if (stopBps < (minStopBps ?? 0)) {
      const want = (minStopBps / 10000) * price;
      stopRaw = (sw.side === 'long') ? (entryEdge - want) : (entryEdge + want);
    }

    const takeProfit = sw.side === 'long'
      ? (entryEdge + rr * Math.abs(entryEdge - stopRaw))
      : (entryEdge - rr * Math.abs(entryEdge - stopRaw));

    if (DBG) DBG.accepted = (DBG.accepted || 0) + 1;

    // optional file logger line for visibility
    if (logger.on) {
      logger.info({
        t: new Date(now).toISOString(),
        msg: 'signal',
        side: sw.side,
        entry: entryEdge,
        stop: stopRaw,
        tp: takeProfit,
        gates: {
          bias: dBias, atrBps, sweep: sw?.kind ?? null, fvgBps: imbBps,
          bodyAtr, fvgAtr, pd: _usePD, ote: _useOTE, score,
          wickRej: wickRejection?.enabled ?? false
        }
      });
    }

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
