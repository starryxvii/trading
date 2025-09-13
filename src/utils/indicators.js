// src/utils/indicators.js

export function ema(values, period = 14) {
  const n = Math.max(1, period | 0);
  const out = new Array(values.length);
  if (!values?.length) return [];

  // Seed with SMA(period) to avoid early bias
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = i === 0 ? 0 : out[i - 1];
      continue;
    }
    if (i < n) {
      sum += v;
      if (i === n - 1) {
        const sma = sum / n;
        out[i] = sma;
      } else {
        out[i] = v; // light warmup
      }
    } else {
      const k = 2 / (n + 1);
      out[i] = v * k + out[i - 1] * (1 - k);
    }
  }
  return out;
}

export function swingHigh(bars, i, left = 2, right = 2) {
  if (i < left || i + right >= bars.length) return false;
  const hi = bars[i].high;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (bars[j].high >= hi) return false;
  }
  return true;
}
export function swingLow(bars, i, left = 2, right = 2) {
  if (i < left || i + right >= bars.length) return false;
  const lo = bars[i].low;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (bars[j].low <= lo) return false;
  }
  return true;
}

export function detectFVG(bars, i) {
  if (i < 2) return null;
  const c0 = bars[i - 2];
  const c2 = bars[i];
  if (c0.high < c2.low) {
    return { type: 'bull', top: c0.high, bottom: c2.low, mid: (c0.high + c2.low) / 2 };
  }
  if (c0.low > c2.high) {
    return { type: 'bear', top: c2.high, bottom: c0.low, mid: (c2.high + c0.low) / 2 };
  }
  return null;
}

export function lastSwing(bars, i, dir) {
  for (let k = i - 1; k >= 0; k--) {
    if (dir === 'up' && swingLow(bars, k))  return { idx: k, price: bars[k].low  };
    if (dir === 'down' && swingHigh(bars, k)) return { idx: k, price: bars[k].high };
  }
  return null;
}
export function structureState(bars, i) {
  const lastLow = lastSwing(bars, i, 'up');
  const lastHigh = lastSwing(bars, i, 'down');
  return { lastLow, lastHigh };
}

export function atr(bars, period = 14) {
  if (!bars?.length || period <= 0) return [];
  const trs = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { trs[i] = bars[i].high - bars[i].low; continue; }
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = new Array(trs.length);
  let prev;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      out[i] = undefined;
      if (i === period - 1) {
        let s = 0; for (let k = 0; k < period; k++) s += trs[k];
        const seed = s / period;
        out[i] = seed; prev = seed;
      }
    } else {
      const v = (prev * (period - 1) + trs[i]) / period;
      out[i] = v; prev = v;
    }
  }
  return out;
}

export const bpsOf = (price, bps) => price * (bps / 10000);
export const pct = (a, b) => (a - b) / b;
