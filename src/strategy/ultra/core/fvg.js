// src/strategy/ultra/core/fvg.js
import { mid } from './utils.js';

export function fvgAt(bars,i){
  if(i<2) return null;
  const a=bars[i-2], c=bars[i];
  if(a.high < c.low)  return { type:'bull', top:a.high, bottom:c.low, mid:mid(a.high,c.low), i, inverse:false };
  if(a.low  > c.high) return { type:'bear', top:c.high, bottom:a.low, mid:mid(c.high,a.low), i, inverse:false };
  return null;
}
export function ifvgAt(bars,i){
  if(i<2) return null;
  const a=bars[i-2], c=bars[i];
  const aHi=Math.max(a.open,a.close), aLo=Math.min(a.open,a.close);
  const cHi=Math.max(c.open,c.close), cLo=Math.min(c.open,c.close);
  if(aHi < cLo) return { type:'bull', top:aHi, bottom:cLo, mid:mid(aHi,cLo), i, inverse:true };
  if(aLo > cHi) return { type:'bear', top:cHi, bottom:aLo, mid:mid(cHi,aLo), i, inverse:true };
  return null;
}
export function recentImbalance(bars,i,lookback,preferIFVG=true){
  for(let k=i;k>=Math.max(2,i-lookback+1);k--){
    if(preferIFVG){
      const inv=ifvgAt(bars,k); if(inv) return inv;
      const fv=fvgAt(bars,k);   if(fv)  return fv;
    } else {
      const fv=fvgAt(bars,k);   if(fv)  return fv;
      const inv=ifvgAt(bars,k); if(inv) return inv;
    }
  }
  return null;
}
