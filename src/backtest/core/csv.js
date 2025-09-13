// src/backtest/core/csv.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..', '..');

const safe = s => String(s).replace(/[^-_.A-Za-z0-9]/g, '_');

export function exportTradesCsv(closed, { symbol, interval = 'tf', range = 'range', outDir } = {}) {
  if (!closed.length) return;

  const rows = [
    ['time_open','time_close','side','entry','stop','takeProfit','exit','reason','size','pnl','R','mfeR','maeR','adds','entryATR','exitATR'].join(','),
    ...closed.map(t => [
      new Date(t.openTime).toISOString(),
      new Date(t.exit.time).toISOString(),
      t.side,
      Number(t.entry).toFixed(6),
      Number(t.stop).toFixed(6),
      Number(t.takeProfit).toFixed(6),
      Number(t.exit.price).toFixed(6),
      t.exit.reason,
      t.size,
      t.exit.pnl.toFixed(2),
      (function r(tr){
        const R=(tr._initRisk||0); if(R<=0) return 0;
        const e=(tr.entryFill??tr.entry);
        const per=(tr.side==='long')?(tr.exit.price-e):(e-tr.exit.price);
        return per/R;
      })(t).toFixed(3),
      (t.mfeR ?? 0).toFixed(3),
      (t.maeR ?? 0).toFixed(3),
      t.adds ?? 0,
      t.entryATR !== undefined ? Number(t.entryATR).toFixed(6) : '',
      t.exit.exitATR !== undefined ? Number(t.exit.exitATR).toFixed(6) : ''
    ].join(','))
  ].join('\n');

  const dirFromCfg = outDir && String(outDir).trim().length ? outDir : 'output';
  const outDirAbs = path.isAbsolute(dirFromCfg) ? dirFromCfg : path.join(projectRoot, dirFromCfg);

  const fname  = `trades-${safe(symbol)}-${safe(interval)}-${safe(range)}.csv`;
  const out    = path.join(outDirAbs, fname);

  try {
    fs.mkdirSync(outDirAbs, { recursive: true });
    fs.writeFileSync(out, rows, 'utf8');
    console.log(`\n[report] CSV saved: ${path.relative(projectRoot, out)}`);
  } catch (e) {
    console.warn('[report] CSV save failed:', e.message);
  }
}
