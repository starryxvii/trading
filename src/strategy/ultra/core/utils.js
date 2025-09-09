// src/strategy/ultra/core/utils.js
import { minutesET } from '../../../utils/time.js';

export const relBps = (x, ref) => (x / Math.max(1e-12, ref)) * 10000;
export const mid = (a, b) => (a + b) / 2;

export function etDateStr(ms) {
  const d = new Date(ms - 4 * 60 * 60 * 1000); // crude ET
  return d.toISOString().slice(0, 10);
}

export function parseWindowsCSV(csv) {
  if (!csv) return null;
  return csv.split(',').map(s => s.trim()).map(w => {
    const [a, b] = w.split('-').map(x => x.trim());
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return { aMin: ah * 60 + am, bMin: bh * 60 + bm };
  });
}
export function inWindowsET(ms, windows) {
  if (!windows?.length) return true;
  const m = minutesET(ms);
  return windows.some(w => m >= w.aMin && m <= w.bMin);
}

export const slopeBps = (a, b) => ((b - a) / Math.max(1e-12, a)) * 10000;

export function aggregateMinutes(bars, minutes) {
  if (!bars?.length || minutes <= 0) return bars || [];
  const step = minutes * 60 * 1000;
  const out = [];
  let bucket = null, end = 0;
  for (const b of bars) {
    const tEnd = Math.floor(b.time / step) * step + step;
    if (!bucket || tEnd !== end) {
      if (bucket) out.push(bucket);
      bucket = { time: tEnd, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
      end = tEnd;
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
