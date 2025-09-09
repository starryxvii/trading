// SMC + More V1 - 2025-09-07.
/*
┌───────────────┬────────────┐
│ (index)       │ Values     │
├───────────────┼────────────┤
│ Symbol        │ 'BTC'      │
│ Trades        │ 82         │
│ WinRate       │ '65.9%'    │
│ ProfitFactor  │ '1.62'     │
│ Expectancy    │ '13.82'    │
│ TotalR        │ '8.69'     │
│ AvgR          │ '0.106'    │
│ PnL           │ '1253.36'  │
│ ReturnPct     │ '12.53%'   │
│ MaxDDPct      │ '3.36%'    │
│ Calmar        │ '3.73'     │
│ Sharpe_tr     │ '0.20'     │
│ Sortino_tr    │ '0.32'     │
│ AvgHoldMin    │ '153.29'   │
│ ExposurePct   │ '78.59%'   │
│ MaxWinStreak  │ 9          │
│ MaxLossStreak │ 4          │
│ StartEquity   │ '10000.00' │
│ FinalEquity   │ '11253.36' │
└───────────────┴────────────┘
*/

import { isSession } from '../utils/time.js';
import { swingHigh, swingLow, atr, ema, bpsOf } from '../utils/indicators.js';

/* ---------- windows ---------- */
function parseWindowsCSV(csv) {
  if (!csv) return null;
  return csv.split(',').map(s => s.trim()).map(w => {
    const [a, b] = w.split('-').map(x => x.trim());
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return { aMin: ah * 60 + am, bMin: bh * 60 + bm };
  });
}
function minutesET(date) {
  const d = new Date(date);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return ((h - 4 + 24) % 24) * 60 + m;
}
function inWindowsET(timeMs, windows) {
  if (!windows || !windows.length) return true;
  const m = minutesET(timeMs);
  return windows.some(w => m >= w.aMin && m <= w.bMin);
}
function withinIntraDayGuard(timeMs, firstMin = 15, lastMin = 10) {
  const m = minutesET(timeMs);
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return (m >= open + firstMin) && (m <= close - lastMin);
}

/* ---------- swings ---------- */
function findPriorSwing(bars, i, dir, lookback) {
  const start = Math.max(2, i - lookback);
  for (let k = i - 3; k >= start; k--) {
    if (dir === 'down' && swingHigh(bars, k)) return { idx: k, price: bars[k].high };
    if (dir === 'up'   && swingLow(bars,  k)) return { idx: k, price: bars[k].low  };
  }
  return null;
}

/* ---------- FVG ---------- */
function fvgAt(bars, n) {
  if (n < 2) return null;
  const a = bars[n - 2], c = bars[n];
  if (a.high < c.low)  return { type: 'bull', top: a.high, bottom: c.low,  mid: (a.high + c.low)/2,  i: n, soft: false };
  if (a.low  > c.high) return { type: 'bear', top: c.high, bottom: a.low,  mid: (c.high + a.low)/2, i: n, soft: false };
  return null;
}
function fvgAtSoft(bars, n, tolAbs) {
  if (n < 2) return null;
  const a = bars[n - 2], c = bars[n];
  if (a.high <= c.low + tolAbs)  return { type: 'bull', top: a.high, bottom: c.low, mid: (a.high + c.low)/2, i: n, soft: true };
  if (a.low  >= c.high - tolAbs) return { type: 'bear', top: c.high, bottom: a.low, mid: (c.high + a.low)/2, i: n, soft: true };
  return null;
}
function recentFVGFlexible(bars, i, lookback, tolAbs, mode = 'strict') {
  for (let n = i; n >= Math.max(2, i - lookback + 1); n--) {
    const strict = fvgAt(bars, n);
    if (strict) return strict;
    if (mode === 'soft') {
      const soft = fvgAtSoft(bars, n, tolAbs);
      if (soft) return soft;
    }
  }
  return null;
}

/* ---------- aggregation (HTF & bias) ---------- */
function aggregateMinutes(bars, minutes) {
  if (!bars?.length || minutes <= 0) return bars || [];
  const step = minutes * 60 * 1000;
  const out = [];
  let bucket = null, bucketEnd = 0;

  for (const b of bars) {
    const tEnd = Math.floor(b.time / step) * step + step;
    if (!bucket || tEnd !== bucketEnd) {
      if (bucket) out.push(bucket);
      bucket = { time: tEnd, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
      bucketEnd = tEnd;
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low  = Math.min(bucket.low,  b.low);
      bucket.close = b.close;
      bucket.volume += (b.volume ?? 0);
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

/* ---------- bias helpers ---------- */
function slopeBps(a, b) {
  const denom = Math.max(1e-12, a);
  return ((b - a) / denom) * 10000;
}
function computeBiasOnTF(bars, minutes, emaPeriod, bandBps, minSlopeBps) {
  // +1 bull, -1 bear, 0 neutral
  const htf = aggregateMinutes(bars, minutes);
  if (htf.length < emaPeriod + 2) return 0;

  const closes = htf.map(b => b.close);
  const e = ema(closes, emaPeriod);
  const j = htf.length - 1;
  const price = closes[j];
  const k = e[j];
  if (k === undefined) return 0;

  const bandAbs = bandBps > 0 ? price * (bandBps / 10000) : 0;
  const passBandBull  = price >= (k - bandAbs);
  const passBandBear  = price <= (k + bandAbs);

  const s = slopeBps(closes[j - 1] ?? price, price);
  const trendUp   = s >= (minSlopeBps ?? 0);
  const trendDown = s <= -(minSlopeBps ?? 0);

  if (passBandBull && trendUp)   return  +1;
  if (passBandBear && trendDown) return  -1;
  return 0;
}
function chooseDailyBias(bars, biasCfg) {
  const {
    enabled = true,
    emaPeriod = 50,
    slopeBps = 1,
    htf4h = 240,
    htf1h = 60,
    fallback15m = 15,
    bandBps = 8
  } = biasCfg || {};
  if (!enabled) return 0;

  const b4h = computeBiasOnTF(bars, htf4h, emaPeriod, bandBps, slopeBps);
  const b1h = computeBiasOnTF(bars, htf1h, emaPeriod, bandBps, slopeBps);
  if (b4h !== 0 && b4h === b1h) return b4h;

  // rotate down to 15m if disagreement/inconclusive
  const b15 = computeBiasOnTF(bars, fallback15m, emaPeriod, bandBps, slopeBps);
  return b15; // can be 0 (neutral -> skip)
}

/* ---------- signal ---------- */
export function smcSignalFactory(opts = {}) {
  const {
    session = 'NYSE',
    useSession = true,

    lookback = 200,
    fvgLookback = 8,
    toleranceBps = 5,
    requirePrevCloseOutside = false,
    entry = 'edge',

    trendBias = 'ema',
    emaPeriod = 34,
    slowEmaPeriod = 200,
    emaBandBps = 3,

    minFvgBps = 5,
    minDisplacementBps = 6,
    minSweepBps = 4,
    minAtrBps = 8,
    minFvgAtrMult = 0.25,

    rr = 2,
    breakevenAtR = 1.0,
    trailAfterR = 1.5,
    cooldownBars = 4,

    riskByATR = true,
    atrPeriod = 14,
    atrMult = 1.0,
    minStopBps = 4,
    entryOffsetBps = 0,

    sessionWindow = '',
    firstMinGuard = 15,
    lastMinGuard = 10,

    useHTF = true,
    htfMinutes = 30,
    htfEmaPeriod = 50,
    htfSlopeBps = 0,
    htfBandBps = 6,

    requireSweep = false,
    requireBOS = false,
    gateMode = 'any',
    fvgMode = 'soft',
    fvgTolBps = 2,

    minBarsBetweenSignals = 0,
    timeStopBars = 45,

    htfBandBpsShort = htfBandBps,
    htfBandBpsLong  = htfBandBps,

    // NEW: multi-timeframe bias + confluence scoring
    bias = { enabled: true, gate: 'strict', emaPeriod: 50, slopeBps: 1, htf4h: 240, htf1h: 60, fallback15m: 15, bandBps: 8 },
    confluence = { minScore: 2, fvgPts: 1, dispPts: 1, sweepPts: 1, bosPts: 1, htfBandPts: 1 },

    debug = false
  } = opts;

  const windows = parseWindowsCSV(sessionWindow);
  const counters = {
    timeGuard: 0, cooldown: 0, rateLimited: 0,
    noSwing: 0, noFVG: 0, fvgSmall: 0, fvgATR: 0, dispSmall: 0, atrLow: 0,
    trendFailLong: 0, trendFailShort: 0, htfFailLong: 0, htfFailShort: 0,
    sweepTooSmall: 0, noBOS: 0,
    biasSkip: 0, confSkip: 0
  };
  let lastSignalIndex = -1;

  const pickEntry = (f, eMode = entry, offAbs = 0) =>
    eMode === 'edge'
      ? (f.type === 'bull' ? (f.bottom + offAbs) : (f.top - offAbs))
      : f.mid;

  const api = ({ candles }) => {
    const bars = candles;
    const i = bars.length - 1;
    if (i < 200) return null;

    const now = bars[i].time;
    if (useSession && !isSession(now, session)) return null;
    if (!inWindowsET(now, windows)) return null;
    if (!withinIntraDayGuard(now, firstMinGuard, lastMinGuard)) { counters.timeGuard++; return null; }

    if (minBarsBetweenSignals > 0 && lastSignalIndex >= 0 && (i - lastSignalIndex) < minBarsBetweenSignals) {
      counters.rateLimited++; return null;
    }

    // ---------- NEW: multi-timeframe bias gate ----------
    const dailyBias = chooseDailyBias(bars, bias); // +1 bull, -1 bear, 0 neutral
    if (bias?.enabled && dailyBias === 0) { counters.biasSkip++; return null; }

    // ---------- EMA trend filters (your original) ----------
    const closes = bars.map(b => b.close);
    const fast = ema(closes, emaPeriod);
    const slow = ema(closes, slowEmaPeriod);
    const price = bars[i].close;
    const bandAbs = (emaBandBps > 0 ? price * (emaBandBps / 10000) : 0);

    const passEMA     = (v, cmp, side) => (v === undefined ? true : (side === 'long' ? price >= (v - cmp) : price <= (v + cmp)));
    const passEMAcross= (f, s, side) => (f === undefined || s === undefined) ? true : (side === 'long' ? (f > s && price >= (f - bandAbs)) : (f < s && price <= (f + bandAbs)));

    const trendMap = {
      'none':     { long: () => true,                                 short: () => true },
      'ema':      { long: () => passEMA(fast[i], bandAbs, 'long'),     short: () => passEMA(fast[i], bandAbs, 'short') },
      'ema-slow': { long: () => passEMA(slow[i], bandAbs, 'long'),     short: () => passEMA(slow[i], bandAbs, 'short') },
      'ema-xover':{
        long:  () => passEMAcross(fast[i], slow[i], 'long'),
        short: () => passEMAcross(fast[i], slow[i], 'short')
      }
    };

    let htfOKLong = true, htfOKShort = true;
    if (useHTF && htfMinutes > 0) {
      const window = Math.min(bars.length, 2000);
      const htfBars = aggregateMinutes(bars.slice(-window), htfMinutes);
      const htfCloses = htfBars.map(b => b.close);
      const htfE = ema(htfCloses, htfEmaPeriod);
      const j = htfBars.length - 1;

      if (j > 0 && htfE[j] !== undefined) {
        const slope = slopeBps(htfCloses[j - 1], htfCloses[j]);
        const slopePassLong  = htfSlopeBps > 0 ? (slope >=  htfSlopeBps) : true;
        const slopePassShort = htfSlopeBps > 0 ? (slope <= -htfSlopeBps) : true;

        const htfBandAbsLong  = (htfBandBpsLong  > 0 ? htfCloses[j] * (htfBandBpsLong  / 10000) : 0);
        const htfBandAbsShort = (htfBandBpsShort > 0 ? htfCloses[j] * (htfBandBpsShort / 10000) : 0);
        htfOKLong  = (htfCloses[j] >= (htfE[j] - htfBandAbsLong))  && slopePassLong;
        htfOKShort = (htfCloses[j] <= (htfE[j] + htfBandAbsShort)) && slopePassShort;
      }
    }

    const longOK  = (trendMap[trendBias]?.long  ?? (() => true))();
    const shortOK = (trendMap[trendBias]?.short ?? (() => true))();
    if (!longOK) counters.trendFailLong++;
    if (!shortOK) counters.trendFailShort++;
    if (!htfOKLong) counters.htfFailLong++;
    if (!htfOKShort) counters.htfFailShort++;

    // ---------- structure: swings, sweep, BOS, FVG ----------
    const ph = findPriorSwing(bars, i, 'down', lookback);
    const pl = findPriorSwing(bars, i, 'up',   lookback);
    if (!ph && !pl) { counters.noSwing++; return null; }

    const c  = bars[i];
    const p1 = bars[i - 1];

    const tolH = ph ? bpsOf(ph.price, toleranceBps) : 0;
    const tolL = pl ? bpsOf(pl.price, toleranceBps) : 0;

    const sweptHigh = ph
      ? (c.high >= (ph.price - tolH)) && (c.close < (ph.price + tolH)) &&
        (!requirePrevCloseOutside || p1.close > (ph.price + tolH))
      : false;

    const sweptLow  = pl
      ? (c.low  <= (pl.price + tolL)) && (c.close > (pl.price - tolL)) &&
        (!requirePrevCloseOutside || p1.close < (pl.price - tolL))
      : false;

    if (requireSweep) {
      const body = Math.abs(c.close - c.open);
      const bodyBps = (body / Math.max(1e-12, price)) * 10000;
      const minSweep = Math.max(0, minSweepBps - Math.min(2, Math.floor(bodyBps / 4)));
      if (sweptHigh && ph) {
        const sw = ((c.high - ph.price) / ph.price) * 10000;
        if (sw < minSweep) { counters.sweepTooSmall++; return null; }
      }
      if (sweptLow && pl) {
        const sw = ((pl.price - c.low) / pl.price) * 10000;
        if (sw < minSweep) { counters.sweepTooSmall++; return null; }
      }
    }

    const midPrice = price || 1e-9;
    const tolAbs = (fvgTolBps > 0 ? (midPrice * (fvgTolBps / 10000)) : 0);
    const fvg = recentFVGFlexible(bars, i, fvgLookback, tolAbs, fvgMode);
    if (!fvg) { counters.noFVG++; return null; }

    const fvgSize = Math.abs(fvg.top - fvg.bottom);
    const fvgBps  = (fvgSize / midPrice) * 10000;
    const body = Math.abs(c.close - c.open);
    const bodyBps = (body / midPrice) * 10000;

    let curATR;
    if (minAtrBps > 0 || riskByATR || minFvgAtrMult > 0) {
      const A = atr(bars, Math.max(5, atrPeriod));
      curATR = A[i];
      if (minAtrBps > 0) {
        if (curATR === undefined) { counters.atrLow++; return null; }
        const atrBps = (curATR / midPrice) * 10000;
        if (atrBps < minAtrBps) { counters.atrLow++; return null; }
      }
    }

    const atrAbs = (curATR ?? 0);
    const passesBps = (minFvgBps <= 0) || (fvgBps >= minFvgBps);
    const passesAtr = (minFvgAtrMult > 0 && atrAbs > 0) ? (fvgSize >= minFvgAtrMult * atrAbs) : false;
    if (!(passesBps || passesAtr)) {
      if (!passesBps) counters.fvgSmall++;
      if (!passesAtr && minFvgAtrMult > 0) counters.fvgATR++;
      return null;
    }
    if (minDisplacementBps > 0 && bodyBps < minDisplacementBps) { counters.dispSmall++; return null; }

    let bosPass = true;
    if (requireBOS) {
      bosPass = true;
      if (fvg.type === 'bull' && ph) bosPass = c.close > (ph.price + tolH);
      if (fvg.type === 'bear' && pl) bosPass = c.close < (pl.price - tolL);
      if (!bosPass) { counters.noBOS++; }
    }

    const sweepPassLong  = requireSweep ? sweptLow  : true;
    const sweepPassShort = requireSweep ? sweptHigh : true;

    const structureOK = (() => {
      const wantSweep = requireSweep;
      const wantBOS = requireBOS;
      if (!wantSweep && !wantBOS) return true;
      if (gateMode === 'all') {
        return (fvg.type === 'bull')
          ? (sweepPassLong && bosPass)
          : (sweepPassShort && bosPass);
      } else {
        return (fvg.type === 'bull')
          ? (sweepPassLong || bosPass)
          : (sweepPassShort || bosPass);
      }
    })();
    if (!structureOK) return null;

    // ---------- NEW: confluence scoring & bias gating ----------
    let confScore = 0;
    if (passesBps || passesAtr) confScore += (confluence?.fvgPts ?? 0);
    if (bodyBps >= (minDisplacementBps || 0)) confScore += (confluence?.dispPts ?? 0);
    if ((fvg.type === 'bull' && sweepPassLong) || (fvg.type === 'bear' && sweepPassShort)) confScore += (confluence?.sweepPts ?? 0);
    if (requireBOS && bosPass) confScore += (confluence?.bosPts ?? 0);
    if ((fvg.type === 'bull' && htfOKLong) || (fvg.type === 'bear' && htfOKShort)) {
      confScore += (confluence?.htfBandPts ?? 0);
    }

    const minScore = confluence?.minScore ?? 0;
    if (confScore < minScore) { counters.confSkip++; return null; }

    // **Bias direction hard gate (strict) or soft (allow only if very strong)**
    const biasGate = (side) => {
      if (!bias?.enabled) return true;
      if (bias?.gate === 'soft') {
        const agrees = (dailyBias > 0 && side === 'long') || (dailyBias < 0 && side === 'short');
        return agrees || confScore >= Math.max(minScore + 1, 3);
      }
      return (dailyBias > 0 && side === 'long') || (dailyBias < 0 && side === 'short');
    };

    const strongBias = Math.abs(dailyBias) === 1 && (bias?.gate === 'strict');
    const veryStrongSetup = confScore >= Math.max((confluence?.minScore ?? 0) + 2, 4);

    const makePos = (side, e, stop, tp) => ({
      side, entry: e, stop, takeProfit: tp,
      _breakevenAtR: strongBias && veryStrongSetup ? 1.2 : 1.0,
      _trailAfterR:  strongBias && veryStrongSetup ? 1.8 : 1.2,
      _initRisk: Math.max(1e-8, side === 'long' ? (e - stop) : (stop - e)),
      _cooldownBars: cooldownBars,
      _rr: rr,
      _maxBarsInTrade: timeStopBars,
      _maxHoldMin: 360 // wall-clock guard for live trading; broker will enforce
    });

    const offAbs = entryOffsetBps > 0 ? midPrice * (entryOffsetBps / 10000) : 0;

    if (fvg.type === 'bull' && longOK && htfOKLong && biasGate('long')) {
      let e = pickEntry(fvg, entry, offAbs);
      let stop = Math.min(pl?.price ?? e, c.low);
      const minStopAbs = e * (minStopBps / 10000);
      stop = Math.min(stop, e - minStopAbs);
      if (riskByATR && curATR) stop = Math.min(stop, e - atrMult * curATR);
      const tp = e + (rr * (e - stop));
      if (stop < e) return makePos('long', e, stop, tp);
    }

    if (fvg.type === 'bear' && shortOK && htfOKShort && biasGate('short')) {
      let e = pickEntry(fvg, entry, offAbs);
      let stop = Math.max(ph?.price ?? e, c.high);
      const minStopAbs = e * (minStopBps / 10000);
      stop = Math.max(stop, e + minStopAbs);
      if (riskByATR && curATR) stop = Math.max(stop, e + atrMult * curATR);
      const tp = e - (rr * (stop - e));
      if (stop > e) return makePos('short', e, stop, tp);
    }

    if (debug && i % 500 === 0) {
      console.log('[smc counters]', counters);
    }
    return null;
  };

  api.getCounters = () => ({ ...counters });
  return api;
}
