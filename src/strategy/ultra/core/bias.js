// src/strategy/ultra/core/bias.js
import { ema } from '../../../utils/indicators.js';
import { aggregateMinutes, slopeBps } from './utils.js';

export function computeBiasOnTF(bars, minutes, emaPeriod, bandBps, minSlopeBps){
  const htf = aggregateMinutes(bars, minutes);
  if (htf.length < emaPeriod + 2) return 0;
  const closes = htf.map(b => b.close);
  const e = ema(closes, emaPeriod);
  const j = htf.length - 1, price = closes[j], k = e[j];
  if (k === undefined) return 0;

  const bandAbs = bandBps > 0 ? price * (bandBps / 10000) : 0;
  const passBull = price >= (k - bandAbs);
  const passBear = price <= (k + bandAbs);
  const s = slopeBps(closes[j - 1] ?? price, price);
  const up = s >= (minSlopeBps ?? 0), dn = s <= -(minSlopeBps ?? 0);
  if (passBull && up) return +1;
  if (passBear && dn) return -1;
  return 0;
}

export function chooseDailyBias(bars, cfg){
  const { emaPeriod=50, slopeBps=1, htf4h=240, htf1h=60, fallback15m=15, bandBps=8 } = cfg || {};
  const b4h = computeBiasOnTF(bars, htf4h, emaPeriod, bandBps, slopeBps);
  const b1h = computeBiasOnTF(bars, htf1h, emaPeriod, bandBps, slopeBps);
  if (b4h !== 0 && b4h === b1h) return b4h;
  return computeBiasOnTF(bars, fallback15m, emaPeriod, bandBps, slopeBps);
}
