// Core helper utilities for backtest engine

/**
 * Apply a trade fill with configurable slippage "kind":
 *  - 'market' (default): use configured slippageBps
 *  - 'limit' : much smaller slippage (price improvement realistically near zero)
 *  - 'stop'  : slightly worse than market to reflect stop-market slips
 */
export function applyFill(price, side, { slippageBps = 0, feeBps = 0, kind = 'market' } = {}) {
  let effBps = slippageBps;
  if (kind === 'limit') effBps *= 0.25;   // friendlier fills on limit hits
  if (kind === 'stop')  effBps *= 1.25;   // worse fills on stop-outs

  const slip = (effBps / 10000) * price;
  const filled = side === 'long' ? price + slip : price - slip;
  const feePerUnit = (feeBps / 10000) * Math.abs(filled);
  return { price: filled, fee: feePerUnit };
}

export function clampStop(mktPrice, proposedStop, side, oco) {
  const eps = (oco?.clampEpsBps ?? 0.25) / 10000;
  const epsAbs = mktPrice * eps;
  return side === 'long'
    ? Math.min(proposedStop, mktPrice - epsAbs)
    : Math.max(proposedStop, mktPrice + epsAbs);
}

export function touchedLimit(side, limitPx, bar, mode = 'intrabar') {
  if (mode === 'close') {
    return side === 'long' ? (bar.close <= limitPx) : (bar.close >= limitPx);
  }
  return side === 'long' ? (bar.low <= limitPx) : (bar.high >= limitPx);
}

export function ocoExitCheck({ side, stop, tp, bar, mode = 'intrabar', tieBreak = 'pessimistic' }) {
  if (mode === 'close') {
    const px = bar.close;
    if (side === 'long') {
      if (px <= stop) return { hit: 'SL', px: stop };
      if (px >= tp)   return { hit: 'TP', px: tp };
    } else {
      if (px >= stop) return { hit: 'SL', px: stop };
      if (px <= tp)   return { hit: 'TP', px: tp };
    }
    return { hit: null, px: null };
  }
  const hi = bar.high, lo = bar.low;
  const hitSL = side === 'long' ? (lo <= stop) : (hi >= stop);
  const hitTP = side === 'long' ? (hi >= tp)   : (lo <= tp);
  if (hitSL && hitTP) return tieBreak === 'optimistic' ? { hit: 'TP', px: tp } : { hit: 'SL', px: stop };
  if (hitSL) return { hit: 'SL', px: stop };
  if (hitTP) return { hit: 'TP', px: tp };
  return { hit: null, px: null };
}

export function isEODBar(ms) {
  const d = new Date(ms - 4 * 60 * 60 * 1000); // crude ET
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= 16 * 60; // 16:00 ET
}

export const roundStep = (x, step = 0.001) => Math.floor(x / step) * step;

export function estimateBarMs(candles) {
  if (candles.length >= 50) {
    const deltas = [];
    for (let i = 1; i < Math.min(candles.length, 500); i++) {
      const d = candles[i].time - candles[i - 1].time;
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }
    if (deltas.length) {
      deltas.sort((a, b) => a - b);
      const mid = Math.floor(deltas.length / 2);
      const med = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
      return Math.max(60e3, Math.min(med, 60 * 60e3)); // clamp 1m..60m
    }
  }
  return 5 * 60 * 1000; // fallback
}

export const ymdUTC = (ms) => {
  const d = new Date(ms);
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return `${d.getUTCFullYear()}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};
