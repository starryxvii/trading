// src/broker/paper.js

/**
 * PaperBroker
 * - Simple paper-trading broker with OCO (SL/TP), wall-clock max-hold, and EOW flatten.
 *
 * Live-safety controls:
 *   - maxHoldMin:     per-broker default wall-clock cap in minutes (can be overridden per trade)
 *   - flattenWeekends: if true, closes all positions on/after Friday cutoff UTC and blocks weekend holds
 *   - flattenFridayHourUTC: UTC hour on Friday to begin flattening (0–23)
 *
 * Per-trade overrides passed from your signal:
 *   - _maxHoldMin:    overrides broker default for that specific position
 */
export class PaperBroker {
  constructor({
    equity = 10000,
    maxConcurrent = 1,
    maxHoldMin = null,            // default wall-clock cap for live positions (minutes). Per-trade overrides via signal _maxHoldMin
    flattenWeekends = false,      // if true, flatten at Friday cutoff and block weekend holds
    flattenFridayHourUTC = 21     // 0-23; at/after this UTC hour on Friday, flatten open trades
  } = {}) {
    this.equity = equity;
    this.maxConcurrent = maxConcurrent;
    this.positions = new Map(); // symbol -> position
    this.closed = [];

    // live risk controls
    this.liveMaxHoldMin = maxHoldMin;
    this.flattenWeekends = flattenWeekends;
    this.flattenFridayHourUTC = flattenFridayHourUTC;
  }

  hasOpenPosition(symbol) {
    return this.positions.has(symbol);
  }

  /**
   * Open a position.
   * @param {Object} params
   * @param {string} params.symbol
   * @param {'long'|'short'} params.side
   * @param {number} params.entry
   * @param {number} params.stop
   * @param {number} params.takeProfit
   * @param {number} params.size
   * @param {number} [params.time=Date.now()] - open timestamp (ms)
   * @param {number|null} [params.maxHoldMin] - per-trade wall-clock cap override
   */
  open({ symbol, side, entry, stop, takeProfit, size, time = Date.now(), maxHoldMin = null }) {
    if (this.positions.size >= this.maxConcurrent) return false;
    this.positions.set(symbol, {
      symbol, side, entry, stop, takeProfit, size,
      openTime: time,
      status: 'open',
      meta: {
        maxHoldMin: (maxHoldMin ?? this.liveMaxHoldMin) || null
      }
    });
    return true;
  }

  _shouldFlattenWeekend(nowMs) {
    if (!this.flattenWeekends) return false;
    const d = new Date(nowMs);
    const dow = d.getUTCDay(); // 0 Sun ... 6 Sat
    const hour = d.getUTCHours();

    if (dow === 6 || dow === 0) return true; // Sat/Sun
    if (dow === 5 && hour >= this.flattenFridayHourUTC) return true; // Friday cutoff
    return false;
  }

  /**
   * Mark-to-market & risk rules:
   * - OCO: hit SL/TP -> close
   * - Wall-clock max-hold: if exceeded -> close('TIME')
   * - EOW flatten: if policy triggers -> close('EOW')
   */
  mark({ symbol, price, time }) {
    const p = this.positions.get(symbol);
    if (!p) return;

    // 1) Standard OCO logic
    if (p.side === 'long') {
      if (price <= p.stop) return this.close(symbol, p.stop, time, 'SL');
      if (price >= p.takeProfit) return this.close(symbol, p.takeProfit, time, 'TP');
    } else {
      if (price >= p.stop) return this.close(symbol, p.stop, time, 'SL');
      if (price <= p.takeProfit) return this.close(symbol, p.takeProfit, time, 'TP');
    }

    // 2) Wall-clock time stop (if configured)
    const holdCap = p.meta?.maxHoldMin;
    if (holdCap && Number.isFinite(holdCap)) {
      const heldMin = (time - p.openTime) / 60000;
      if (heldMin >= holdCap) return this.close(symbol, price, time, 'TIME');
    }

    // 3) Weekend flatten policy (end-of-week)
    if (this._shouldFlattenWeekend(time)) {
      return this.close(symbol, price, time, 'EOW');
    }
  }

  /**
   * Close a position and realize PnL.
   */
  close(symbol, exitPrice, time, reason) {
    const p = this.positions.get(symbol);
    if (!p) return;
    const pnl = (p.side === 'long' ? (exitPrice - p.entry) : (p.entry - exitPrice)) * p.size;
    this.equity += pnl;
    p.status = 'closed';
    p.exit = { price: exitPrice, time, reason, pnl };
    this.positions.delete(symbol);
    this.closed.push(p);
    return p;
  }
}
