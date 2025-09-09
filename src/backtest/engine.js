// src/engine.js
// Public API unchanged: export function backtest(...)
import { atr } from '../utils/indicators.js';
import { positionSize } from '../risk/positionSizing.js';
import { applyFill, clampStop, touchedLimit, ocoExitCheck, isEODBar, roundStep, estimateBarMs, ymdUTC } from './core/helpers.js';
import { buildMetrics } from './core/metrics.js';
import { exportTradesCsv } from './core/csv.js';

export function backtest({
  candles,
  symbol,
  equity = 10000,
  riskPct = 1,
  rr = 2,
  signal,
  report = {},
  interval,
  range,

  slippageBps = 1,
  feeBps = 0,
  scaleOutAtR = 1.0,
  scaleOutFrac = 0.5,
  finalTP_R = 3.0,
  maxDailyLossPct = 2.0,

  atrTrailMult = 0,
  atrTrailPeriod = 14,

  oco = { mode: 'intrabar', tieBreak: 'pessimistic', clampStops: true, clampEpsBps: 0.25 },
  triggerMode,
  flattenAtClose = true,
  dailyMaxTrades = 0,
  postLossCooldownBars = 0,

  mfeTrail = { enabled: false, armR: 1.0, givebackR: 0.5 },

  pyramiding = { enabled: false, addAtR: 1.0, addFrac: 0.25, maxAdds: 1, onlyAfterBreakEven: true },

  volScale = { enabled: false, atrPeriod: 14, cutIfAtrX: 1.30, cutFrac: 0.33, noCutAboveR: 1.5 },

  qtyStep = 0.001,
  minQty = 0.001,
  maxLeverage = 2.0,

  // NEW: smart entry-chase to improve fill rate without violating risk
  entryChase = { enabled: true, afterBars: 2, maxSlipR: 0.20, convertOnExpiry: true }
}) {
  const closed = [];
  let eq = equity;
  let open = null;
  let cooldown = 0;
  let pending = null;

  let curDay = null;
  let dayPnl = 0;
  let dayTrades = 0;

  const estBarMs = estimateBarMs(candles);
  const needAtr = (atrTrailMult > 0) || (volScale?.enabled === true);
  const atrArr = needAtr ? atr(candles, volScale?.atrPeriod || atrTrailPeriod) : null;

  function closeLeg({ openPos, qty, exitPx, exitFeePerUnit, time, reason }) {
    const side = openPos.side;
    const dir = side === 'long' ? 1 : -1;
    const entryFill = openPos.entryFill;
    const gross = (exitPx - entryFill) * dir * qty;
    const entryFeePortion = (openPos.entryFeeTotal || 0) * (qty / openPos.initSize);
    const exitFeeTotal = exitFeePerUnit * qty;
    const pnl = gross - entryFeePortion - exitFeeTotal;

    eq += pnl; dayPnl += pnl;

    const record = {
      ...openPos,
      size: qty,
      exit: { price: exitPx, time, reason, pnl, exitATR: openPos._lastATR ?? undefined },
      mfeR: openPos._mfeR ?? 0,
      maeR: openPos._maeR ?? 0,
      adds: openPos._adds ?? 0
    };
    closed.push(record);

    openPos.size -= qty;
    return record;
  }

  let hist = candles.slice(0, 200);

  for (let i = 200; i < candles.length; i++) {
    const c = candles[i];
    hist.push(c);

    // NOTE: for pending limit fills we always prefer intrabar detection to avoid missed fills.
    const trigMode = triggerMode || (oco?.mode || 'intrabar');
    const trigModeFill = 'intrabar';

    const dayKey = ymdUTC(c.time);
    if (curDay === null) { curDay = dayKey; dayPnl = 0; dayTrades = 0; }
    if (dayKey !== curDay) { curDay = dayKey; dayPnl = 0; dayTrades = 0; }

    // --- time-based exits ---
    if (open && open._maxBarsInTrade > 0) {
      const barsHeld = Math.max(1, Math.round((c.time - open.openTime) / estBarMs));
      if (barsHeld >= open._maxBarsInTrade) {
        const exitSide = open.side === 'long' ? 'short' : 'long';
        const { price: filled, fee: exitFeeUnit } = applyFill(c.close, exitSide, { slippageBps, feeBps });
        closeLeg({ openPos: open, qty: open.size, exitPx: filled, exitFeePerUnit: exitFeeUnit, time: c.time, reason: 'TIME' });
        cooldown = open._cooldownBars || 0;
        open = null;
        continue;
      }
    }
    if (open && Number.isFinite(open._maxHoldMin) && open._maxHoldMin > 0) {
      const heldMin = (c.time - open.openTime) / 60000;
      if (heldMin >= open._maxHoldMin) {
        const exitSide = open.side === 'long' ? 'short' : 'long';
        const { price: filled, fee: exitFeeUnit } = applyFill(c.close, exitSide, { slippageBps, feeBps });
        closeLeg({ openPos: open, qty: open.size, exitPx: filled, exitFeePerUnit: exitFeeUnit, time: c.time, reason: 'TIME' });
        cooldown = open._cooldownBars || 0;
        open = null;
        continue;
      }
    }

    if (flattenAtClose && open && isEODBar(c.time)) {
      const exitSide = open.side === 'long' ? 'short' : 'long';
      const { price: filled, fee: exitFeeUnit } = applyFill(c.close, exitSide, { slippageBps, feeBps });
      closeLeg({ openPos: open, qty: open.size, exitPx: filled, exitFeePerUnit: exitFeeUnit, time: c.time, reason: 'EOD' });
      cooldown = open._cooldownBars || 0;
      open = null;
      continue;
    }

    // helper to open from current pending at a specific entry price
    function openFromPending(entryPx) {
      const sizeRaw = positionSize({
        equity: eq,
        entry: entryPx,
        stop: pending.stop,
        riskFraction: pending.riskFrac,
        qtyStep, minQty, maxLeverage
      });
      const size = roundStep(sizeRaw, qtyStep);
      if (size < minQty) return false;

      const { price: entryFill, fee: feeEntryUnit } = applyFill(entryPx, pending.side, { slippageBps, feeBps });
      const entryFeeTotal = feeEntryUnit * size;

      open = {
        symbol,
        ...pending.meta,
        side: pending.side,
        entry: entryPx,
        stop: pending.stop,
        takeProfit: pending.tp,
        size,
        openTime: c.time,
        entryFill,
        entryFeeTotal,
        initSize: size,
        baseSize: size,
        _mfeR: 0,
        _maeR: 0,
        _adds: 0
      };

      if (atrArr?.[i] !== undefined) {
        open.entryATR = atrArr[i];
        open._lastATR = atrArr[i];
      }
      dayTrades++;
      pending = null;
      return true;
    }

    // --- pending limit (fill/expire) ---
    if (!open && pending) {
      const maxLossDollars = (maxDailyLossPct / 100) * eq;
      const dailyLossHit = dayPnl <= -Math.abs(maxLossDollars);
      const tradesCapHit = (dailyMaxTrades > 0 && dayTrades >= dailyMaxTrades);

      // Expire if rules say so
      if (i > pending.expiresAt || dailyLossHit || tradesCapHit) {
        // On expiry, optionally convert to market if allowed and slippage is bounded in R
        if (entryChase?.enabled && entryChase?.convertOnExpiry) {
          const riskAtEdge = Math.abs(pending.meta._initRisk ?? (pending.entry - pending.stop));
          const priceNow = c.close;
          const dir = pending.side === 'long' ? 1 : -1;
          const slippedR = Math.max(0, (dir === 1 ? (priceNow - pending.entry) : (pending.entry - priceNow))) / Math.max(1e-8, riskAtEdge);
          if (slippedR <= (entryChase.maxSlipR ?? 0.2)) {
            openFromPending(priceNow);
          }
        }
        pending = null;
      } else {
        // try normal limit fill first (intrabar by design)
        if (touchedLimit(pending.side, pending.entry, c, trigModeFill)) {
          openFromPending(pending.entry);
        } else if (entryChase?.enabled) {
          // if not filled for N bars, upgrade entry to CE (imbalance mid) once
          const elapsed = i - (pending.startedAtIndex ?? i);
          const mid = pending.meta?._imb?.mid;
          if (!pending._chasedCE && mid !== undefined && elapsed >= Math.max(1, entryChase.afterBars)) {
            pending.entry = mid; // softer entry to improve fill
            pending._chasedCE = true;
          }
          // if still not filled and price has moved a bit in favor but within max slip (in R), flip to market now
          if (pending._chasedCE) {
            const riskRef = Math.abs((pending.meta?._initRisk) ?? (pending.entry - pending.stop));
            const priceNow = c.close;
            const dir = pending.side === 'long' ? 1 : -1;
            const slippedR = Math.max(0, (dir === 1 ? (priceNow - pending.entry) : (pending.entry - priceNow))) / Math.max(1e-8, riskRef);
            if (slippedR > 0 && slippedR <= (entryChase.maxSlipR ?? 0.2)) {
              openFromPending(priceNow);
            }
          }
        }
      }
    }

    // --- manage open position ---
    if (open) {
      const price = c.close;
      const hi = c.high, lo = c.low;
      const dir = open.side === 'long' ? 1 : -1;
      const risk = open._initRisk || 1e-8;

      if (atrArr?.[i] !== undefined) open._lastATR = atrArr[i];

      // run stops, trails, scale, pyramiding
      const hiR = (open.side === 'long') ? (hi - open.entry) / risk : (open.entry - lo) / risk;
      const loR = (open.side === 'long') ? (lo - open.entry) / risk : (open.entry - hi) / risk;
      const rNow = dir === 1 ? (price - open.entry) / risk : (open.entry - price) / risk;

      open._mfeR = Math.max(open._mfeR ?? -Infinity, hiR);
      open._maeR = Math.min(open._maeR ?? Infinity,  loR);

      if (open._breakevenAtR > 0 && hiR >= open._breakevenAtR && !open._beArmed) {
        const cand = open.entry;
        const tightened = (open.side === 'long') ? Math.max(open.stop, cand) : Math.min(open.stop, cand);
        open.stop = oco?.clampStops ? clampStop(c.close, tightened, open.side, oco) : tightened;
        open._beArmed = true;
      }

      if (open._trailAfterR > 0 && hiR >= open._trailAfterR) {
        const trailStep = risk;
        const cand = (open.side === 'long') ? (c.close - trailStep) : (c.close + trailStep);
        const tightened = (open.side === 'long') ? Math.max(open.stop, cand) : Math.min(open.stop, cand);
        open.stop = oco?.clampStops ? clampStop(c.close, tightened, open.side, oco) : tightened;
      }

      if (mfeTrail?.enabled && open._mfeR >= (mfeTrail.armR ?? 1.0)) {
        const give = Math.max(0, mfeTrail.givebackR ?? 0.5);
        const targetR = Math.max(0, open._mfeR - give);
        const cand = (open.side === 'long') ? open.entry + targetR * risk : open.entry - targetR * risk;
        const tightened = (open.side === 'long') ? Math.max(open.stop, cand) : Math.min(open.stop, cand);
        open.stop = oco?.clampStops ? clampStop(c.close, tightened, open.side, oco) : tightened;
      }

      if (atrTrailMult > 0 && atrArr?.[i] !== undefined) {
        const t = atrArr[i] * atrTrailMult;
        const cand = (open.side === 'long') ? (c.close - t) : (c.close + t);
        const tightened = (open.side === 'long') ? Math.max(open.stop, cand) : Math.min(open.stop, cand);
        open.stop = oco?.clampStops ? clampStop(c.close, tightened, open.side, oco) : tightened;
      }

      if (volScale?.enabled && open.entryATR && open.size > minQty && atrArr?.[i] !== undefined) {
        const ratio = atrArr[i] / Math.max(1e-12, open.entryATR);
        if (ratio >= (volScale.cutIfAtrX ?? 1.30) && rNow < (volScale.noCutAboveR ?? 1.5) && !open._volCutDone) {
          const cutRaw = open.size * (volScale.cutFrac ?? 0.33);
          const cutQty = roundStep(cutRaw, qtyStep);
          if (cutQty >= minQty && cutQty < open.size) {
            const exitSide = open.side === 'long' ? 'short' : 'long';
            const { price: filled, fee: exitFeeUnit } = applyFill(price, exitSide, { slippageBps, feeBps });
            closeLeg({ openPos: open, qty: cutQty, exitPx: filled, exitFeePerUnit: exitFeeUnit, time: c.time, reason: 'SCALE' });
            open._volCutDone = true;
          }
        }
      }

      let addedThisBar = false;
      if (pyramiding?.enabled && (open._adds ?? 0) < (pyramiding.maxAdds ?? 0)) {
        const nextIdx = (open._adds || 0) + 1;
        const triggerR = (pyramiding.addAtR ?? 1.0) * nextIdx;
        const triggerPx = (open.side === 'long') ? open.entry + triggerR * risk : open.entry - triggerR * risk;
        const okBEB = !pyramiding.onlyAfterBreakEven || (
          (open.side === 'long' && open.stop >= open.entry) ||
          (open.side === 'short' && open.stop <= open.entry)
        );
        const touched = (open.side === 'long')
          ? (trigMode === 'intrabar' ? (c.high >= triggerPx) : (c.close >= triggerPx))
          : (trigMode === 'intrabar' ? (c.low  <= triggerPx) : (c.close <= triggerPx));
        if (okBEB && touched) {
          const base = (open.baseSize || open.initSize);
          const addRaw = base * (pyramiding.addFrac ?? 0.25);
          const addQty = roundStep(addRaw, qtyStep);
          if (addQty >= minQty) {
            const { price: addFill, fee: addFeeUnit } = applyFill(triggerPx, open.side, { slippageBps, feeBps });
            const newSize = open.size + addQty;
            open.entryFeeTotal = (open.entryFeeTotal || 0) + addFeeUnit * addQty;
            open.entryFill = ((open.entryFill * open.size) + (addFill * addQty)) / newSize;
            open.size = newSize;
            open.initSize = (open.initSize || 0) + addQty;
            if (!open.baseSize) open.baseSize = base;
            open._adds = nextIdx;
            addedThisBar = true;
          }
        }
      }

      if (!addedThisBar && !open._scaled && scaleOutAtR > 0) {
        const trigPx = (open.side === 'long') ? open.entry + scaleOutAtR * risk : open.entry - scaleOutAtR * risk;
        const touched = (open.side === 'long')
          ? (trigMode === 'intrabar' ? (c.high >= trigPx) : (c.close >= trigPx))
          : (trigMode === 'intrabar' ? (c.low  <= trigPx) : (c.close <= trigPx));
        if (touched) {
          const exitSide = open.side === 'long' ? 'short' : 'long';
          const { price: filled, fee: exitFeeUnit } = applyFill(trigPx, exitSide, { slippageBps, feeBps });
          const want = open.size * scaleOutFrac;
          const qty = roundStep(want, qtyStep);
          if (qty >= minQty && qty < open.size) {
            closeLeg({ openPos: open, qty, exitPx: filled, exitFeePerUnit: exitFeeUnit, time: c.time, reason: 'SCALE' });
            open._scaled = true;
            open.takeProfit = (open.side === 'long') ? open.entry + finalTP_R * risk : open.entry - finalTP_R * risk;

            // NEW: BE on remainder
            const be = open.entry;
            const tightenedBE = (open.side === 'long') ? Math.max(open.stop, be) : Math.min(open.stop, be);
            open.stop = oco?.clampStops ? clampStop(c.close, tightenedBE, open.side, oco) : tightenedBE;
            open._beArmed = true;
          }
        }
      }

      const exitSide = open.side === 'long' ? 'short' : 'long';
      const { hit, px } = ocoExitCheck({
        side: open.side, stop: open.stop, tp: open.takeProfit,
        bar: c, mode: oco?.mode || 'intrabar', tieBreak: oco?.tieBreak || 'pessimistic'
      });
      if (hit) {
        const { price: filled, fee: feeUnit } = applyFill(px, exitSide, { slippageBps, feeBps });
        closeLeg({ openPos: open, qty: open.size, exitPx: filled, exitFeePerUnit: feeUnit, time: c.time, reason: hit });
        cooldown = (hit === 'SL' ? Math.max(cooldown, postLossCooldownBars) : cooldown) || (open?._cooldownBars || 0);
        open = null;
      }
    }

    if (open || cooldown > 0) { if (cooldown > 0) cooldown--; continue; }

    const maxLossDollars = (maxDailyLossPct / 100) * eq;
    if (dayPnl <= -Math.abs(maxLossDollars)) { pending = null; continue; }
    if (dailyMaxTrades > 0 && dayTrades >= dailyMaxTrades) { pending = null; continue; }

    // request a new signal and build a pending order
    if (!pending) {
      const sig = signal({ candles: hist });
      if (!sig) continue;
      const expiryBars = sig._entryExpiryBars ?? 5;
      pending = {
        side: sig.side,
        entry: sig.entry,
        stop: sig.stop,
        tp: sig.takeProfit,
        riskFrac: riskPct / 100,
        expiresAt: i + Math.max(1, expiryBars),
        startedAtIndex: i,
        meta: sig
      };
    }
  }

  // Metrics & CSV
  const metrics = buildMetrics({ closed, equityStart: equity, equityFinal: eq, candles, estBarMs });
  if (report?.exportCsv && closed.length) {
    exportTradesCsv(closed, { symbol, interval, range });
  }
  return { trades: closed, metrics };
}
