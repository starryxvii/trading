// src/risk/positionSizing.js
export function positionSize({
  equity,
  entry,
  stop,
  riskFraction = 0.01,   
  qtyStep = 0.001,     
  minQty = 0.001,
  maxLeverage = 2.0       // cap notional <= equity * maxLeverage
}) {
  const perUnitRisk = Math.abs(entry - stop);
  if (!Number.isFinite(perUnitRisk) || perUnitRisk <= 0) return 0;

  const dollarRisk = Math.max(0, equity * riskFraction);
  let qtyRisk = dollarRisk / perUnitRisk;

  // leverage guard
  const maxQtyByLev = (equity * maxLeverage) / Math.max(1e-12, entry);
  qtyRisk = Math.min(qtyRisk, maxQtyByLev);

  // step to exchange lot size
  const roundStep = (x) => Math.floor(x / qtyStep) * qtyStep;
  const q = roundStep(qtyRisk);

  return q >= minQty ? q : 0;
}
