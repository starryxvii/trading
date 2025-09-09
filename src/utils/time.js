// src/utils/time.js

// crude ET minutes (keeps behavior consistent with your engine)
export function minutesET(timeMs) {
  const d = new Date(timeMs);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return ((h - 4 + 24) % 24) * 60 + m;
}

// Generic sessions:
//  - 'NYSE': 09:30–16:00 ET
//  - 'FUT':  18:00–17:00 ET (CME nearly 24h) with a 60m break (17:00–18:00)
//  - 'AUTO': pass-through (always true). Use for symbols with odd sessions.
export function isSession(timeMs, session = 'NYSE') {
  const day = new Date(timeMs).getUTCDay(); // 0 Sun ... 6 Sat
  if (day === 0 || day === 6) {
    // Allow futures on Sunday evening – quick handling (CME reopens ~18:00 ET)
    if (session === 'FUT') {
      const m = minutesET(timeMs);
      return m >= (18 * 60) || m < (17 * 60);
    }
    return false;
  }

  const m = minutesET(timeMs);
  if (session === 'AUTO') return true;

  if (session === 'FUT') {
    // Open 18:00 ET prior day → 17:00 ET (1h maintenance)
    // Equivalent check: NOT in 17:00–18:00
    const start = 18 * 60, maintStart = 17 * 60, maintEnd = 18 * 60;
    return !(m >= maintStart && m < maintEnd) && m >= 0 && m <= (24 * 60 - 1);
  }

  // Default: NYSE cash
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return m >= open && m <= close;
}

// Optional trading windows, e.g. "09:45-11:30,13:30-15:30"
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
