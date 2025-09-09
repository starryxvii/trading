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

/** ---------- main factory (PUBLIC API unchanged) ---------- **/
export function ultraSignalFactory(opts = {}) {
  const {
    preset = 'standard',
    debug = false,

    // timing
    useSessionWindows = false,
    killzones = "02:00-05:00,08:30-10:00,13:30-15:00",
    firstMinGuard = 1,
    lastMinGuard = 1,
    cashSessionGuard = false,

    // lookbacks & tolerances
    lookback = 250,
    imbalanceLookback,
    sweepTolBps = 3,
    minAtrBps,              // override/tuned below via preset
    pdToleranceBps = 30,    // NEW: allow small tolerance around previous-day range (in bps)

    // imbalance prefs
    preferIFVG = true,
    requireMicroBOS,

    // PD / OTE
    usePD = true,
    useOTE = true,
    oteLo = 0.62,
    oteHi = 0.79,

    // EMA bias
    bias = { enabled: true, gate: 'strict', emaPeriod: 50, slopeBps: 1, htf4h: 240, htf1h: 60, fallback15m: 15, bandBps: 8 },
    allowStrongSetupOverNeutralBias,

    // confluence
    confluence = { minScore: 3, sweepPts: 1, imbPts: 1, bosPts: 1, pdPts: 0, otePts: 1, htfPts: 1 },

    // entries & risk
    entryMode = 'edge', // 'ce' | 'edge'
    rr = 1.9,
    atrPeriod = 14,
    atrMult = 1.0,
    minStopBps = 5,
    breakevenAtR = 1.0,
    trailAfterR = 1.5,
    cooldownBars = 4,
    requireSweep = true,
    entryExpiryBars = 5,

    // logging (optional)
    log = {
      enabled: false,     // auto-enabled if debug === true
      level: 'info',      // 'info' | 'debug'
      json: true,         // JSON lines
      basename: undefined // default: log-<timestamp>.txt
    },

    fvgMinBps,
    minBodyAtr
  } = opts;

  // debug/exit wiring
  DBG.on = !!debug;
  bindExitLog();

  // preset defaults (explicit opts win)
  const P = presetDefaults(preset);
  const _useSessionWindows = (useSessionWindows !== undefined)
    ? useSessionWindows
    : (P.useSessionWindows ?? false);
  const _imbalanceLookback = (imbalanceLookback !== undefined) ? imbalanceLookback : (P.imbalanceLookback ?? 20);

  // Loosen the strictest gates by default; explicit user values always win.
  const _fvgMinBps = (fvgMinBps !== undefined) ? fvgMinBps : (P.fvgMinBps ?? 3);          // min gap size in bps
  const _minAtrBps = (minAtrBps !== undefined) ? minAtrBps : (P.minAtrBps ?? 3);          // ATR(14)/price in bps
  const _requireMicroBOS = (requireMicroBOS !== undefined) ? requireMicroBOS : (P.requireMicroBOS ?? true);
  const _allowStrong = (allowStrongSetupOverNeutralBias !== undefined) ? allowStrongSetupOverNeutralBias : (P.allowStrongSetupOverNeutralBias ?? true);
  const _minBodyAtr = (minBodyAtr !== undefined) ? minBodyAtr : 0.35;                     // NEW: lower default body/ATR threshold

  // logger (on if debug or log.enabled)
  const logger = createLogger({
    enabled: !!(debug || log?.enabled),
    level: log?.level ?? 'info',
    json: log?.json ?? true,
    basename: log?.basename
  });
  if (logger.on) logger.info({ type: 'ultra.init', preset, debug, useSessionWindows: _useSessionWindows });

  const windows = parseWindowsCSV(killzones);

  const api = ({ candles }) => {
    const bars = candles;
    const i = bars.length - 1;
    DBG.barsSeen++;
    const now = bars[i]?.time ?? Date.now();

    const baseCtx = { t: new Date(now).toISOString(), i, price: bars[i]?.close };

    if (i < Math.max(lookback, 200)) { rej('earlyWarmup'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'earlyWarmup' }); return null; }

    const m = minutesET(now);

    // Session fences
    if (cashSessionGuard) {
      const openET = 9 * 60 + 30, closeET = 16 * 60;
      if (!(m >= openET + firstMinGuard && m <= closeET - lastMinGuard)) {
        rej('timeFence'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'timeFence' }); return null;
      }
    } else {
      if (!(m >= firstMinGuard && m <= (24 * 60 - lastMinGuard))) {
        rej('timeFence'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'timeFence' }); return null;
      }
    }
    if (_useSessionWindows && !inWindowsET(now, windows)) {
      rej('windowFence'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'windowFence' }); return null;
    }

    // Bias
    const dBias = bias?.enabled ? chooseDailyBias(bars, bias) : 0;
    if (bias?.enabled && bias.gate === 'strict' && dBias === 0 && !_allowStrong) {
      rej('biasNeutralStrict'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'biasNeutralStrict', bias: dBias }); return null;
    }

    // Ranges
    const asian = computeAsianRangeTodayET(bars, i, 0, 5 * 60);
    const prevDay = computeDayRangeET(bars, i, -1);

    // ATR gate
    const A = atr(bars, Math.max(5, atrPeriod));
    const curATR = A[i];
    const price = bars[i].close;
    if (curATR === undefined) { rej('atrTooSmall'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'atrCalc' }); return null; }
    const atrBps = relBps(curATR, price);
    if (atrBps < _minAtrBps) { rej('atrTooSmall'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'atrTooSmall', atrBps, min: _minAtrBps }); return null; }

    // Sweep
    let sw = detectSweep(bars, i, { asian, prevDay, tolBps: sweepTolBps, swingFallbackLookback: 30 });
    if (!sw && !requireSweep) {
      const db = bias?.enabled ? dBias : 0;
      if (db !== 0) sw = { side: db > 0 ? 'long' : 'short', ref: bars[i].close, kind: 'nosweep' };
    }
    if (!sw) { rej('noSweep'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'noSweep' }); return null; }

    // Imbalance (IFVG preferred)
    const imb = recentImbalance(bars, i, _imbalanceLookback, preferIFVG);
    if (!imb) { rej('noImbalance'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'noImbalance' }); return null; }
    if ((sw.side === 'long' && imb.type !== 'bull') || (sw.side === 'short' && imb.type !== 'bear')) {
      rej('noImbalance'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'sideMismatch', sweepSide: sw.side, imbType: imb.type }); return null;
    }

    // Displacement checks
    const body = Math.abs(bars[i].close - bars[i].open);
    const bodyAtr = body / Math.max(1e-12, curATR);
    const imbSize = Math.abs(imb.top - imb.bottom);
    const imbBps  = relBps(imbSize, price);
    const fvgAtr = imbSize / Math.max(1e-12, curATR);
    const needFvgAtr = 0.9; // start at 0.9–1.1, tunable via opts
    if (imbBps < _fvgMinBps || bodyAtr < _minBodyAtr || fvgAtr < needFvgAtr) {
      rej('fvgTooSmall'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'fvgTooSmall', imbBps, bodyAtr, needBps: _fvgMinBps, needBodyAtr: _minBodyAtr });
      return null;
    }

    // micro BOS (optional/strictness controlled by requireMicroBOS boolean)
    if (_requireMicroBOS) {
      const dir = sw.side === 'long' ? 'up' : 'down';
      if (!microBOS(bars, i, dir, 20, 'wick')) { rej('microBosFail'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'microBosFail' }); return null; }
    }

    // PD array — NEW tolerance & mid check
    if (usePD && prevDay) {
      const tolAbs = price * (pdToleranceBps / 10000);
      const lo = prevDay.lo - tolAbs;
      const hi = prevDay.hi + tolAbs;
      const priceOK = (price >= lo && price <= hi);
      const midOK = imb ? (imb.mid >= lo && imb.mid <= hi) : false;
      if (!(priceOK || midOK)) {
        rej('pdFail'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'pdFail', pd: prevDay, tolBps: pdToleranceBps });
        return null;
      }
    }

    // OTE
    if (useOTE && imb) {
      const ph = recentSwing(bars, i, 'down', 30);
      const pl = recentSwing(bars, i, 'up', 30);
      let oteOK = true;
      if (sw.side === 'long' && pl) {
        const legA = pl.price, legB = price, len = legB - legA;
        const z1 = legA + len * oteLo, z2 = legA + len * oteHi;
        const lo = Math.min(z1, z2), hi = Math.max(z1, z2);
        oteOK = (imb.mid >= lo && imb.mid <= hi);
      } else if (sw.side === 'short' && ph) {
        const legA = ph.price, legB = price, len = legB - legA;
        const z1 = legA + len * oteLo, z2 = legA + len * oteHi;
        const lo = Math.min(z1, z2), hi = Math.max(z1, z2);
        oteOK = (imb.mid >= lo && imb.mid <= hi);
      }
      if (!oteOK) { rej('oteFail'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'oteFail' }); return null; }
    }

    // HTF confluence vs bias
    const biasAgree = (dBias > 0 && sw.side === 'long') || (dBias < 0 && sw.side === 'short');
    const htfOK = !bias?.enabled ? true :
      (bias.gate === 'soft' ? (biasAgree || dBias === 0) : (biasAgree || (_allowStrong && dBias === 0)));

    // Scoring
    let score = 0;
    if (sw) score += (confluence?.sweepPts ?? 0);
    if (imb) score += (confluence?.imbPts ?? 0);
    if (_requireMicroBOS) score += (confluence?.bosPts ?? 0);
    if (usePD) score += (confluence?.pdPts ?? 0);
    if (useOTE) score += (confluence?.otePts ?? 0);
    if (htfOK) score += (confluence?.htfPts ?? 0);

    if (score < (confluence?.minScore ?? 0)) {
      rej('scoreFail'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'scoreFail', score, minScore: confluence?.minScore ?? 0 });
      return null;
    }

    // Entry/Stop/TP
    const entry = (entryMode === 'ce') ? imb.mid : (sw.side === 'long' ? imb.bottom : imb.top);
    const minStopAbs = price * (minStopBps / 10000);
    const atrPad = atrMult * curATR;

    let stop;
    const swing = sw.side==='long' ? recentSwing(bars, i, 'up', 30) : recentSwing(bars, i, 'down', 30);
    const sweepRef = sw.ref ?? (sw.side==='long' ? Math.min(bars[i].low, imb.bottom) : Math.max(bars[i].high, imb.top));
    const sweepBuf = 0.25 * curATR; // tunable
    let structStop = sw.side==='long'
        ? Math.min(sweepRef - sweepBuf, (swing?.price ?? entry) - sweepBuf)
        : Math.max(sweepRef + sweepBuf, (swing?.price ?? entry) + sweepBuf);
    // then enforce minStopAbs & ATR pad as you already do, finally:
    stop = sw.side==='long' ? Math.min(structStop, entry - minStopAbs, entry - atrPad)
                            : Math.max(structStop, entry + minStopAbs, entry + atrPad);

    const risk = Math.abs(entry - stop);
    if (risk <= 1e-8) { rej('scoreFail'); logger.debug?.({ ...baseCtx, evt: 'reject', reason: 'riskZero' }); return null; }
    const takeProfit = sw.side === 'long' ? (entry + rr * risk) : (entry - rr * risk);

    const strongBias = bias?.enabled && bias.gate === 'strict' && (dBias !== 0);
    const veryStrongSetup = score >= Math.max((confluence?.minScore ?? 0) + 2, 4);

    DBG.accepted++;

    const out = {
      side: sw.side,
      entry, stop, takeProfit,
      _initRisk: risk,
      _rr: rr,
      _breakevenAtR: strongBias && veryStrongSetup ? Math.max(1.0, breakevenAtR) : breakevenAtR,
      _trailAfterR:  strongBias && veryStrongSetup ? Math.max(1.5, trailAfterR)  : trailAfterR,
      _cooldownBars: cooldownBars,
      _maxBarsInTrade: 45,
      _maxHoldMin: 360,
      _entryExpiryBars: entryExpiryBars,

      // helpful extras for the engine’s entry chase logic
      _imb: { mid: imb.mid },
    };

    // rich acceptance log
    logger.info({
      ...baseCtx,
      evt: 'accept',
      sweep: sw,
      imb: { type: imb.type, top: imb.top, bottom: imb.bottom, mid: imb.mid, inverse: !!imb.inverse },
      bias: dBias,
      htfOK,
      score,
      atrBps,
      bodyAtr,
      entryMode,
      rr,
      levels: { entry, stop, tp: takeProfit }
    });

    return out;
  };

  // footer when process ends
  if (logger.on && typeof process !== 'undefined') {
    process.on('exit', () => {
      logger.info({ type: 'ultra.done', accepted: DBG.accepted, barsSeen: DBG.barsSeen });
      logger.close?.();
      console.log(`[ultra log] saved to ${logger.path}`);
    });
  }

  return api;
}

export default ultraSignalFactory;
