// src/data/yahoo.js

import * as YahooNS from 'yahoo-finance2';
const yf = (YahooNS?.default ?? YahooNS);

function toCandle(row) {
  return {
    time: new Date(row.date).getTime(),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume ?? 0
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SEC = 24 * 60 * 60;

function parsePeriodToMs(periodStr) {
  const m = String(periodStr).trim().match(/^(\d+)([mhdwy])$/i);
  if (!m) throw new Error(`Invalid period: ${periodStr} (use like "5d","60d","1y")`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * DAY_MS;
    case 'w': return n * 7 * DAY_MS;
    case 'y': return Math.round(n * 365.25 * DAY_MS);
    default: throw new Error(`Unsupported unit: ${unit}`);
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const msToSec = (ms) => Math.floor(ms / 1000);
const isIntraday = (interval) => /m$/.test(interval);

function maxDaysForInterval(interval) {
  const intraday = isIntraday(interval);
  if (!intraday) return 365 * 10;
  const n = Number(interval.replace('m',''));
  if (n <= 2)  return 7;
  if (n <= 5)  return 60;   // 5m supports ~60d
  if (n <= 15) return 60;
  if (n <= 30) return 60;
  if (n <= 60) return 730;
  return 365;
}

function sanitizeBars(bars) {
  const byTime = new Map();
  for (const b of bars) {
    if (!Number.isFinite(b.open) || !Number.isFinite(b.high) ||
        !Number.isFinite(b.low)  || !Number.isFinite(b.close)) continue;
    byTime.set(b.time, b);
  }
  return Array.from(byTime.values()).sort((a,b)=>a.time-b.time);
}

// Keep intraday spans strictly under provider bounds to avoid errors
function boundedP1P2(periodMs, interval, nowS) {
  const intraday = isIntraday(interval);
  const maxDays = maxDaysForInterval(interval);
  const maxSpanSec = maxDays * DAY_SEC;

  const EPS_SEC = intraday ? 120 : 0; // shave 2 minutes
  const spanSec = Math.max(60, msToSec(periodMs));
  const p2 = nowS;
  const effectiveSpan = intraday
    ? Math.min(spanSec, Math.max(60, maxSpanSec - EPS_SEC))
    : spanSec;
  const p1 = p2 - effectiveSpan;
  return { p1, p2, EPS_SEC, intraday };
}

async function chartSafe(symbol, { period1, period2, interval, includePrePost }, retryEpsSec = 0) {
  try {
    const res = await yf.chart(symbol, { period1, period2, interval, includePrePost });
    return res;
  } catch (e) {
    const msg = String(e?.message || e);
    if (retryEpsSec > 0 && /must be within the last/i.test(msg)) {
      const p2 = period2;
      const p1 = Math.max(0, p2 - ((period2 - period1) - retryEpsSec));
      const res = await yf.chart(symbol, { period1: p1, period2: p2, interval, includePrePost });
      return res;
    }
    throw e;
  }
}

export async function fetchHistorical(symbol, interval = '5m', period = '60d') {
  if (!yf || typeof yf.chart !== 'function') {
    throw new Error('yahoo-finance2: chart() not found on import (expected in v2).');
  }

  const spanMs = parsePeriodToMs(period);
  const maxDays = maxDaysForInterval(interval);
  const maxSpanMs = maxDays * DAY_MS;
  const nowS = nowSec();

  if (spanMs <= maxSpanMs) {
    const { p1, p2, EPS_SEC, intraday } = boundedP1P2(spanMs, interval, nowS);
    const res = await chartSafe(
      symbol,
      { period1: p1, period2: p2, interval, includePrePost: false },
      intraday ? EPS_SEC : 0
    );
    return sanitizeBars((res?.quotes || []).map(toCandle));
  }

  const chunks = [];
  let endMs = Date.now();
  let remaining = spanMs;

  const intraday = isIntraday(interval);
  const EPS_MS = intraday ? 120 * 1000 : 0;
  const safeChunk = Math.max(60 * 1000, maxSpanMs - EPS_MS);

  while (remaining > 0) {
    const take = Math.min(remaining, safeChunk);
    const startMs = endMs - take;

    const p2 = msToSec(endMs);
    const p1 = msToSec(startMs);

    const res = await chartSafe(
      symbol,
      { period1: p1, period2: p2, interval, includePrePost: false },
      intraday ? Math.floor(EPS_MS / 1000) : 0
    );
    chunks.push(...(res?.quotes || []).map(toCandle));

    endMs = startMs - 1;
    remaining -= take;
    if (chunks.length > 2_000_000) break;
  }

  return sanitizeBars(chunks);
}

export async function fetchLatestCandle(symbol, interval = '1m') {
  const maxDays = maxDaysForInterval(interval);
  const windowDays = Math.min(maxDays, 5);
  const bars = await fetchHistorical(symbol, interval, `${windowDays}d`);
  return bars[bars.length - 1];
}
