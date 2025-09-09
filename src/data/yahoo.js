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

function maxDaysForInterval(interval) {
  const intraday = /m$/.test(interval);
  if (!intraday) return 365 * 10;
  const n = Number(interval.replace('m',''));
  if (n <= 2) return 7;
  if (n <= 5) return 60;   // 5m supports ~60d
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

export async function fetchHistorical(symbol, interval = '5m', period = '60d') {
  if (!yf || typeof yf.chart !== 'function') {
    throw new Error('yahoo-finance2: chart() not found on import (expected in v2).');
  }

  const spanMs = parsePeriodToMs(period);
  const maxDays = maxDaysForInterval(interval);
  const maxSpanMs = maxDays * DAY_MS;

  if (spanMs <= maxSpanMs) {
    const p2 = nowSec();
    const p1 = msToSec(Date.now() - Math.max(1, spanMs));
    const res = await yf.chart(symbol, { period1: p1, period2: p2, interval, includePrePost: false });
    return sanitizeBars((res?.quotes || []).map(toCandle));
  }

  const chunks = [];
  let endMs = Date.now();
  let remaining = spanMs;
  while (remaining > 0) {
    const take = Math.min(remaining, maxSpanMs);
    const startMs = endMs - take;
    const p1 = msToSec(startMs);
    const p2 = msToSec(endMs);
    const res = await yf.chart(symbol, { period1: p1, period2: p2, interval, includePrePost: false });
    chunks.push(...(res?.quotes || []).map(toCandle));
    endMs = startMs - 1;
    remaining -= take;
    if (chunks.length > 2_000_000) break;
  }
  return sanitizeBars(chunks);
}

export async function fetchLatestCandle(symbol, interval = '1m') {
  const maxDays = maxDaysForInterval(interval);
  const window = Math.min(maxDays, 5);
  const bars = await fetchHistorical(symbol, interval, `${window}d`);
  return bars[bars.length - 1];
}
