// src/strategy/ultra/core/presets.js
export function presetDefaults(name){
  const p = (name || 'standard').toLowerCase();
  if (p === 'loose') {
    return { useSessionWindows:false, imbalanceLookback:30, fvgMinBps:2, minAtrBps:4, requireMicroBOS:false, allowStrongSetupOverNeutralBias:true };
  }
  if (p === 'tight') {
    return { useSessionWindows:true, imbalanceLookback:10, fvgMinBps:5, minAtrBps:7, requireMicroBOS:true, allowStrongSetupOverNeutralBias:false };
  }
  return {};
}
