// src/utils/logger.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let _rootDir = null;
try {
  const __filename = fileURLToPath(import.meta.url);
  _rootDir = path.resolve(path.dirname(__filename), '..', '..'); // project root
} catch { /* noop for non-node env */ }

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function tsFileStamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export function createLogger({
  enabled = false,
  dir = _rootDir ? path.join(_rootDir, 'debug') : null,
  basename = `log-${tsFileStamp()}.txt`,
  level = 'info',                  // 'info' | 'debug'
  json = true,                     // write JSON lines if true; else pretty text
  flushEvery = 1                   // flush each write (safe; simple)
} = {}) {
  const canFS = enabled && dir && typeof fs?.writeFileSync === 'function';
  if (!canFS) {
    // no-op logger
    const noop = () => {};
    return {
      on: false,
      path: null,
      info: noop, debug: noop, warn: noop, error: noop, write: noop, close: noop
    };
  }

  ensureDirSync(dir);
  const fullPath = path.join(dir, basename);

  // create header
  try {
    const header = `# ultra log\n# started: ${new Date().toISOString()}\n`;
    fs.writeFileSync(fullPath, header, { flag: 'a' });
  } catch { /* ignore */ }

  const numeric = (lvl) => ({ error: 0, warn: 1, info: 2, debug: 3 }[lvl] ?? 2);
  const min = numeric(level);

  function writeLine(objOrStr, lvl = 'info') {
    if (numeric(lvl) > min) return;
    const line = (typeof objOrStr === 'string')
      ? objOrStr
      : (json ? JSON.stringify(objOrStr) : String(objOrStr));
    try {
      fs.writeFileSync(fullPath, line + '\n', { flag: 'a' });
      if (flushEvery > 0) { /* fsync is implicit per writeFileSync */ }
    } catch { /* ignore write errors */ }
  }

  function wrap(levelName) {
    return (...args) => {
      const entry = {
        t: new Date().toISOString(),
        level: levelName,
        msg: args.length === 1 ? args[0] : args
      };
      writeLine(entry, levelName);
    };
  }

  return {
    on: true,
    path: fullPath,
    info: wrap('info'),
    debug: wrap('debug'),
    warn: wrap('warn'),
    error: wrap('error'),
    write: writeLine,
    close: () => {
      // nothing to close with writeFileSync; leave a footer
      try { fs.writeFileSync(fullPath, `# closed: ${new Date().toISOString()}\n`, { flag: 'a' }); } catch {}
    }
  };
}
