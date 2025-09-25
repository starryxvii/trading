// src/strat/core/bias.js
import { ema } from '../../utils/indicators.js';
import { aggregateMinutes, slopeBps } from './utils.js';

export function computeBiasOnTF(bars, minutes, emaPeriod, bandBps, minSlopeBps) {
  const htf = aggregateMinutes(bars, minutes);
  if (htf.length < emaPeriod + 2) return 0;

  const closes = htf.map(b => b.close);
  const e = ema(closes, emaPeriod);

  const j = htf.length - 1;
  const price = closes[j];
  const k = e[j];
  if (k === undefined) return 0;

  // Symmetric band around EMA:
  //  - Bull passes only if price is ABOVE (EMA + band)
  //  - Bear passes only if price is BELOW (EMA - band)
  const bandAbs = bandBps > 0 ? price * (bandBps / 10000) : 0;
  const passBull = price >= (k + bandAbs);
  const passBear = price <= (k - bandAbs);

  // Simple slope filter on the TF
  const s = slopeBps(closes[j - 1] ?? price, price);
  const up = s >= (minSlopeBps ?? 0);
  const dn = s <= -(minSlopeBps ?? 0);

  if (passBull && up) return +1;
  if (passBear && dn) return -1;
  return 0;
}

export function chooseDailyBias(bars, cfg) {
  const {
    emaPeriod = 50,
    slopeBps = 1,
    htf4h = 240,
    htf1h = 60,
    fallback15m = 15,
    bandBps = 8
  } = cfg || {};

  const b4h = computeBiasOnTF(bars, htf4h, emaPeriod, bandBps, slopeBps);
  const b1h = computeBiasOnTF(bars, htf1h, emaPeriod, bandBps, slopeBps);

  // If both higher TFs agree and are non-neutral, use them; else fall back.
  if (b4h !== 0 && b4h === b1h) return b4h;
  return computeBiasOnTF(bars, fallback15m, emaPeriod, bandBps, slopeBps);
}
