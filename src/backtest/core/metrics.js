// src/backtest/core/metrics.js

function sum(a){ return a.reduce((s,x)=>s+x,0); }
function mean(a){ return a.length ? sum(a)/a.length : 0; }
function stddev(a){ if(a.length<=1) return 0; const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); }
function sortino(returns){
  const neg = returns.filter(x=>x<0);
  const dd = stddev(neg.length?neg:[0]);
  const avg = mean(returns);
  return dd===0 ? Infinity : avg/dd;
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

/**
 * Build metrics with correct start/final equity handling.
 * @param {Object} args
 * @param {Array}  args.closed
 * @param {number} args.equityStart
 * @param {number} args.equityFinal
 * @param {Array}  args.candles
 * @param {number} args.estBarMs
 */
export function buildMetrics({ closed, equityStart, equityFinal, candles, estBarMs }) {
  const completed = closed.filter(t => t.exit.reason !== 'SCALE');
  const wins   = completed.filter(t => t.exit.pnl > 0);
  const losses = completed.filter(t => t.exit.pnl < 0);

  const allPnls = closed.map(t => t.exit.pnl);
  const realizedPnL = sum(allPnls);

  const Rs = completed.map(rMultiple);
  const totalR = sum(Rs);
  const avgR   = mean(Rs);

  let peak = equityStart, maxDD = 0, cur = equityStart;
  const labels = [];
  for (const t of completed) {
    cur += t.exit.pnl;
    labels.push(t.exit.pnl > 0 ? 'win' : (t.exit.pnl < 0 ? 'loss' : 'flat'));
    if (cur > peak) peak = cur;
    const dd = (peak - cur) / (peak || 1);
    if (dd > maxDD) maxDD = dd;
  }
  const { maxWin:maxConsecWins, maxLoss:maxConsecLosses } = streaks(labels);

  const tradePnls = completed.map(t => t.exit.pnl);
  const expectancy = mean(tradePnls);
  const rets = completed.map(t => t.exit.pnl / Math.max(1e-12, equityStart));
  const retStd = stddev(rets);
  const sharpePerTrade  = retStd === 0 ? (rets.length ? Infinity : 0) : mean(rets)/retStd;
  const sortinoPerTrade = sortino(rets);

  const totalBars = Math.max(1, candles.length);
  const openBars = completed.reduce((s,t)=>{
    const barsApprox = Math.max(1, Math.round((t.exit.time - t.openTime) / estBarMs));
    return s + barsApprox;
  },0);
  const exposurePct = openBars / totalBars;
  const durationsMin = completed.map(t => (t.exit.time - t.openTime)/(1000*60));
  const avgHoldMin = mean(durationsMin);

  const avgWin  = mean(wins.map(t => t.exit.pnl));
  const avgLoss = Math.abs(mean(losses.map(t => t.exit.pnl)));
  const grossPos = wins.reduce((s,t)=>s+t.exit.pnl,0);
  const grossNeg = Math.abs(losses.reduce((s,t)=>s+t.exit.pnl,0));
  const profitFactor = (grossNeg===0) ? (grossPos>0?Infinity:0) : (grossPos/grossNeg);

  const returnPct = (equityFinal - equityStart) / Math.max(1e-12, equityStart);
  const calmar = maxDD === 0 ? (realizedPnL > 0 ? Infinity : 0) : (returnPct) / maxDD;

  return {
    trades: completed.length,
    winRate: completed.length ? wins.length / completed.length : 0,
    profitFactor,
    expectancy,
    totalR,
    avgR,
    sharpePerTrade,
    sortinoPerTrade,
    maxDrawdownPct: maxDD,
    calmar,
    maxConsecWins,
    maxConsecLosses,
    avgHoldMin,
    exposurePct,

    totalPnL: realizedPnL,
    returnPct,
    finalEquity: equityFinal,
    startEquity: equityStart
  };
}
