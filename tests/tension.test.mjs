import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bloomTargetFromTension,
  calculateTension,
  isPlausibleHand,
  tensionState,
  TensionSmoother,
} from '../src/tension.js';

function openHand() {
  return [
    { x: 0.5, y: 0.9 }, // wrist
    { x: 0.4, y: 0.82 },
    { x: 0.33, y: 0.75 },
    { x: 0.27, y: 0.69 },
    { x: 0.2, y: 0.65 },
    { x: 0.41, y: 0.62 }, // index mcp
    { x: 0.4, y: 0.48 },
    { x: 0.4, y: 0.38 },
    { x: 0.4, y: 0.26 },
    { x: 0.5, y: 0.6 }, // middle mcp
    { x: 0.5, y: 0.44 },
    { x: 0.5, y: 0.32 },
    { x: 0.5, y: 0.18 },
    { x: 0.59, y: 0.62 }, // ring mcp
    { x: 0.59, y: 0.48 },
    { x: 0.59, y: 0.38 },
    { x: 0.59, y: 0.27 },
    { x: 0.67, y: 0.66 }, // pinky mcp
    { x: 0.67, y: 0.55 },
    { x: 0.67, y: 0.47 },
    { x: 0.67, y: 0.38 },
  ];
}

function fistHand() {
  const points = openHand();
  const curls = {
    6: [0.45, 0.58], 7: [0.46, 0.66], 8: [0.48, 0.72],
    10: [0.5, 0.56], 11: [0.51, 0.65], 12: [0.52, 0.71],
    14: [0.55, 0.58], 15: [0.54, 0.66], 16: [0.53, 0.72],
    18: [0.61, 0.62], 19: [0.6, 0.7], 20: [0.59, 0.76],
  };
  for (const [index, [x, y]] of Object.entries(curls)) {
    points[Number(index)] = { x, y };
  }
  return points;
}

test('open hand maps to a high tension', () => {
  const result = calculateTension(openHand());
  assert.ok(result, 'expected landmarks to be valid');
  assert.ok(result.raw > 0.85, `open hand raw=${result.raw}`);
  assert.equal(tensionState(result.raw), 'open');
});

test('closed fist maps below the bud threshold', () => {
  const result = calculateTension(fistHand());
  assert.ok(result, 'expected landmarks to be valid');
  assert.ok(result.raw < 0.32, `fist raw=${result.raw}`);
  assert.equal(tensionState(result.raw), 'closed');
});

test('bloom thresholds are strict and smooth', () => {
  assert.equal(bloomTargetFromTension(0.2), 0);
  assert.equal(bloomTargetFromTension(0.9), 1);
  const middle = bloomTargetFromTension(0.49);
  assert.ok(middle > 0.4 && middle < 0.6, `middle bloom=${middle}`);
  assert.equal(tensionState(0.2), 'closed');
  assert.equal(tensionState(0.49), 'opening');
  assert.equal(tensionState(0.8), 'open');
});

test('smoothing converges without overshoot', () => {
  const smoother = new TensionSmoother(0);
  for (let i = 0; i < 120; i += 1) smoother.update(1, 1 / 60);
  assert.ok(smoother.value > 0.97 && smoother.value <= 1);
  for (let i = 0; i < 120; i += 1) smoother.update(0, 1 / 60);
  assert.ok(smoother.value < 0.03 && smoother.value >= 0);
});

test('invalid or implausible landmarks are ignored', () => {
  assert.equal(calculateTension(null), null);
  assert.equal(calculateTension([]), null);
  assert.equal(isPlausibleHand(null), false);
  assert.equal(isPlausibleHand(openHand()), true);
});
