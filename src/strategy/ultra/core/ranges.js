// src/strategy/ultra/core/ranges.js
import { etDateStr } from "./utils.js";
import { minutesET } from "../../../utils/time.js";

export function computeDayRangeET(bars, i, dayOffset = 0) {
  const keys = [];
  for (let k = i; k >= 0 && keys.length < 4; k--) {
    const dkey = etDateStr(bars[k].time);
    if (keys[keys.length - 1] !== dkey) keys.push(dkey);
  }
  const wantIdx = dayOffset === 0 ? 0 : -dayOffset;
  const targetDay = keys[wantIdx];
  if (!targetDay) return null;

  let hi = -Infinity,
    lo = Infinity;
  for (let k = i; k >= 0; k--) {
    const dkey = etDateStr(bars[k].time);
    if (dkey === targetDay) {
      hi = Math.max(hi, bars[k].high);
      lo = Math.min(lo, bars[k].low);
    } else if (hi > -Infinity && lo < Infinity) {
      break;
    }
  }
  return hi > -Infinity && lo < Infinity ? { hi, lo } : null;
}

export function computeAsianRangeTodayET(
  bars,
  i,
  startMin = 0,
  endMin = 5 * 60
) {
  const dayKey = etDateStr(bars[i].time);
  let hi = -Infinity,
    lo = Infinity,
    found = false;
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

/**
 * Compute high/low for named intraday sessions (ET) of the *current* day.
 * @param {Array} bars
 * @param {number} i - current index
 * @param {Array<{name:string,startMin:number,endMin:number}>} sessions
 * @returns {Array<{name:string,hi:number,lo:number}>}
 */
export function computeSessionRangesTodayET(bars, i, sessions = []) {
  const dayKey = etDateStr(bars[i].time);
  const acc = sessions.map((s) => ({
    name: s.name,
    startMin: s.startMin,
    endMin: s.endMin,
    hi: -Infinity,
    lo: Infinity,
    found: false,
  }));
  for (let k = i; k >= 0; k--) {
    if (etDateStr(bars[k].time) !== dayKey) break;
    const m = minutesET(bars[k].time);
    for (const sess of acc) {
      if (m >= sess.startMin && m <= sess.endMin) {
        sess.hi = Math.max(sess.hi, bars[k].high);
        sess.lo = Math.min(sess.lo, bars[k].low);
        sess.found = true;
      }
    }
  }
  return acc
    .filter((s) => s.found)
    .map((s) => ({ name: s.name, hi: s.hi, lo: s.lo }));
}
