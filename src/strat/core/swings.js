// src/strat/core/swings.js
import { swingHigh, swingLow, bpsOf } from '../../utils/indicators.js';

export function recentSwing(bars,i,dir,lookback=20){
  const start=Math.max(2,i-lookback);
  for(let k=i-1;k>=start;k--){
    if(dir==='down' && swingHigh(bars,k)) return { idx:k, price:bars[k].high };
    if(dir==='up'   && swingLow(bars,k))  return { idx:k, price:bars[k].low };
  }
  return null;
}

export function microBOS(bars,i,dir,lookback=20,mode='close'){
  const sw = dir==='up' ? recentSwing(bars,i,'down',lookback) : recentSwing(bars,i,'up',lookback);
  if(!sw) return false;
  const c=bars[i];
  if (mode === 'wick') return dir==='up' ? (c.high > sw.price) : (c.low < sw.price);
  return dir==='up' ? (c.close > sw.price) : (c.close < sw.price);
}

// sweep helpers
function sweptAboveN(level,bars,i,N=3,tolBps=0){
  const tol=bpsOf(level,tolBps); let pierced=false;
  for(let k=Math.max(0,i-N+1);k<=i;k++) if(bars[k].high >= level+tol) pierced=true;
  return pierced && bars[i].close < level;
}
function sweptBelowN(level,bars,i,N=3,tolBps=0){
  const tol=bpsOf(level,tolBps); let pierced=false;
  for(let k=Math.max(0,i-N+1);k<=i;k++) if(bars[k].low <= level-tol) pierced=true;
  return pierced && bars[i].close > level;
}

/**
 * Detects a liquidity sweep around important levels.
 * Accepts asian, prevDay and *extra session levels* (array of {name, hi?, lo?}).
 */
export function detectSweep(
  bars,
  i,
  { asian, prevDay, extraLevels = [], tolBps=2, swingFallbackLookback=20, nBars=3 }
){
  const levels=[];
  if(asian?.hi)   levels.push({ dir:'down', level:asian.hi, tag:'asia' });
  if(asian?.lo)   levels.push({ dir:'up',   level:asian.lo, tag:'asia' });
  if(prevDay?.hi) levels.push({ dir:'down', level:prevDay.hi, tag:'prevDay' });
  if(prevDay?.lo) levels.push({ dir:'up',   level:prevDay.lo, tag:'prevDay' });

  for (const s of extraLevels) {
    if (Number.isFinite(s?.hi)) levels.push({ dir:'down', level:s.hi, tag:s.name || 'session' });
    if (Number.isFinite(s?.lo)) levels.push({ dir:'up',   level:s.lo, tag:s.name || 'session' });
  }

  for(const L of levels){
    if(L.dir==='down' && sweptAboveN(L.level,bars,i,nBars,tolBps)) return { side:'short', ref:L.level, kind:L.tag };
    if(L.dir==='up'   && sweptBelowN(L.level,bars,i,nBars,tolBps)) return { side:'long',  ref:L.level, kind:L.tag };
  }

  // swing fallback
  const ph = recentSwing(bars,i,'down',swingFallbackLookback);
  const pl = recentSwing(bars,i,'up',  swingFallbackLookback);
  if(ph && sweptAboveN(ph.price,bars,i,nBars,tolBps)) return { side:'short', ref:ph.price, kind:'swingHi' };
  if(pl && sweptBelowN(pl.price,bars,i,nBars,tolBps)) return { side:'long',  ref:pl.price, kind:'swingLo' };
  return null;
}
