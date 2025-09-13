// src/strategy/ultra/core/presets.js
export function presetDefaults(name){
  const p = (name || 'standard').toLowerCase();

  // Designed for BTC/crypto on intraday (5m/15m). Much looser gates.
  if (p === 'crypto') {
    return {
      // sessioning
      useSessionWindows: false,               // crypto 24/7
      killzones: "00:00-23:59",

      // pattern detection
      imbalanceLookback: 30,
      fvgMinBps: 2.0,
      minAtrBps: 2.5,
      needFvgAtr: 0.6,                        // allow smaller FVG/ATR than “tight”
      minBodyAtr: 0.25,

      // confirmations
      requireMicroBOS: false,
      requireSweep: false,                    // don't require a sweep on crypto by default

      // bias
      allowStrongSetupOverNeutralBias: true,
      // higher-TF bias params keep defaults from bias config
      // but we will tolerate neutral if the setup is strong

      // PD / OTE
      usePD: false,                           // PD window is less meaningful on 24/7 assets
      pdToleranceBps: 60,                     // if enabled later, make it wide
      useOTE: true,
      oteLo: 0.50,
      oteHi: 0.85
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
      oteHi:0.80
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
      oteHi:0.79
    };
  }

  // default "standard" leaves most to function defaults, but set reasonable windows for non-24/7
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
    oteHi:0.80
  };
}
