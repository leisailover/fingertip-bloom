import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { clamp, clamp01, smoothstep } from './tension.js';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAX_RADIUS = 2.35;

/** 确定性随机，保证每次重新生成花朵时构图稳定。 */
function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PETAL_LAYERS = [
  {
    petals: 7,
    base: 0.34,
    length: 1.98,
    width: 0.74,
    angleOffset: 0.25,
    zBase: -0.25,
    zCup: 0.38,
    curve: 0.06,
    baseColor: '#ff5c86',
    tipColor: '#a574ff',
    edgeColor: '#ff8fc8',
    weight: 0.4,
  },
  {
    petals: 6,
    base: 0.25,
    length: 1.44,
    width: 0.82,
    angleOffset: -0.24,
    zBase: 0.02,
    zCup: 0.42,
    curve: -0.055,
    baseColor: '#ff8b66',
    tipColor: '#ff5b99',
    edgeColor: '#ffc08f',
    weight: 0.33,
  },
  {
    petals: 5,
    base: 0.15,
    length: 0.94,
    width: 0.93,
    angleOffset: 0.58,
    zBase: 0.27,
    zCup: 0.34,
    curve: 0.08,
    baseColor: '#ffc06c',
    tipColor: '#ff8462',
    edgeColor: '#ffe0a0',
    weight: 0.19,
  },
];

const vertexShader = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uSpread;
  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform float uGlowScale;
  uniform vec2 uPointer;
  uniform float uPointerStrength;
  uniform vec3 uBudColorA;
  uniform vec3 uBudColorB;
  uniform vec3 uHotColor;

  attribute vec3 aBud;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aSeed;
  attribute float aAlpha;
  attribute float aTip;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;

  mat2 rotate2d(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
  }

  void main() {
    float morph = smoothstep(0.0, 1.0, uSpread);
    vec3 bloom = position;
    vec3 bud = aBud;

    // 花开状态下的微微旋转呼吸
    bloom.xy += vec2(-bloom.y, bloom.x) * 0.003 * uSpread;

    // 花苞与绽放姿态按 uSpread 在顶点着色器内插值
    vec3 pos = mix(bud, bloom, morph);

    float arc = sin(morph * 3.1415926536);
    float radial = length(position.xy) / 2.35;
    float seedA = fract(aSeed * 7.31);
    float seedB = fract(aSeed * 19.73);

    // 展开弧线：粒子不是走直线，而是从花苞里「旋」出来
    pos.x += (seedA - 0.5) * arc * (0.16 + 0.18 * aTip);
    pos.y += (seedB - 0.5) * arc * 0.2;
    pos.z += (0.5 - seedA) * arc * 0.48;
    pos.xy = rotate2d(arc * (0.05 + 0.16 * aSeed)) * pos.xy;

    // 生命的轻微起伏
    float sway = 0.011 + 0.05 * morph;
    pos.x += sin(uTime * 0.62 + aSeed * 8.2 + position.y * 0.35) * sway * (0.35 + radial);
    pos.y += cos(uTime * 0.51 + aSeed * 5.7 + position.x * 0.28) * sway * 0.55 * (0.4 + radial);
    pos.z += sin(uTime * 0.74 + aSeed * 9.2 + radial * 3.2) * (0.018 + 0.055 * morph) * (0.35 + aTip);
    pos.xy *= 1.0 + sin(uTime * 0.55 - radial * 2.4) * 0.008 * (0.25 + morph);

    // 指尖在局部空间推开花瓣。按距离高斯衰减，保持“轻轻碰到”的触感。
    vec2 delta = pos.xy - uPointer;
    float dist = length(delta);
    float influence = exp(-dist * dist * 2.15) * uPointerStrength;
    vec2 direction = delta / max(dist, 0.0001);
    pos.xy += direction * influence * (0.1 + 0.2 * morph) * (0.35 + 0.65 * seedA);
    pos.z += influence * 0.18 * (seedB - 0.2);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float twinkle = 0.84 + 0.16 * sin(uTime * (0.9 + seedA * 1.6) + aSeed * 40.0);
    gl_PointSize = clamp(
      aSize * uPointScale * uGlowScale * uPixelRatio * twinkle * (1.0 + influence * 0.7),
      0.8,
      64.0
    );

    vec3 budGradient = mix(uBudColorA, uBudColorB, clamp(aTip * 0.82 + seedB * 0.18, 0.0, 1.0));
    vec3 color = mix(budGradient, aColor, 0.12 + 0.88 * smoothstep(0.06, 0.8, uSpread));
    color = mix(color, uHotColor, influence * 0.45);
    color *= 1.0 + 0.36 * (1.0 - radial * 0.55) + 0.1 * twinkle;

    vColor = color;
    vAlpha = aAlpha * (0.84 + 0.16 * twinkle) * (0.88 + 0.12 * morph);
    vGlow = influence;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    float core = exp(-d * d * 9.0);
    float halo = exp(-d * d * 2.8) * (1.0 - smoothstep(0.68, 1.0, d));
    float alpha = (core * 0.84 + halo * 0.36) * vAlpha;
    vec3 color = vColor * (1.0 + core * 0.72 + halo * 0.08);
    color += vec3(0.12, 0.045, 0.025) * core * (0.35 + vGlow);

    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const glowFragmentShader = /* glsl */ `
  precision highp float;

  uniform float uGlowOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    float glow = exp(-d * d * 2.1) * (1.0 - smoothstep(0.62, 1.0, d));
    float alpha = glow * vAlpha * uGlowOpacity;
    vec3 color = vColor * (1.08 + vGlow * 0.24);
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const haloVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const haloFragmentShader = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uSpread;
  uniform float uStrength;
  uniform vec3 uWarm;
  uniform vec3 uRose;
  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float angle = atan(p.y, p.x);

    float bloomRadius = mix(0.34, 1.0, uSpread);
    float core = exp(-r * r * mix(30.0, 13.0, uSpread));
    float aura = exp(-r * r * mix(13.0, 4.0, uSpread));
    float ray = pow(max(0.0, 1.0 - r / (0.45 + 0.62 * uSpread)), 4.0);
    ray *= pow(0.5 + 0.5 * sin(angle * 7.0 + uTime * 0.08), 9.0);

    float edge = smoothstep(bloomRadius + 0.4, bloomRadius * 0.3, r);
    float alpha = (core * 0.38 + aura * 0.18 + ray * 0.06) * edge * uStrength;
    vec3 color = mix(uRose, uWarm, smoothstep(0.1, 0.9, uSpread));
    color += uWarm * core * 0.45;

    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const dustVertexShader = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform vec3 uDustA;
  uniform vec3 uDustB;

  attribute float aSeed;
  attribute float aSize;
  attribute float aAlpha;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec3 pos = position;
    pos.x += sin(uTime * 0.13 + aSeed * 13.1) * 0.33;
    pos.y += cos(uTime * 0.1 + aSeed * 8.7) * 0.24;
    pos.z += sin(uTime * 0.09 + aSeed * 5.3) * 0.18;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float twinkle = 0.65 + 0.35 * sin(uTime * 0.55 + aSeed * 30.0);
    gl_PointSize = clamp(aSize * uPointScale * uPixelRatio * 1.4 * twinkle, 0.6, 18.0);

    vColor = mix(uDustA, uDustB, fract(aSeed * 3.41));
    vAlpha = aAlpha * twinkle;
  }
`;

const dustFragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float glow = exp(-d * d * 4.0);
    gl_FragColor = vec4(vColor, glow * vAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function toLinearColor(value) {
  return new THREE.Color(value).convertSRGBToLinear();
}

function colorLerp(buffer, a, b, t) {
  buffer.copy(a).lerp(b, t);
  return buffer;
}

/**
 * Three.js 场景：粒子花朵 + 柔光 + 星尘。
 * 位置插值全部发生在顶点着色器里，CPU 每帧只更新 6 个 uniform。
 */
export class FlowerScene {
  constructor(canvas, initialParticleCount = CONFIG.particles.desktop) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
    this.camera.position.set(0, 0, 7.2);
    this.camera.lookAt(0, 0, 0);

    this.clock = new THREE.Clock();
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.targetSpread = 0.08;
    this.currentSpread = 0.08;
    this.anchorTarget = new THREE.Vector2(0, 0);
    this.anchorCurrent = new THREE.Vector2(0, 0);
    this.pointerTarget = new THREE.Vector2(0, 0);
    this.pointerCurrent = new THREE.Vector2(0, 0);
    this.pointerStrengthTarget = 0;
    this.pointerStrength = 0;
    this.baseScale = 1;
    this.viewHalfWidth = 1;
    this.viewHalfHeight = 1;
    this.particleCount = 0;
    this._count = 0;
    this._buildMaterials();
    this._buildHalo();
    this._buildDust();
    this.setParticleCount(initialParticleCount);
    this.resize();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  _buildMaterials() {
    this.uniforms = {
      uTime: { value: 0 },
      uSpread: { value: 0.08 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uPointScale: { value: 1 },
      uGlowScale: { value: 1 },
      uPointer: { value: new THREE.Vector2(99, 99) },
      uPointerStrength: { value: 0 },
      uBudColorA: { value: toLinearColor('#6f305d') },
      uBudColorB: { value: toLinearColor('#ee8194') },
      uHotColor: { value: new THREE.Color(1.0, 0.72, 0.44).convertSRGBToLinear() },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.glowUniforms = {
      ...this.uniforms,
      uGlowScale: { value: 4.35 },
      uGlowOpacity: { value: 0.19 },
    };
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: this.glowUniforms,
      vertexShader,
      fragmentShader: glowFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  _buildHalo() {
    this.haloUniforms = {
      uTime: { value: 0 },
      uSpread: { value: 0.08 },
      uStrength: { value: 0.7 },
      uWarm: { value: toLinearColor(CONFIG.theme.gold) },
      uRose: { value: toLinearColor(CONFIG.theme.rose) },
    };
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      uniforms: this.haloUniforms,
      vertexShader: haloVertexShader,
      fragmentShader: haloFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.halo = new THREE.Mesh(geometry, material);
    this.halo.scale.set(8.4, 8.4, 1);
    this.halo.position.set(0, 0, -1.1);
    this.halo.renderOrder = 1;
    this.group.add(this.halo);
  }

  _buildDust() {
    const count = 380;
    const random = mulberry32(0x5eedc0de);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const radius = 2.2 + random() * 7.5;
      const theta = random() * TAU;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = Math.sin(theta) * radius * 0.65;
      positions[i * 3 + 2] = -3 + random() * 4;
      seeds[i] = random();
      const bokeh = random() < 0.09;
      sizes[i] = bokeh ? 5.0 + random() * 8.5 : 0.6 + Math.pow(random(), 2) * 3.4;
      alphas[i] = bokeh
        ? 0.018 + random() * 0.034
        : random() < 0.08
          ? 0.12 + random() * 0.12
          : 0.035 + random() * 0.08;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

    this.dustUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uPointScale: { value: 1 },
      uDustA: { value: toLinearColor('#ffd9ad') },
      uDustB: { value: toLinearColor('#a9a0ff') },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(geometry, material);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 0;
    this.scene.add(this.dust);
  }

  setParticleCount(count) {
    const next = Math.round(
      clamp(count, CONFIG.particles.min, CONFIG.particles.max) / 500,
    ) * 500;
    if (this._count === next && this.points) return;
    this._count = next;
    this.particleCount = next;

    const { geometry } = this._createFlowerGeometry(next);
    const glowGeometry = this._createGlowGeometry(geometry, 3);
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
    }
    if (this.glowPoints) {
      this.group.remove(this.glowPoints);
      this.glowPoints.geometry.dispose();
    }
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.group.add(this.points);

    this.glowPoints = new THREE.Points(glowGeometry, this.glowMaterial);
    this.glowPoints.frustumCulled = false;
    this.glowPoints.renderOrder = 2;
    this.group.add(this.glowPoints);
  }

  /** 用同一批粒子的子集做加色辉光，主花朵用 NormalBlending 保留花瓣颜色。 */
  _createGlowGeometry(sourceGeometry, step) {
    const source = sourceGeometry.attributes;
    const sourceCount = source.position.count;
    const glowCount = Math.ceil(sourceCount / step);
    const attributes = ['position', 'aBud', 'aColor', 'aSize', 'aSeed', 'aAlpha', 'aTip'];
    const glow = new THREE.BufferGeometry();
    for (const name of attributes) {
      const attribute = source[name];
      const stride = attribute.itemSize;
      const data = new Float32Array(glowCount * stride);
      for (let i = 0; i < glowCount; i += 1) {
        const sourceIndex = Math.min(sourceCount - 1, i * step);
        for (let c = 0; c < stride; c += 1) {
          data[i * stride + c] = attribute.array[sourceIndex * stride + c];
        }
      }
      glow.setAttribute(name, new THREE.BufferAttribute(data, stride));
    }
    glow.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
    return glow;
  }

  _createFlowerGeometry(count) {
    const random = mulberry32(0xb100f1);
    const positions = new Float32Array(count * 3);
    const buds = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    const alphas = new Float32Array(count);
    const tips = new Float32Array(count);

    const coreCount = Math.round(count * 0.1);
    const outerCount = Math.round(count * 0.4);
    const middleCount = Math.round(count * 0.32);
    const innerCount = Math.max(0, count - coreCount - outerCount - middleCount);
    const layerCounts = [outerCount, middleCount, innerCount];
    const palette = PETAL_LAYERS.map((layer) => ({
      base: toLinearColor(layer.baseColor),
      tip: toLinearColor(layer.tipColor),
      edge: toLinearColor(layer.edgeColor),
    }));
    const gold = toLinearColor('#ffd082');
    const cream = toLinearColor('#fff4d4');
    const deepGold = toLinearColor('#f0a36b');
    const paleRose = toLinearColor('#ffb1bb');
    const iris = toLinearColor('#b283ff');
    const scratchColor = new THREE.Color();

    let cursor = 0;

    const writeParticle = ({
      x,
      y,
      z,
      color,
      size,
      alpha,
      seed,
      tip,
      budX,
      budY,
      budZ,
    }) => {
      if (cursor >= count) return;
      const i3 = cursor * 3;
      positions[i3] = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;
      buds[i3] = budX;
      buds[i3 + 1] = budY;
      buds[i3 + 2] = budZ;
      colors[i3] = color.r;
      colors[i3 + 1] = color.g;
      colors[i3 + 2] = color.b;
      sizes[cursor] = size;
      alphas[cursor] = alpha;
      seeds[cursor] = seed;
      tips[cursor] = tip;
      cursor += 1;
    };

    /**
     * 闭合花苞：以竖直水滴 / 螺旋花心为骨架。
     * 展开时每片花瓣的角向位置被卷到花苞周围，插值时自然解旋。
     */
    const makeBudPoint = (sourceRadius, sourceAngle, layerIndex, randomValue) => {
      const q = clamp01(sourceRadius / MAX_RADIUS);
      const h = clamp01(
        0.04 + Math.pow(q, 0.74) * 0.84 + (randomValue() - 0.5) * 0.13,
      );
      const taper = Math.pow(1 - h * 0.93, 0.32);
      const widthBase =
        Math.pow(Math.sin(Math.PI * (0.13 + 0.84 * h)), 0.64) * taper * 1.08;
      const width = 0.64 * widthBase * (0.74 + 0.26 * randomValue()) * (1 - 0.12 * h);
      const fill = 0.44 + 0.56 * Math.sqrt(randomValue());
      const spiralAngle =
        sourceAngle +
        1.18 +
        h * 3.25 +
        layerIndex * 0.82 +
        (randomValue() - 0.5) * 0.72;
      const x = Math.cos(spiralAngle) * width * fill + Math.sin(h * 4.2) * 0.055;
      const y = -1.0 + h * 2.14 + (randomValue() - 0.5) * 0.05;
      const z = Math.sin(spiralAngle) * width * fill * 0.88 + (randomValue() - 0.5) * 0.045;
      return { x, y, z };
    };

    // 1) 金色花蕊：黄金角螺旋 + 中心柔光，闭合并收拢在花苞深处。
    for (let i = 0; i < coreCount; i += 1) {
      const u = random();
      const heart = random() < 0.11;
      const radius = heart
        ? 0.025 + random() * 0.16
        : 0.1 + 0.58 * Math.pow(u, 1.15);
      const angle = i * GOLDEN_ANGLE + (random() - 0.5) * 0.2;
      const z = heart
        ? 0.3 + random() * 0.34
        : 0.2 + 0.28 * (1 - u) + (random() - 0.5) * 0.2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const tip = clamp01(radius / 0.72);
      const budRadius = 0.06 + random() * 0.16;
      const budAngle = angle + 2.4;
      const bud = {
        x: Math.cos(budAngle) * budRadius,
        y: -0.5 + random() * 1.15,
        z: Math.sin(budAngle) * budRadius * 0.7,
      };
      const colorMix = colorLerp(scratchColor, gold, cream, 0.25 + random() * 0.75);
      const glint = !heart && random() < 0.16;
      writeParticle({
        x,
        y,
        z,
        color: random() < 0.16 ? deepGold : colorMix,
        size: heart ? 4.5 + random() * 6.5 : glint ? 4.2 + random() * 5.6 : 1.5 + random() * 2.5,
        alpha: heart ? 0.2 + random() * 0.2 : glint ? 0.34 + random() * 0.26 : 0.6 + random() * 0.34,
        seed: random(),
        tip,
        budX: bud.x,
        budY: bud.y,
        budZ: bud.z,
      });
    }

    // 2) 三层花瓣：中心线附近为花脉，22% 的粒子贴着外轮廓。
    PETAL_LAYERS.forEach((layer, layerIndex) => {
      const layerTotal = layerCounts[layerIndex];
      if (!layerTotal) return;
      const halfSector = Math.PI / layer.petals;
      for (let i = 0; i < layerTotal; i += 1) {
        const petalIndex = Math.floor(random() * layer.petals);
        const petalVariation =
          1 + Math.sin(petalIndex * 2.17 + layerIndex * 1.63) * 0.055;
        const petalAngle =
          layer.angleOffset +
          (petalIndex / layer.petals) * TAU +
          Math.cos(petalIndex * 1.71 + layerIndex) * 0.035;

        const modeRoll = random();
        const isRim = modeRoll < 0.23;
        const isVein = !isRim && modeRoll < 0.32;
        const isGlint = !isRim && random() < 0.013;
        const tipBoost = random() < 0.07;

        // 略偏向花瓣外侧，让尖端和轮廓更密。
        let t = 0.055 + 0.925 * Math.pow(random(), 0.7);
        if (tipBoost) t = 0.78 + random() * 0.2;

        const petalShape = Math.max(
          0.012,
          Math.pow(Math.sin(Math.PI * Math.pow(t, 0.74)), 0.66),
        );
        const widthProfile = petalShape * (1 - 0.12 * t);

        let side;
        if (isRim) {
          side = (random() < 0.5 ? -1 : 1) * (0.93 + random() * 0.07);
        } else if (isVein) {
          side = (random() - 0.5) * 0.1;
        } else {
          side = (random() * 2 - 1) * (0.48 + 0.52 * Math.sqrt(random()));
        }

        const ruffle =
          Math.sin(t * Math.PI * 2.7 + petalIndex * 1.37 + layerIndex) *
          0.018 *
          widthProfile;
        const angle =
          petalAngle +
          side * halfSector * layer.width * widthProfile * 0.97 +
          Math.sin(t * Math.PI) * layer.curve +
          ruffle;
        const radius =
          layer.base +
          t * layer.length * petalVariation +
          (random() - 0.5) * 0.035 +
          Math.sin(t * Math.PI) * 0.025;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;

        const z =
          layer.zBase +
          layer.zCup * Math.pow(t, 1.5) +
          Math.abs(side) * 0.035 * (1 - t) +
          Math.sin(petalIndex * 1.9 + layerIndex) * 0.055 +
          (random() - 0.5) * (isRim ? 0.018 : 0.075);

        const tip = clamp01(radius / MAX_RADIUS);
        const bud = makeBudPoint(radius, angle, layerIndex, random);

        // 颜色：中心暖金 → 外层玫瑰 / 兰紫，花瓣边缘提亮。
        let color = colorLerp(
          scratchColor,
          palette[layerIndex].base,
          palette[layerIndex].tip,
          clamp01(0.08 + t * 0.92 + (random() - 0.5) * 0.12),
        );
        if (layerIndex === 0 && t > 0.62) color.lerp(iris, (t - 0.62) * 0.24);
        if (isVein) color.lerp(paleRose, 0.2);
        if (isRim) color.lerp(palette[layerIndex].edge, 0.38 + t * 0.24);
        if (radius < 0.78) color.lerp(gold, (1 - radius / 0.78) * 0.3);
        if (isGlint) color.lerp(cream, 0.7);

        let size;
        if (isGlint) size = 5.1 + random() * 6.1;
        else if (isRim) size = 2.5 + random() * 3.0;
        else if (isVein) size = 2.15 + random() * 2.45;
        else size = 1.85 + random() * 2.5;
        if (tipBoost && !isGlint) size *= 1.18;
        const alpha = isGlint
          ? 0.16 + random() * 0.18
          : isRim
            ? 0.68 + random() * 0.27
            : isVein
              ? 0.62 + random() * 0.25
              : 0.54 + random() * 0.28;

        writeParticle({
          x,
          y,
          z,
          color,
          size,
          alpha,
          seed: random(),
          tip,
          budX: bud.x,
          budY: bud.y,
          budZ: bud.z,
        });
      }
    });

    // 点数取整可能留下几个空位，用极淡的星尘补足（通常不会进入这里）。
    while (cursor < count) {
      const angle = random() * TAU;
      const radius = 0.9 + Math.pow(random(), 0.5) * 1.35;
      const layer = random() < 0.55 ? 0 : 1;
      const t = clamp01(radius / MAX_RADIUS);
      const bud = makeBudPoint(radius, angle, layer, random);
      const color = colorLerp(scratchColor, palette[layer].base, palette[layer].tip, random());
      writeParticle({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: (random() - 0.5) * 0.35,
        color,
        size: 1.2 + random() * 1.8,
        alpha: 0.22 + random() * 0.25,
        seed: random(),
        tip: t,
        budX: bud.x,
        budY: bud.y,
        budZ: bud.z,
      });
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aBud', new THREE.BufferAttribute(buds, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
    return { geometry };
  }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.position.z;
    const viewWidth = viewHeight * this.camera.aspect;
    this.viewHalfWidth = viewWidth / 2;
    this.viewHalfHeight = viewHeight / 2;

    const scale = Math.min(
      (viewWidth * 0.88) / 5.0,
      (viewHeight * 0.82) / 4.9,
      1.08,
    );
    this.baseScale = clamp(scale, 0.34, 1.08);
    this.group.scale.setScalar(this.baseScale);

    const pointScale = clamp(Math.sqrt(width / 1440) * 1.55, 0.95, 1.55);
    this.uniforms.uPixelRatio.value = pixelRatio;
    this.uniforms.uPointScale.value = pointScale;
    this.dustUniforms.uPixelRatio.value = pixelRatio;
    this.dustUniforms.uPointScale.value = pointScale;
    this.halo.scale.setScalar(8.4);
  }

  setTargetBloom(value) {
    this.targetSpread = clamp01(value);
  }

  /**
   * 目标锚点使用 NDC（-1..1），内部换算到相机 z=0 平面的世界坐标。
   * intro 画面用它把花放在文案右侧；相机模式则跟随掌心轻微移动。
   */
  setAnchorNdc(x, y) {
    this.anchorTarget.set(clamp(x, -0.82, 0.82), clamp(y, -0.7, 0.7));
  }

  /**
   * 指尖 NDC。strength=0 时隐藏局部交互；传入相机/鼠标的镜像坐标即可。
   */
  setPointerNdc(x, y, strength = 0) {
    this.pointerTarget.set(clamp(x, -1.35, 1.35), clamp(y, -1.35, 1.35));
    this.pointerStrengthTarget = clamp01(strength);
  }

  update(dt, elapsed) {
    const safeDt = clamp(dt || 0, 0, 0.06);

    // 60fps 时恰好是 0.1 的指数缓动，高刷/低帧下保持同样的时间手感。
    const frames = clamp(safeDt * 60, 0.35, 2.5);
    const spreadEase = 1 - Math.pow(1 - CONFIG.bloom.easePerFrame, frames);
    this.currentSpread += (this.targetSpread - this.currentSpread) * spreadEase;
    this.currentSpread = clamp01(this.currentSpread);

    const anchorEase = 1 - Math.exp(-safeDt * 3.4);
    this.anchorCurrent.lerp(this.anchorTarget, anchorEase);
    const pointerEase = 1 - Math.exp(-safeDt * 12);
    this.pointerCurrent.lerp(this.pointerTarget, pointerEase);
    this.pointerStrength +=
      (this.pointerStrengthTarget - this.pointerStrength) *
      (1 - Math.exp(-safeDt * 7.5));

    const anchorX = this.anchorCurrent.x * this.viewHalfWidth;
    const anchorY = this.anchorCurrent.y * this.viewHalfHeight;
    this.group.position.x += (anchorX - this.group.position.x) * (1 - Math.exp(-safeDt * 5.5));
    this.group.position.y += (anchorY - this.group.position.y) * (1 - Math.exp(-safeDt * 5.5));
    this.group.position.z = 0;

    const targetRotX = -0.045 + this.anchorCurrent.y * 0.055;
    const targetRotY = this.anchorCurrent.x * 0.06;
    this.group.rotation.x += (targetRotX - this.group.rotation.x) * (1 - Math.exp(-safeDt * 2.2));
    this.group.rotation.y += (targetRotY - this.group.rotation.y) * (1 - Math.exp(-safeDt * 2.2));
    this.group.rotation.z = Math.sin(elapsed * 0.16) * 0.012;

    const localPointerX =
      (this.pointerCurrent.x * this.viewHalfWidth - this.group.position.x) / this.baseScale;
    const localPointerY =
      (this.pointerCurrent.y * this.viewHalfHeight - this.group.position.y) / this.baseScale;
    this.uniforms.uPointer.value.set(localPointerX, localPointerY);

    this.uniforms.uTime.value = elapsed;
    this.uniforms.uSpread.value = this.currentSpread;
    this.uniforms.uPointerStrength.value = this.pointerStrength;

    this.haloUniforms.uTime.value = elapsed;
    this.haloUniforms.uSpread.value = this.currentSpread;
    this.haloUniforms.uStrength.value = 0.66 + this.currentSpread * 0.72;
    this.halo.position.y = -0.05 + Math.sin(elapsed * 0.3) * 0.02;

    this.dustUniforms.uTime.value = elapsed;
    this.dust.rotation.z = Math.sin(elapsed * 0.018) * 0.025;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.points?.geometry.dispose();
    this.glowPoints?.geometry.dispose();
    this.material.dispose();
    this.glowMaterial.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
    this.dust.geometry.dispose();
    this.dust.material.dispose();
    this.renderer.dispose();
  }
}
