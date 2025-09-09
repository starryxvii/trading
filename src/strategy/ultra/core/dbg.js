// src/strategy/ultra/core/dbg.js
export const DBG = {
  on: false,
  barsSeen: 0,
  accepted: 0,
  rej: {
    earlyWarmup: 0,
    timeFence: 0,
    windowFence: 0,
    biasNeutralStrict: 0,
    atrTooSmall: 0,
    noSweep: 0,
    noImbalance: 0,
    fvgTooSmall: 0,
    microBosFail: 0,
    pdFail: 0,
    oteFail: 0,
    scoreFail: 0
  }
};
export function rej(reason){ if (!DBG.on) return; DBG.rej[reason]=(DBG.rej[reason]||0)+1; }
export function bindExitLog(){
  if (typeof process !== 'undefined') {
    process.on('exit', () => {
      if (!DBG.on || DBG.barsSeen === 0) return;
      const r = DBG.rej;
      console.log('[ultra debug]',
        `bars=${DBG.barsSeen}`, `accepted=${DBG.accepted}`,
        `warmup=${r.earlyWarmup}`, `time=${r.timeFence}`, `window=${r.windowFence}`,
        `bias=${r.biasNeutralStrict}`, `atr=${r.atrTooSmall}`, `sweep=${r.noSweep}`,
        `imb=${r.noImbalance}`, `fvg=${r.fvgTooSmall}`, `bos=${r.microBosFail}`,
        `pd=${r.pdFail}`, `ote=${r.oteFail}`, `score=${r.scoreFail}`
      );
    });
  }
}
