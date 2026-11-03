/**
 * 手势数学
 * ------------------------------------------------------------
 * 手掌张力 tension 的目标是把「手部开合」稳定映射到 0..1。
 *
 * 第一层：尺度无关的伸展比
 *   R_f = ||tip_f - wrist|| / ||mcp_f - wrist||
 *   E   = mean(R_f)  (食指/中指/无名指/小指)
 *
 * 第二层：指节是否伸直
 *   bend_f = angle(mcp→pip, pip→tip)
 *   S_f    = 1 - smoothstep(0.35, 1.65, bend_f)
 *   B      = mean(S_f)
 *
 * 第三层：合并并归一化
 *   reach  = smoothstep(1.00, 1.90, E)
 *   raw    = clamp(reach * 0.78 + B * 0.22, 0, 1)
 *
 * 第四层：时间平滑（在 TensionSmoother 中）
 *   tension += (raw - tension) * (1 - exp(-Δt / 0.085))
 *
 * 阈值：< 0.32 花苞；0.32..0.66 舒展；> 0.66 盛开。
 */
import { CONFIG } from './config.js';

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERS = [
  { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
  { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
  { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
  { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 },
];

export const TIPS = [4, 8, 12, 16, 20];
export const PALM_IDS = [0, 5, 9, 13, 17];

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const clamp01 = (value) => clamp(value, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;

export function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / Math.max(1e-8, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 二维向量夹角，返回 0..π。 */
export function segmentAngle(a, b, c, d) {
  const ax = b.x - a.x;
  const ay = b.y - a.y;
  const bx = d.x - c.x;
  const by = d.y - c.y;
  const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (denominator < 1e-8) return 0;
  const cosine = clamp((ax * bx + ay * by) / denominator, -1, 1);
  return Math.acos(cosine);
}

/**
 * 计算单手原始张力。
 * @param {Array<{x:number,y:number,z?:number}>} landmarks 21 个归一化关键点
 * @returns {null | {
 *   raw:number, reach:number, reachNorm:number, straightness:number,
 *   fingers:Array<{name:string, ratio:number, bend:number}>
 * }}
 */
export function calculateTension(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return null;
  const wrist = landmarks[0];
  let ratioSum = 0;
  let straightSum = 0;
  const fingers = [];

  for (const finger of FINGERS) {
    const mcp = landmarks[finger.mcp];
    const pip = landmarks[finger.pip];
    const tip = landmarks[finger.tip];
    if (!mcp || !pip || !tip) return null;

    // 手腕→指根 的距离作为尺子，抵消手与镜头的远近。
    const knuckle = Math.max(distance2D(wrist, mcp), 1e-5);
    const ratio = distance2D(wrist, tip) / knuckle;

    // 伸直时 mcp→pip 与 pip→tip 近似同向 (angle≈0)；
    // 握拳卷曲时夹角变大，所以用 1 - angle 映射伸展度。
    const angle = segmentAngle(mcp, pip, pip, tip);
    const straight = 1 - smoothstep(0.35, 1.65, angle);

    ratioSum += clamp(ratio, 0, 3);
    straightSum += straight;
    fingers.push({ name: finger.name, ratio, bend: angle });
  }

  const reach = ratioSum / FINGERS.length;
  const straightness = straightSum / FINGERS.length;
  const reachNorm = smoothstep(
    CONFIG.tension.ratioFist,
    CONFIG.tension.ratioOpen,
    reach,
  );
  const raw = clamp01(reachNorm * 0.78 + straightness * 0.22);

  return { raw, reach, reachNorm, straightness, fingers };
}

/**
 * 帧率无关的指数平滑。Δt=0.085s 时约消除 63% 的误差。
 */
export class TensionSmoother {
  constructor(initial = CONFIG.tension.restValue) {
    this.value = initial;
  }

  reset(value = CONFIG.tension.restValue) {
    this.value = clamp01(value);
    return this.value;
  }

  update(raw, dtSeconds) {
    const target = clamp01(raw);
    const dt = clamp(dtSeconds, 0, 0.1);
    const alpha = 1 - Math.exp(-dt / CONFIG.tension.smoothingTau);
    this.value += (target - this.value) * alpha;
    this.value = clamp01(this.value);
    return this.value;
  }
}

/** tension → 视觉绽放目标。0.32 以下完全闭合，0.66 以上完全绽放。 */
export function bloomTargetFromTension(tension) {
  return smoothstep(CONFIG.bloom.closedAt, CONFIG.bloom.openAt, tension);
}

/** 按阈值返回便于 UI 使用的状态。 */
export function tensionState(tension) {
  if (tension < CONFIG.bloom.closedAt) return 'closed';
  if (tension > CONFIG.bloom.openAt) return 'open';
  return 'opening';
}

export function getPalmCenter(landmarks) {
  if (!landmarks?.length) return null;
  const total = PALM_IDS.reduce(
    (acc, index) => {
      acc.x += landmarks[index].x;
      acc.y += landmarks[index].y;
      return acc;
    },
    { x: 0, y: 0 },
  );
  return { x: total.x / PALM_IDS.length, y: total.y / PALM_IDS.length };
}

/** 手部是否在画面中、指根间距是否可信，作为轻量的有效性检查。 */
export function isPlausibleHand(landmarks) {
  if (!landmarks || landmarks.length !== 21) return false;
  const wrist = landmarks[0];
  const middle = landmarks[9];
  const palmSpan = Math.hypot(wrist.x - middle.x, wrist.y - middle.y);
  return palmSpan > 0.035 && palmSpan < 0.55;
}
