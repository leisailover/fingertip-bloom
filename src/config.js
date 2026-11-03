/**
 * 指尖生花 · 可调参数
 * ------------------------------------------------------------
 * 所有和视觉/手势相关的常量集中在这里，方便二次创作。
 */
export const CONFIG = {
  particles: {
    min: 5000,
    max: 20000,
    step: 500,
    desktop: 15000,
    mobile: 9000,
    lowPower: 7000,
  },

  /* 手掌张力：(手腕→指尖 / 手腕→指根) 的归一化区间 */
  tension: {
    ratioFist: 1.0,
    ratioOpen: 1.9,
    smoothingTau: 0.085, // 秒：越小越跟手，越大越稳定
    restValue: 0.1,
    lostAfterMs: 420,
  },

  /* 视觉绽放阈值 */
  bloom: {
    closedAt: 0.32,
    openAt: 0.66,
    easePerFrame: 0.1, // 60fps 下每次向目标靠近 10%
  },

  camera: {
    width: 1280,
    height: 720,
    fps: 30,
    detectionConfidence: 0.58,
    trackingConfidence: 0.62,
  },

  theme: {
    ink: '#06050b',
    gold: '#ffd7a1',
    coral: '#ff9c86',
    rose: '#ff6f9d',
    orchid: '#a98bff',
    mist: '#ffd7e6',
  },
};

export const isCoarsePointer =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: coarse)').matches;

export const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function pickDefaultParticleCount() {
  if (typeof window === 'undefined') return CONFIG.particles.desktop;
  try {
    const raw = window.localStorage?.getItem('bloom:particles');
    const saved = raw === null || raw === '' ? Number.NaN : Number(raw);
    if (Number.isFinite(saved)) {
      return Math.min(
        CONFIG.particles.max,
        Math.max(CONFIG.particles.min, Math.round(saved / 500) * 500),
      );
    }
  } catch {
    // 隐私模式下 localStorage 不可用，使用设备默认值。
  }
  if (isCoarsePointer) return CONFIG.particles.mobile;
  if ((navigator.hardwareConcurrency || 8) <= 4) return CONFIG.particles.lowPower;
  return CONFIG.particles.desktop;
}
