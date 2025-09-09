// src/strategy/ultra/lib/sweep.js
import { bpsOf } from '../../../utils/indicators.js';
import { recentSwing } from './swings.js';

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

export function detectSweep(bars,i,{ asian, prevDay, tolBps=2, swingFallbackLookback=20, nBars=3 }){
  const levels=[];
  if(asian?.hi)   levels.push({ dir:'down', level:asian.hi });
  if(asian?.lo)   levels.push({ dir:'up',   level:asian.lo });
  if(prevDay?.hi) levels.push({ dir:'down', level:prevDay.hi });
  if(prevDay?.lo) levels.push({ dir:'up',   level:prevDay.lo });

  for(const L of levels){
    if(L.dir==='down' && sweptAboveN(L.level,bars,i,nBars,tolBps)) return { side:'short', ref:L.level, kind:L.tag??'day/asia' };
    if(L.dir==='up'   && sweptBelowN(L.level,bars,i,nBars,tolBps)) return { side:'long',  ref:L.level, kind:L.tag??'day/asia' };
  }
  const ph = recentSwing(bars,i,'down',swingFallbackLookback);
  const pl = recentSwing(bars,i,'up',  swingFallbackLookback);
  if(ph && sweptAboveN(ph.price,bars,i,nBars,tolBps)) return { side:'short', ref:ph.price, kind:'swingHi' };
  if(pl && sweptBelowN(pl.price,bars,i,nBars,tolBps)) return { side:'long',  ref:pl.price, kind:'swingLo' };
  return null;
}
