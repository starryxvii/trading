// src/backtest/core/metrics.js

// ---------- utils ----------
function sum(a){ return a.reduce((s,x)=>s+x,0); }
function mean(a){ return a.length ? sum(a)/a.length : 0; }
function stddev(a){ if(a.length<=1) return 0; const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); }
function sortino(returns){
  const neg = returns.filter(x=>x<0);
  const dd = stddev(neg.length?neg:[0]);
  const avg = mean(returns);
  return dd===0 ? (avg>0?Infinity:0) : avg/dd;
}
function ymdUTC(ms){
  const d = new Date(ms);
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return `${d.getUTCFullYear()}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
}
function rMultiple(trade){
  const r = trade._initRisk || 0;
  if (r<=0) return 0;
  const entryRef = (trade.entryFill ?? trade.entry);
  const perUnit = (trade.side==='long') ? (trade.exit.price - entryRef) : (entryRef - trade.exit.price);
  return perUnit / r;
}
function streaks(labels){
  let w=0,l=0,maxW=0,maxL=0;
  for(const lab of labels){
    if(lab==='win'){ w++; l=0; if(w>maxW) maxW=w; }
    else if(lab==='loss'){ l++; w=0; if(l>maxL) maxL=l; }
    else { w=0; l=0; }
  }
  return { maxWin:maxW, maxLoss:maxL };
}

// Build a leg-level equity curve from exits (includes SCALE legs)
function buildEquitySeriesFromLegs({ legs, equityStart }) {
  const series = [{ time: legs.length ? legs[0].exit.time : Date.now(), equity: equityStart }];
  let eq = equityStart;
  for (const leg of legs) {
    eq += leg.exit.pnl;
    series.push({ time: leg.exit.time, equity: eq });
  }
  return series;
}

// Bucket an equity series to daily returns (close/open per day)
function dailyReturns(eqSeries) {
  if (!eqSeries?.length) return [];
  const byDay = new Map(); // dayKey -> { open, close, first, last }
  for (const p of eqSeries) {
    const day = ymdUTC(p.time);
    const rec = byDay.get(day) || { open: p.equity, close: p.equity, first: p.time, last: p.time };
    if (p.time < rec.first) { rec.open = p.equity; rec.first = p.time; }
    if (p.time >= rec.last) { rec.close = p.equity; rec.last = p.time; }
    byDay.set(day, rec);
  }
  const rets = [];
  for (const {open, close} of byDay.values()) {
    if (open > 0 && Number.isFinite(open) && Number.isFinite(close)) {
      rets.push((close - open) / open);
    }
  }
  return rets;
}

/**
 * Build metrics with:
 * - Position-level stats (completed trades; SCALE legs excluded)  [backward compatible]
 * - Leg-level stats (all SCALE exits included; matches final equity)
 * - Drawdown/Calmar computed on leg-level equity curve
 * - Optional time-based Sharpe/Sortino if eqSeries provided
 *
 * @param {Object} args
 * @param {Array}  args.closed       // ALL legs (each element is a "leg"; SCALE included)
 * @param {number} args.equityStart
 * @param {number} args.equityFinal
 * @param {Array}  args.candles
 * @param {number} args.estBarMs
 * @param {Array}  [args.eqSeries]   // optional [{time, equity}] time series; if missing, we reconstruct from legs
 */
export function buildMetrics({ closed, equityStart, equityFinal, candles, estBarMs, eqSeries }) {
  // --- position-level (completed trades only; SCALE excluded) ---
  const completed = closed.filter(t => t.exit.reason !== 'SCALE');
  const winsPos   = completed.filter(t => t.exit.pnl > 0);
  const lossesPos = completed.filter(t => t.exit.pnl < 0);

  const Rs = completed.map(rMultiple);
  const totalR = sum(Rs);
  const avgR   = mean(Rs);

  // win/loss streaks on completed positions
  const labels = completed.map(t => t.exit.pnl > 0 ? 'win' : (t.exit.pnl < 0 ? 'loss' : 'flat'));
  const { maxWin:maxConsecWins, maxLoss:maxConsecLosses } = streaks(labels);

  // per-trade (position-level) expectancy & Sharpe/Sortino
  const tradePnls = completed.map(t => t.exit.pnl);
  const expectancy = mean(tradePnls);
  const retsTrade  = completed.map(t => t.exit.pnl / Math.max(1e-12, equityStart));
  const retStd     = stddev(retsTrade);
  const sharpePerTrade  = retStd === 0 ? (retsTrade.length ? Infinity : 0) : mean(retsTrade)/retStd;
  const sortinoPerTrade = sortino(retsTrade);

  // position-level Profit Factor
  const grossPosPos = sum(winsPos.map(t => t.exit.pnl));
  const grossNegPos = Math.abs(sum(lossesPos.map(t => t.exit.pnl)));
  const profitFactorPos = (grossNegPos===0) ? (grossPosPos>0?Infinity:0) : (grossPosPos/grossNegPos);

  // --- leg-level (includes SCALE exits) ---
  const legs = [...closed].sort((a,b) => a.exit.time - b.exit.time);
  const legsWins   = legs.filter(t => t.exit.pnl > 0);
  const legsLosses = legs.filter(t => t.exit.pnl < 0);
  const grossPosLeg = sum(legsWins.map(t => t.exit.pnl));
  const grossNegLeg = Math.abs(sum(legsLosses.map(t => t.exit.pnl)));
  const profitFactorLeg = (grossNegLeg===0) ? (grossPosLeg>0?Infinity:0) : (grossPosLeg/grossNegLeg);

  // Drawdown/Calmar on leg-level realized equity
  let peakEq = equityStart;
  let curEq  = equityStart;
  let maxDD  = 0;
  for (const leg of legs) {
    curEq += leg.exit.pnl;
    if (curEq > peakEq) peakEq = curEq;
    const dd = (peakEq - curEq) / Math.max(1e-12, peakEq);
    if (dd > maxDD) maxDD = dd;
  }

  const realizedPnL = sum(closed.map(t => t.exit.pnl));
  const returnPct = (equityFinal - equityStart) / Math.max(1e-12, equityStart);
  const calmar = maxDD === 0 ? (returnPct > 0 ? Infinity : 0) : (returnPct / maxDD);

  // Exposure/avg hold on completed positions (as before)
  const totalBars = Math.max(1, candles.length);
  const openBars = completed.reduce((s,t)=>{
    const barsApprox = Math.max(1, Math.round((t.exit.time - t.openTime) / estBarMs));
    return s + barsApprox;
  },0);
  const exposurePct = openBars / totalBars;
  const durationsMin = completed.map(t => (t.exit.time - t.openTime)/(1000*60));
  const avgHoldMin = mean(durationsMin);

  // Time-based Sharpe/Sortino (daily), prefer provided eqSeries; else reconstruct from legs
  const eqSeriesEff = (eqSeries && eqSeries.length)
    ? eqSeries
    : buildEquitySeriesFromLegs({ legs, equityStart });
  const dailyRets = dailyReturns(eqSeriesEff);
  const sharpeDaily  = stddev(dailyRets) === 0 ? (dailyRets.length?Infinity:0) : mean(dailyRets)/stddev(dailyRets);
  const sortinoDaily = sortino(dailyRets);

  // Backward compatible fields (position-level), plus new leg-level fields
  return {
    // --- legacy-compatible (position-level) ---
    trades: completed.length,
    winRate: completed.length ? winsPos.length / completed.length : 0,
    profitFactor: profitFactorPos,         // unchanged meaning
    expectancy,
    totalR,
    avgR,
    sharpePerTrade,
    sortinoPerTrade,
    maxDrawdownPct: maxDD,                 // now leg-level, aligns with equity
    calmar,                                // now leg-level, aligns with equity
    maxConsecWins,
    maxConsecLosses,
    avgHoldMin,
    exposurePct,

    totalPnL: realizedPnL,
    returnPct,
    finalEquity: equityFinal,
    startEquity: equityStart,

    // --- NEW fields for clarity ---
    profitFactor_pos: profitFactorPos,     // explicit alias
    profitFactor_leg: profitFactorLeg,     // includes SCALE legs (matches equity)
    winRate_pos: completed.length ? winsPos.length / completed.length : 0,
    winRate_leg: legs.length ? legsWins.length / legs.length : 0,

    // time-based risk metrics
    sharpeDaily,
    sortinoDaily
  };
}
