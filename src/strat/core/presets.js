// src/strat/core/presets.js
export function presetDefaults(name){
  const p = (name || 'standard').toLowerCase();

  // Crypto intraday: looser gates, 24/7, OTE on by default for 79% flavor.
  if (p === 'crypto') {
    return {
      useSessionWindows: false,
      killzones: "00:00-23:59",

      imbalanceLookback: 30,
      fvgMinBps: 2.0,
      minAtrBps: 2.5,
      needFvgAtr: 0.6,
      minBodyAtr: 0.25,

      requireMicroBOS: true,
      requireSweep: false,

      allowStrongSetupOverNeutralBias: true,

      usePD: false,
      pdToleranceBps: 60,

      // “79%” confirmation via OTE zone
      useOTE: true,
      oteLo: 0.70,
      oteHi: 0.82,

      // TP logic defaults
      tpMode: 'hybrid',        // 'rr' | 'key' | 'hybrid'
      rrMinForKey: 1.20
    };
  }

  if (p === 'loose') {
    return {
      useSessionWindows:false,
      killzones: "00:00-23:59",
      imbalanceLookback:30,
      fvgMinBps:2,
      minAtrBps:4,
      needFvgAtr:0.75,
      minBodyAtr:0.25,
      requireMicroBOS:false,
      requireSweep:false,
      allowStrongSetupOverNeutralBias:true,
      usePD:false,
      pdToleranceBps:50,
      useOTE:true,
      oteLo:0.55,
      oteHi:0.80,
      tpMode: 'hybrid',
      rrMinForKey: 1.15
    };
  }

  if (p === 'tight') {
    return {
      useSessionWindows:true,
      killzones: "02:00-05:00,08:30-10:00,13:30-15:00",
      imbalanceLookback:10,
      fvgMinBps:5,
      minAtrBps:7,
      needFvgAtr:0.85,
      minBodyAtr:0.35,
      requireMicroBOS:true,
      requireSweep:true,
      allowStrongSetupOverNeutralBias:false,
      usePD:true,
      pdToleranceBps:30,
      useOTE:true,
      oteLo:0.62,
      oteHi:0.79,
      tpMode: 'rr',
      rrMinForKey: 1.50
    };
  }

  // default
  return {
    useSessionWindows:false,
    killzones: "08:30-11:30,13:30-15:30",
    imbalanceLookback:20,
    fvgMinBps:2.5,
    minAtrBps:3,
    needFvgAtr:0.8,
    minBodyAtr:0.30,
    requireMicroBOS:true,
    requireSweep:true,
    allowStrongSetupOverNeutralBias:false,
    usePD:true,
    pdToleranceBps:36,
    useOTE:true,
    oteLo:0.60,
    oteHi:0.80,
    tpMode: 'hybrid',
    rrMinForKey: 1.25
  };
}
