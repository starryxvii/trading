// src/strategy/ultra/core/ranges.js
import { etDateStr } from './utils.js';
import { minutesET } from '../../../utils/time.js';

export function computeDayRangeET(bars, i, dayOffset = 0) {
  const keys = [];
  for (let k = i; k >= 0 && keys.length < 4; k--) {
    const dkey = etDateStr(bars[k].time);
    if (keys[keys.length - 1] !== dkey) keys.push(dkey);
  }
  const wantIdx = (dayOffset === 0) ? 0 : (-dayOffset);
  const targetDay = keys[wantIdx];
  if (!targetDay) return null;

  let hi = -Infinity, lo = Infinity;
  for (let k = i; k >= 0; k--) {
    const dkey = etDateStr(bars[k].time);
    if (dkey === targetDay) {
      hi = Math.max(hi, bars[k].high);
      lo = Math.min(lo, bars[k].low);
    } else if (hi > -Infinity && lo < Infinity) {
      break;
    }
  }
  return (hi > -Infinity && lo < Infinity) ? { hi, lo } : null;
}

export function computeAsianRangeTodayET(bars, i, startMin = 0, endMin = 5 * 60) {
  const dayKey = etDateStr(bars[i].time);
  let hi = -Infinity, lo = Infinity, found = false;
  for (let k = i; k >= 0; k--) {
    if (etDateStr(bars[k].time) !== dayKey) break;
    const m = minutesET(bars[k].time);
    if (m >= startMin && m <= endMin) {
      hi = Math.max(hi, bars[k].high);
      lo = Math.min(lo, bars[k].low);
      found = true;
    }
  }
  return found ? { hi, lo } : null;
}
