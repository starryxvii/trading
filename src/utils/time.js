// src/utils/time.js

// Determine US DST (second Sunday in March to first Sunday in November, 2:00 local)
function usDstBoundsUTC(year) {
  // second Sunday in March
  let d = new Date(Date.UTC(year, 2, 1, 7, 0, 0)); // 07:00 UTC ~ 02:00 ET
  let sundays = 0;
  while (d.getUTCMonth() === 2) {
    if (d.getUTCDay() === 0) sundays++;
    if (sundays === 2) break;
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  }
  const dstStart = new Date(Date.UTC(year, 2, d.getUTCDate(), 7, 0, 0)); // 2:00 ET = 7:00 UTC

  // first Sunday in November
  let e = new Date(Date.UTC(year, 10, 1, 6, 0, 0)); // 06:00 UTC ~ 01:00 ET (fallback occurs at 2)
  while (e.getUTCDay() !== 0) {
    e = new Date(e.getTime() + 24 * 3600 * 1000);
  }
  const dstEnd = new Date(Date.UTC(year, 10, e.getUTCDate(), 6, 0, 0)); // 2:00 ET = 6:00 UTC (standard)
  return { dstStart, dstEnd };
}

function isUsEasternDST(utcMs) {
  const d = new Date(utcMs);
  const { dstStart, dstEnd } = usDstBoundsUTC(d.getUTCFullYear());
  return d >= dstStart && d < dstEnd;
}

// ET minutes since midnight for a UTC timestamp, with DST
export function minutesET(timeMs) {
  const d = new Date(timeMs);
  const offset = isUsEasternDST(timeMs) ? 4 : 5; // UTC-4 (EDT) or UTC-5 (EST)
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return ((h - offset + 24) % 24) * 60 + m;
}

// Sessions and windows helpers (as before)
export function isSession(timeMs, session = 'NYSE') {
  const day = new Date(timeMs).getUTCDay(); // 0 Sun ... 6 Sat
  if (day === 0 || day === 6) {
    if (session === 'FUT') {
      const m = minutesET(timeMs);
      return m >= (18 * 60) || m < (17 * 60);
    }
    return false;
  }

  const m = minutesET(timeMs);
  if (session === 'AUTO') return true;

  if (session === 'FUT') {
    const maintStart = 17 * 60, maintEnd = 18 * 60;
    return !(m >= maintStart && m < maintEnd) && m >= 0 && m <= (24 * 60 - 1);
  }

  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return m >= open && m <= close;
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
export function inWindowsET(timeMs, windows) {
  if (!windows || !windows.length) return true;
  const m = minutesET(timeMs);
  return windows.some(w => m >= w.aMin && m <= w.bMin);
}
