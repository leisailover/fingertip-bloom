import { FlowerScene } from './flowerScene.js';
import { HandTracker, HandTrackerError } from './handTracker.js';
import {
  CONFIG,
  pickDefaultParticleCount,
  prefersReducedMotion,
} from './config.js';
import {
  bloomTargetFromTension,
  calculateTension,
  clamp,
  clamp01,
  getPalmCenter,
  isPlausibleHand,
  smoothstep,
  tensionState,
  TensionSmoother,
} from './tension.js';

const $ = (id) => document.getElementById(id);
const numberFormatter = new Intl.NumberFormat('zh-CN');
const HAND_PALM_IDS = [0, 1, 5, 9, 13, 17];

function parseParticleQuery() {
  const raw = new URLSearchParams(window.location.search).get('particles');
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return clamp(
    Math.round(value / CONFIG.particles.step) * CONFIG.particles.step,
    CONFIG.particles.min,
    CONFIG.particles.max,
  );
}

function getCameraErrorCopy(error) {
  const base = {
    title: '摄像头没有启动',
    message:
      '浏览器或系统阻止了摄像头访问。你仍然可以使用鼠标体验花朵，或检查权限后重试。',
    tips: [
      '点击浏览器地址栏左侧的摄像头图标，将权限改为“允许”。',
      '确认没有其他应用正在占用摄像头。',
      '通过本地 HTTP 服务打开页面，而不是直接双击 HTML 文件。',
    ],
  };

  if (!error) return base;
  if (error.code === 'webgl') {
    return {
      title: '无法绘制粒子花朵',
      message:
        '当前浏览器没有成功创建 WebGL2 画布。请更新浏览器，或开启硬件加速后重新打开页面。',
      tips: [
        '建议使用最新版 Chrome、Edge 或 Safari。',
        '检查浏览器设置中的“硬件加速”是否开启。',
        '如果使用远程桌面或虚拟机，请尝试关闭省电模式后刷新。',
      ],
    };
  }

  if (error.code === 'insecure-context') {
    return {
      title: '需要本地 HTTP 服务',
      message:
        '浏览器的安全策略只允许在 localhost 或 HTTPS 页面中调用摄像头。这个页面必须通过本地服务器打开。',
      tips: [
        '在项目目录运行 node server.mjs。',
        '然后访问 http://localhost:8080，而不是 file:// 地址。',
      ],
    };
  }

  if (error.code === 'unsupported') {
    return {
      title: '浏览器不支持摄像头',
      message: '当前浏览器无法访问摄像头。请使用最新版 Chrome、Edge 或 Safari。',
      tips: ['确认浏览器版本较新。', '在手机端请使用系统浏览器或最新版 Safari / Chrome。'],
    };
  }

  if (['engine-load', 'engine-init', 'engine-timeout'].includes(error.code)) {
    return {
      title: '手势引擎没有准备好',
      message:
        error.message ||
        'MediaPipe Hands 的 WebAssembly 模型未能加载。请检查本地服务和依赖文件。',
      tips: [
        '确认使用 node server.mjs 或 python -m http.server 启动本地服务。',
        '确认 vendor/mediapipe/hands 文件夹完整（尤其是 .wasm 和 .data 文件）。',
        '刷新页面后再次尝试。',
      ],
    };
  }

  if (error.code === 'camera-lost' || error.code === 'detection-loop') {
    return {
      title: '手部追踪中断',
      message: error.message || '摄像头连接或识别进程意外结束，请重新开启摄像头。',
      tips: [
        '检查摄像头连接线或设备状态。',
        '关闭占用摄像头的其他应用。',
        '点击重新尝试，或先进入鼠标体验。',
      ],
    };
  }

  if (error.code === 'get-user-media') {
    const name = error.cause?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return {
        title: '摄像头权限被关闭',
        message:
          '你拒绝了摄像头权限，或者浏览器正在阻止它。允许权限后，花朵才能读取你的手势。',
        tips: [
          '点击地址栏左侧的摄像头图标，选择“允许”。',
          '进入浏览器的站点设置，把本站摄像头权限改为允许。',
          '修改后点击“重新尝试”。',
        ],
      };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return {
        title: '没有找到摄像头',
        message: '系统没有检测到可用摄像头。你仍然可以先用鼠标体验这朵花。',
        tips: ['连接一个摄像头后重试。', '确认系统设置中摄像头未被禁用。'],
      };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return {
        title: '摄像头被占用',
        message: '摄像头正被其他应用读取，或设备暂时无法启动。请关闭占用它的程序。',
        tips: ['退出视频会议、相机或录屏软件后重试。', '也可以先进入鼠标体验。'],
      };
    }
    return {
      ...base,
      message: error.message || base.message,
    };
  }

  return {
    ...base,
    message: error.message || base.message,
  };
}

class BloomApp {
  constructor() {
    this.el = {
      app: $('app'),
      sceneCanvas: $('sceneCanvas'),
      cameraCanvas: $('cameraCanvas'),
      handCanvas: $('handCanvas'),
      introScreen: $('introScreen'),
      activeUi: $('activeUi'),
      startBtn: $('startBtn'),
      demoBtn: $('demoBtn'),
      settingsBtn: $('settingsBtn'),
      settingsPanel: $('settingsPanel'),
      closeSettingsBtn: $('closeSettingsBtn'),
      panelScrim: $('panelScrim'),
      particleRange: $('particleRange'),
      particleOutput: $('particleOutput'),
      skeletonToggle: $('skeletonToggle'),
      backdropToggle: $('backdropToggle'),
      resetViewBtn: $('resetViewBtn'),
      startCameraBtn: $('startCameraBtn'),
      stopCameraBtn: $('stopCameraBtn'),
      fpsReadout: $('fpsReadout'),
      trackingChip: $('trackingChip'),
      trackingText: $('trackingText'),
      hudKicker: $('hudKicker'),
      hudHint: $('hudHint'),
      tensionTrack: $('tensionTrack'),
      tensionFill: $('tensionFill'),
      tensionKnob: $('tensionKnob'),
      tensionValue: $('tensionValue'),
      flowerState: $('flowerState'),
      bloomStateText: $('bloomStateText'),
      toast: $('toast'),
      loadingOverlay: $('loadingOverlay'),
      loadingMessage: $('loadingMessage'),
      cancelLoadingBtn: $('cancelLoadingBtn'),
      errorDialog: $('errorDialog'),
      errorTitle: $('errorTitle'),
      errorMessage: $('errorMessage'),
      errorTips: $('errorTips'),
      retryCameraBtn: $('retryCameraBtn'),
      errorDemoBtn: $('errorDemoBtn'),
      errorCloseBtn: $('errorCloseBtn'),
    };

    this.query = new URLSearchParams(window.location.search);
    this.particleCount =
      parseParticleQuery() || pickDefaultParticleCount();
    this.reducedMotion = prefersReducedMotion;

    this.flower = null;
    this.cameraCtx = null;
    this.handCtx = null;
    this.overlayDpr = 1;
    this.viewport = { width: window.innerWidth, height: window.innerHeight };
    this.cameraRect = null;

    this.mode = 'intro';
    this.cameraActive = false;
    this.handTracker = null;
    this.loadingToken = 0;
    this.starting = false;
    this.fatalHandling = false;
    this.handPresent = false;
    this.handReport = null;
    this.lastHandSeenAt = 0;
    this.lastHandUiState = '';

    this.smoother = new TensionSmoother(0.16);
    this.tension = 0.16;
    this.demoPressed = false;
    this.keyboardPressed = false;
    this.debugTension = null;

    this.pointer = {
      clientX: window.innerWidth * 0.5,
      clientY: window.innerHeight * 0.45,
      nx: 0,
      ny: 0,
      moved: false,
    };

    this.webglFailed = false;
    this.currentErrorCode = '';

    this.elapsed = 0;
    this.lastFrame = performance.now();
    this.lastCameraDraw = 0;
    this.lastSkeletonDraw = 0;
    this.toastTimer = 0;
    this.particleTimer = 0;
    this.resizeRaf = 0;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsAccumulator = 0;

    this.skeletonEnabled = true;
    this.backdropEnabled = true;
    this.el.app.dataset.skeleton = 'on';
    this.el.app.dataset.cameraBackdrop = 'on';

    this._lastHud = { percent: -1, state: '', hint: '' };
    this._boundLoop = this._loop.bind(this);
    this._boundPointerMove = this._onPointerMove.bind(this);
    this._boundPointerDown = this._onPointerDown.bind(this);
    this._boundPointerUp = this._onPointerUp.bind(this);
    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundKeyUp = this._onKeyUp.bind(this);
  }

  init() {
    this._initFlower();
    this._setupOverlayCanvases();
    this._bindUI();
    this._bindPointer();
    this._bindKeyboard();
    this._setupResize();
    this._showIntro({ immediate: true, resetFlower: true });
    this._resizeOverlays();

    window.addEventListener('beforeunload', () => {
      this.handTracker?.stop();
    });

    this.lastFrame = performance.now();
    requestAnimationFrame(this._boundLoop);

    window.__BLOOM_APP__ = this;
    window.__APP_READY = true;

    if (this.query.get('demo') === '1') {
      window.setTimeout(() => {
        if (this.flower) this.enterDemo();
      }, 450);
    }
  }

  _initFlower() {
    try {
      this.flower = new FlowerScene(this.el.sceneCanvas, this.particleCount);
      this.el.particleRange.min = String(CONFIG.particles.min);
      this.el.particleRange.max = String(CONFIG.particles.max);
      this.el.particleRange.step = String(CONFIG.particles.step);
      this.el.particleRange.value = String(this.particleCount);
      this.el.particleOutput.textContent = numberFormatter.format(this.particleCount);
    } catch (error) {
      console.error('[bloom] WebGL setup failed:', error);
      this.flower = null;
      this.webglFailed = true;
      this.el.startBtn.disabled = true;
      this.el.demoBtn.disabled = true;
      window.setTimeout(() => {
        this._showErrorDialog({
          code: 'webgl',
          message: '无法创建 WebGL2 渲染上下文，粒子花朵无法显示。',
        });
      }, 300);
    }
  }

  _setupOverlayCanvases() {
    this.cameraCtx = this.el.cameraCanvas.getContext('2d', { alpha: true });
    this.handCtx = this.el.handCanvas.getContext('2d', { alpha: true });
    this._resizeOverlays();
  }

  _setupResize() {
    window.addEventListener(
      'resize',
      () => {
        if (this.resizeRaf) return;
        this.resizeRaf = requestAnimationFrame(() => {
          this.resizeRaf = 0;
          this._resizeOverlays();
        });
      },
      { passive: true },
    );
    window.addEventListener(
      'orientationchange',
      () => {
        window.setTimeout(() => this._resizeOverlays(), 180);
      },
      { passive: true },
    );
  }

  _resizeOverlays() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.viewport = { width, height };
    this.overlayDpr = dpr;
    for (const canvas of [this.el.cameraCanvas, this.el.handCanvas]) {
      const nextWidth = Math.round(width * dpr);
      const nextHeight = Math.round(height * dpr);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
    }
    if (!this.cameraActive) this._clearOverlayCanvases();
  }

  _clearOverlayCanvases() {
    for (const ctx of [this.cameraCtx, this.handCtx]) {
      if (!ctx) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    this.cameraRect = null;
  }

  _bindUI() {
    this.el.startBtn.addEventListener('click', () => this.startCamera());
    this.el.demoBtn.addEventListener('click', () => this.enterDemo());
    this.el.settingsBtn.addEventListener('click', () =>
      this._setSettingsOpen(this.el.settingsPanel.hidden),
    );
    this.el.closeSettingsBtn.addEventListener('click', () => this._setSettingsOpen(false));
    this.el.panelScrim.addEventListener('click', () => this._setSettingsOpen(false));

    this.el.particleRange.addEventListener('input', () => {
      const count = Number(this.el.particleRange.value);
      this.el.particleOutput.textContent = numberFormatter.format(count);
      this.el.particleRange.setAttribute(
        'aria-valuetext',
        `${numberFormatter.format(count)} 个粒子`,
      );
      window.clearTimeout(this.particleTimer);
      this.particleTimer = window.setTimeout(() => this._applyParticleCount(count), 140);
    });
    this.el.particleRange.addEventListener('change', () => {
      window.clearTimeout(this.particleTimer);
      this._applyParticleCount(Number(this.el.particleRange.value));
    });

    this.el.skeletonToggle.addEventListener('change', () => {
      this.skeletonEnabled = this.el.skeletonToggle.checked;
      this.el.app.dataset.skeleton = this.skeletonEnabled ? 'on' : 'off';
      if (!this.skeletonEnabled) this._clearHandOverlay();
      if (this.cameraActive) {
        this._showToast(this.skeletonEnabled ? '手部骨骼已显示' : '手部骨骼已隐藏');
      }
    });

    this.el.backdropToggle.addEventListener('change', () => {
      this.backdropEnabled = this.el.backdropToggle.checked;
      this.el.app.dataset.cameraBackdrop = this.backdropEnabled ? 'on' : 'off';
      if (this.backdropEnabled) this.lastCameraDraw = 0;
      if (this.cameraActive) {
        this._showToast(this.backdropEnabled ? '摄像头背景已显示' : '摄像头背景已隐藏');
      }
    });

    this.el.resetViewBtn.addEventListener('click', () => this._resetView());
    this.el.startCameraBtn.addEventListener('click', () => {
      this._setSettingsOpen(false);
      this.startCamera();
    });
    this.el.stopCameraBtn.addEventListener('click', () => this.stopCameraAndReturn());
    this.el.cancelLoadingBtn.addEventListener('click', () => this._cancelCameraStart());
    this.el.retryCameraBtn.addEventListener('click', () => {
      if (this.currentErrorCode === 'webgl') {
        window.location.reload();
        return;
      }
      this._closeErrorDialog();
      this.startCamera();
    });
    this.el.errorDemoBtn.addEventListener('click', () => {
      this._closeErrorDialog();
      this.enterDemo();
    });
    this.el.errorCloseBtn.addEventListener('click', () => this._closeErrorDialog());
    this.el.errorDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this._closeErrorDialog();
    });

    this._setSettingsOpen(false);

    this._updateParticleOutput();
  }

  _updateParticleOutput() {
    const count = this.flower?.particleCount || this.particleCount;
    this.el.particleOutput.textContent = numberFormatter.format(count);
    this.el.particleRange.setAttribute(
      'aria-valuetext',
      `${numberFormatter.format(count)} 个粒子`,
    );
  }

  _applyParticleCount(count) {
    if (!this.flower) return;
    this.particleCount = count;
    this.flower.setParticleCount(count);
    this._updateParticleOutput();
    try {
      window.localStorage?.setItem('bloom:particles', String(count));
    } catch {
      // 本地存储不可用时静默失败。
    }
  }

  _setSettingsOpen(open) {
    if (open && !this.flower) return;
    this.el.settingsPanel.hidden = !open;
    this.el.panelScrim.hidden = !open;
    this.el.settingsBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.el.settingsPanel.scrollTop = 0;
      window.setTimeout(() => this.el.closeSettingsBtn.focus({ preventScroll: true }), 80);
    } else if (document.activeElement === this.el.closeSettingsBtn) {
      this.el.settingsBtn.focus({ preventScroll: true });
    }
  }

  get settingsOpen() {
    return !this.el.settingsPanel.hidden;
  }

  _bindPointer() {
    window.addEventListener('pointermove', this._boundPointerMove, { passive: true });
    window.addEventListener('pointerdown', this._boundPointerDown, { passive: false });
    window.addEventListener('pointerup', this._boundPointerUp, { passive: true });
    window.addEventListener('pointercancel', this._boundPointerUp, { passive: true });
    window.addEventListener('blur', this._boundPointerUp);
    window.addEventListener('contextmenu', (event) => {
      if (this.mode === 'demo' && !this._isInteractiveTarget(event.target)) {
        event.preventDefault();
      }
    });
  }

  _bindKeyboard() {
    window.addEventListener('keydown', this._boundKeyDown);
    window.addEventListener('keyup', this._boundKeyUp);
    document.addEventListener('visibilitychange', () => {
      this.lastFrame = performance.now();
      if (document.hidden) {
        this.demoPressed = false;
        this.keyboardPressed = false;
      }
    });
  }

  _onPointerMove(event) {
    this.pointer.clientX = event.clientX;
    this.pointer.clientY = event.clientY;
    this.pointer.nx = (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    this.pointer.ny = 1 - (event.clientY / Math.max(1, window.innerHeight)) * 2;
    this.pointer.moved = true;
  }

  _onPointerDown(event) {
    if (this.mode !== 'demo') return;
    if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') {
      return;
    }
    if (this._isInteractiveTarget(event.target)) return;
    event.preventDefault();
    this.demoPressed = true;
    this.el.app.classList.add('is-holding');
  }

  _onPointerUp(event) {
    if (event?.type === 'blur' || event?.type === 'pointercancel') {
      this.demoPressed = false;
      this.keyboardPressed = false;
    } else {
      this.demoPressed = false;
    }
    this.el.app.classList.remove('is-holding');
  }

  _onKeyDown(event) {
    const target = event.target;
    const isFormField =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (isFormField) return;

    if (event.key === 'Escape') {
      if (this.settingsOpen) {
        this._setSettingsOpen(false);
        return;
      }
      if (this.el.errorDialog.open) {
        this._closeErrorDialog();
        return;
      }
    }

    if (event.key === ' ' && this.mode === 'demo') {
      event.preventDefault();
      this.keyboardPressed = true;
      this.el.app.classList.add('is-holding');
    }

    if ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey) {
      this._resetView();
    }
  }

  _onKeyUp(event) {
    if (event.key === ' ') {
      this.keyboardPressed = false;
      if (!this.demoPressed) this.el.app.classList.remove('is-holding');
    }
  }

  _isInteractiveTarget(target) {
    return Boolean(
      target?.closest?.(
        'button, a, input, textarea, select, summary, .settings-panel, .error-dialog, .loading-overlay, .topbar, .intro-inner',
      ),
    );
  }

  _resetView() {
    if (!this.flower) return;
    this.smoother.reset(this.mode === 'demo' ? 0.12 : 0.16);
    this.tension = this.smoother.value;
    this.flower.setPointerNdc(this.pointer.nx, this.pointer.ny, 0);
    this.flower.anchorTarget.set(
      this.mode === 'intro' ? this._getIntroAnchor().x : 0,
      this.mode === 'intro' ? this._getIntroAnchor().y : 0.03,
    );
    this._showToast('视角已重置');
  }

  _showToast(message, duration = 3000) {
    window.clearTimeout(this.toastTimer);
    this.el.toast.textContent = message;
    this.el.toast.hidden = false;
    // 重启入场动画
    this.el.toast.style.animation = 'none';
    void this.el.toast.offsetHeight;
    this.el.toast.style.animation = '';
    this.toastTimer = window.setTimeout(() => {
      this.el.toast.hidden = true;
    }, duration);
  }

  async _stopCameraSession() {
    const tracker = this.handTracker;
    this.handTracker = null;
    this.cameraActive = false;
    this.handPresent = false;
    this.handReport = null;
    this.lastHandSeenAt = 0;
    this.el.stopCameraBtn.hidden = true;
    if (tracker) {
      try {
        await tracker.stop();
      } catch (error) {
        console.warn('[bloom] tracker stop:', error);
      }
    }
    this._clearOverlayCanvases();
    this._setTrackingStatus('idle', '等待手部');
  }

  async startCamera() {
    if (this.starting) return;
    if (!this.flower) {
      this._showErrorDialog({
        code: 'webgl',
        message: '粒子渲染器没有初始化成功。请刷新页面并确认浏览器开启了 WebGL2。',
      });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this._showErrorDialog(
        new HandTrackerError('unsupported', '当前浏览器不支持摄像头访问。'),
      );
      return;
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
      this._showErrorDialog(
        new HandTrackerError(
          'insecure-context',
          '摄像头只能在 HTTPS 或 localhost 的 HTTP 服务中使用。',
        ),
      );
      return;
    }

    this.starting = true;
    this._closeErrorDialog();
    this._setSettingsOpen(false);
    const token = ++this.loadingToken;
    this._setMode('loading');
    this.el.startBtn.disabled = true;
    this.el.loadingOverlay.hidden = false;
    this._setLoadingMessage('正在请求摄像头权限…');
    this.el.loadingOverlay.setAttribute('aria-busy', 'true');

    await this._stopCameraSession();

    if (token !== this.loadingToken) {
      this.starting = false;
      this.el.startBtn.disabled = false;
      return;
    }

    const tracker = new HandTracker({
      onHands: () => {},
      onFatalError: (error) => this._handleCameraFatal(error),
      onStatus: (message) => {
        if (token !== this.loadingToken) return;
        if (message === 'vision') return;
        this._setLoadingMessage(message);
      },
    });
    this.handTracker = tracker;

    try {
      await tracker.start();
      if (token !== this.loadingToken) {
        await tracker.stop();
        return;
      }
      this.cameraActive = true;
      this.smoother.reset(CONFIG.tension.restValue);
      this.tension = this.smoother.value;
      this._hideLoading();
      this._showCameraUi();
      this._showToast('把手放进画面，握拳收拢，张开手掌绽放', 3600);
    } catch (error) {
      if (token !== this.loadingToken || error?.code === 'cancelled') {
        if (this.handTracker === tracker) {
          await tracker.stop();
          this.handTracker = null;
        }
        return;
      }
      await tracker.stop();
      if (this.handTracker === tracker) this.handTracker = null;
      this.cameraActive = false;
      this._hideLoading();
      this._showIntro({ immediate: false, resetFlower: true });
      this._showErrorDialog(error);
    } finally {
      this.starting = false;
      if (token === this.loadingToken) {
        this.el.startBtn.disabled = false;
        this.el.loadingOverlay.removeAttribute('aria-busy');
      }
    }
  }

  async _cancelCameraStart() {
    this.loadingToken += 1;
    this._hideLoading();
    this._showIntro({ immediate: false, resetFlower: true });
    const tracker = this.handTracker;
    this.handTracker = null;
    this.cameraActive = false;
    this.starting = false;
    this.el.startBtn.disabled = false;
    if (tracker) {
      try {
        await tracker.stop();
      } catch {
        // noop
      }
    }
    this._clearOverlayCanvases();
    this._showToast('已取消摄像头启动');
  }

  _showCameraUi() {
    this._setMode('camera');
    this.el.introScreen.classList.add('is-hidden');
    this.el.introScreen.setAttribute('aria-hidden', 'true');
    this.el.introScreen.inert = true;
    this.el.activeUi.hidden = false;
    this.el.trackingChip.hidden = false;
    this.el.startCameraBtn.hidden = true;
    this.el.stopCameraBtn.hidden = false;
    this.el.hudKicker.textContent = 'CAMERA / HAND TRACKING';
    this.el.hudHint.textContent = '把手放进画面，握拳收拢，张开手掌，让花醒来。';
    this._setTrackingStatus('searching', '寻找手部');
    this._lastHud = { percent: -1, state: '', hint: '' };
  }

  async _handleCameraFatal(error) {
    if (this.fatalHandling) return;
    if (this.mode !== 'camera') return;
    this.fatalHandling = true;
    try {
      this.loadingToken += 1;
      await this._stopCameraSession();
      this._showIntro({ immediate: false, resetFlower: true });
      this._showErrorDialog(error);
    } finally {
      this.fatalHandling = false;
    }
  }

  async stopCameraAndReturn() {
    if (!this.cameraActive && !this.handTracker) return;
    this.loadingToken += 1;
    this._hideLoading();
    await this._stopCameraSession();
    this._showIntro({ immediate: false, resetFlower: true });
    this._showToast('摄像头已关闭');
  }

  enterDemo() {
    if (!this.flower) {
      this._showErrorDialog({
        code: 'webgl',
        message: '粒子渲染器没有初始化成功。请刷新页面并确认浏览器开启了 WebGL2。',
      });
      return;
    }
    this.loadingToken += 1;
    const tracker = this.handTracker;
    this.handTracker = null;
    this.cameraActive = false;
    if (tracker) tracker.stop();
    this._hideLoading();
    this._closeErrorDialog();
    this._setSettingsOpen(false);
    this._clearOverlayCanvases();

    this.demoPressed = false;
    this.keyboardPressed = false;
    this.pointer.nx = 0;
    this.pointer.ny = 0;
    this.smoother.reset(0.13);
    this.tension = this.smoother.value;
    this.handPresent = false;
    this.handReport = null;

    this._setMode('demo');
    this.el.introScreen.classList.add('is-hidden');
    this.el.introScreen.setAttribute('aria-hidden', 'true');
    this.el.introScreen.inert = true;
    this.el.activeUi.hidden = false;
    this.el.trackingChip.hidden = false;
    this.el.startCameraBtn.hidden = false;
    this.el.stopCameraBtn.hidden = true;
    this.el.stopCameraBtn.disabled = false;
    this.el.startBtn.disabled = false;
    this.el.hudKicker.textContent = 'MOUSE / DEMO MODE';
    this.el.hudHint.textContent = '按住画面或空格键，让花随指尖绽放；松开手，花瓣慢慢收拢。';
    this._setTrackingStatus('demo', '鼠标互动');
    this.el.handCanvas.classList.add('is-idle');
    this._lastHud = { percent: -1, state: '', hint: '' };
    this.el.app.classList.remove('is-holding');
    this._showToast('按住画面，花朵会跟随指尖绽放', 3000);
  }

  _showIntro({ immediate = false, resetFlower = false } = {}) {
    this._setMode('intro');
    this.el.introScreen.classList.remove('is-hidden');
    this.el.introScreen.setAttribute('aria-hidden', 'false');
    this.el.introScreen.inert = false;
    this.el.activeUi.hidden = true;
    this.el.trackingChip.hidden = true;
    this.el.trackingChip.dataset.status = 'idle';
    this.el.startCameraBtn.hidden = true;
    this.el.stopCameraBtn.hidden = true;
    this.el.loadingOverlay.hidden = true;
    if (immediate) this.el.introScreen.style.transition = 'none';
    if (immediate) {
      requestAnimationFrame(() => {
        this.el.introScreen.style.transition = '';
      });
    }
    if (resetFlower) {
      this.demoPressed = false;
      this.keyboardPressed = false;
      this.smoother.reset(0.16);
      this.tension = this.smoother.value;
      this.flower?.setPointerNdc(0, 0, 0);
      const anchor = this._getIntroAnchor();
      this.flower?.setAnchorNdc(anchor.x, anchor.y);
    }
    this._setSettingsOpen(false);
    this._updateHud(true);
  }

  _setMode(mode) {
    this.mode = mode;
    this.el.app.dataset.mode = mode;
    if (mode === 'demo' || mode === 'camera') {
      this.el.handCanvas.classList.remove('is-idle');
    }
  }

  _showLoading(message = '正在请求摄像头权限…') {
    this.el.loadingOverlay.hidden = false;
    this._setLoadingMessage(message);
    this.el.loadingOverlay.setAttribute('aria-busy', 'true');
  }

  _hideLoading() {
    this.el.loadingOverlay.hidden = true;
    this.el.loadingOverlay.removeAttribute('aria-busy');
  }

  _setLoadingMessage(message) {
    if (!message) return;
    this.el.loadingMessage.textContent = message;
  }

  _showErrorDialog(error) {
    const copy = getCameraErrorCopy(error);
    this.currentErrorCode = error?.code || '';
    this.el.errorTitle.textContent = copy.title;
    this.el.errorMessage.textContent = copy.message;
    this.el.errorTips.replaceChildren();
    for (const tip of copy.tips) {
      const li = document.createElement('li');
      li.textContent = tip;
      this.el.errorTips.appendChild(li);
    }
    const retryLabel = this.el.retryCameraBtn.querySelector('strong');
    if (retryLabel) {
      retryLabel.textContent = this.currentErrorCode === 'webgl' ? '刷新页面' : '重新尝试';
    }
    this.el.errorDemoBtn.hidden = this.currentErrorCode === 'webgl';
    this._setSettingsOpen(false);
    this._setMode('intro');
    this.el.introScreen.classList.remove('is-hidden');
    this.el.introScreen.setAttribute('aria-hidden', 'false');
    this.el.introScreen.inert = false;
    this.el.activeUi.hidden = true;
    this.el.loadingOverlay.hidden = true;
    this.el.startBtn.disabled = false;
    this.el.trackingChip.hidden = true;
    this.el.startCameraBtn.hidden = true;
    this.el.stopCameraBtn.hidden = true;

    if (!this.el.errorDialog.open) {
      if (typeof this.el.errorDialog.showModal === 'function') {
        this.el.errorDialog.showModal();
      } else {
        this.el.errorDialog.setAttribute('open', '');
      }
    }
    window.setTimeout(() => this.el.retryCameraBtn.focus({ preventScroll: true }), 80);
  }

  _closeErrorDialog() {
    const dialog = this.el.errorDialog;
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    if (!this.cameraActive && this.mode !== 'demo') {
      this._setMode('intro');
    }
  }

  _getIntroAnchor() {
    const { width, height } = this.viewport;
    const portrait = width <= 820 || height > width * 1.1;
    if (portrait) return { x: 0, y: 0.29 };
    if (width < 1120) return { x: 0.21, y: 0.02 };
    return { x: 0.3, y: 0.03 };
  }

  _setTrackingStatus(status, text) {
    if (this.el.trackingChip.dataset.status === status && this.el.trackingText.textContent === text) {
      return;
    }
    this.el.trackingChip.dataset.status = status;
    this.el.trackingText.textContent = text;
  }

  _attractTension() {
    if (this.reducedMotion) {
      return 0.42 + Math.sin(this.elapsed * 0.24) * 0.05;
    }
    const carrier = 0.5 - 0.5 * Math.cos(this.elapsed * 0.47 + 2.36);
    return 0.12 + 0.78 * smoothstep(0.08, 0.76, carrier);
  }

  _resolveFlowerInput(dt, now) {
    if (!this.flower) return;
    const layout = { anchorX: 0, anchorY: 0.03, pointerStrength: 0 };
    let targetTension = this.smoother.value;
    const { nx, ny } = this.pointer;

    if (this.mode === 'camera' && this.cameraActive) {
      const hand = this.handTracker?.getHand(520);
      const hasHand = Boolean(hand?.landmarks && isPlausibleHand(hand.landmarks));
      this.handPresent = hasHand;

      if (hasHand) {
        const metrics = calculateTension(hand.landmarks);
        if (metrics) {
          this.handReport = { ...metrics, handedness: hand.handedness };
          this.lastHandSeenAt = now;
          targetTension = metrics.raw;
          const palm = getPalmCenter(hand.landmarks);
          const palmNdc = this._landmarkToNdc(palm);
          const indexNdc = this._landmarkToNdc(hand.landmarks[8]);
          layout.anchorX = clamp(palmNdc.x * 0.14, -0.18, 0.18);
          layout.anchorY = clamp(0.035 + palmNdc.y * 0.085, -0.11, 0.16);
          layout.pointerStrength = 0.52;
          this.flower.setPointerNdc(indexNdc.x, indexNdc.y, layout.pointerStrength);
        } else {
          targetTension = CONFIG.tension.restValue;
          this.handPresent = false;
        }
      } else {
        this.handReport = null;
        targetTension = CONFIG.tension.restValue;
        layout.anchorX = 0;
        layout.anchorY = 0.03;
        layout.pointerStrength = 0;
        this.flower.setPointerNdc(0, 0, 0);
      }

      this.flower.setAnchorNdc(layout.anchorX, layout.anchorY);
      this.tension = this.smoother.update(targetTension, dt);
      this._updateTrackingStatus();
    } else if (this.mode === 'demo') {
      this.handPresent = false;
      this.handReport = null;
      const pressed = this.demoPressed || this.keyboardPressed;
      targetTension = this.debugTension ?? (pressed ? 0.97 : 0.13);
      this.tension = this.smoother.update(targetTension, dt);
      layout.anchorX = nx * 0.095;
      layout.anchorY = 0.02 + ny * 0.05;
      this.flower.setAnchorNdc(layout.anchorX, layout.anchorY);
      this.flower.setPointerNdc(nx, ny, pressed ? 0.72 : 0.1);
      this._updateTrackingStatus();
    } else {
      // intro / loading：自动演示一次呼吸般的开合，鼠标靠近时还有轻微涟漪。
      this.handPresent = false;
      this.handReport = null;
      const attract = this.reducedMotion ? 0.45 : this._attractTension();
      this.tension = this.smoother.update(attract, dt);
      const anchor = this._getIntroAnchor();
      layout.pointerStrength = this.pointer.moved && this.mode === 'intro' ? 0.14 : 0;
      this.flower.setAnchorNdc(
        anchor.x + (this.pointer.moved ? nx * 0.016 : 0),
        anchor.y + (this.pointer.moved ? ny * 0.012 : 0),
      );
      this.flower.setPointerNdc(nx, ny, layout.pointerStrength);
    }

    if (this.debugTension !== null && this.mode !== 'camera') {
      this.tension = clamp01(this.debugTension);
      this.smoother.reset(this.tension);
    }

    const targetBloom = bloomTargetFromTension(this.tension);
    this.flower.setTargetBloom(targetBloom);
  }

  _updateTrackingStatus() {
    if (this.mode !== 'camera' || !this.cameraActive) {
      if (this.mode === 'demo') this._setTrackingStatus('demo', '鼠标互动');
      return;
    }
    if (this.handPresent) {
      this._setTrackingStatus('tracking', '手部已锁定');
      if (this.el.hudHint.textContent !== '张开手掌，花会盛开；握拳，花苞会重新收拢。') {
        this.el.hudHint.textContent = '张开手掌，花会盛开；握拳，花苞会重新收拢。';
      }
    } else {
      this._setTrackingStatus('searching', '寻找手部');
      if (this.el.hudHint.textContent !== '把手放进画面中央，保持光线充足。') {
        this.el.hudHint.textContent = '把手放进画面中央，保持光线充足。';
      }
    }
  }

  _updateHud(force = false) {
    const percent = Math.round(clamp01(this.tension) * 100);
    if (force || percent !== this._lastHud.percent) {
      this.el.tensionValue.textContent = String(percent).padStart(2, '0');
      this.el.tensionFill.style.width = `${percent}%`;
      this.el.tensionKnob.style.left = `${percent}%`;
      this.el.tensionTrack.setAttribute('aria-valuenow', String(percent));
      this._lastHud.percent = percent;
    }
    const state = tensionState(this.tension);
    if (force || state !== this._lastHud.state) {
      const labels = {
        closed: '含苞',
        opening: '舒展',
        open: '盛开',
      };
      this.el.flowerState.dataset.state = state;
      this.el.app.dataset.flowerState = state;
      this.el.bloomStateText.textContent = labels[state];
      this._lastHud.state = state;
    }
  }

  _landmarkToNdc(point) {
    if (!point) return { x: 0, y: 0 };
    const video = this.handTracker?.videoElement;
    const width = this.viewport.width;
    const height = this.viewport.height;
    if (!video || !video.videoWidth || !video.videoHeight) {
      return { x: point.x * 2 - 1, y: 1 - point.y * 2 };
    }
    const rect = this._getCoverRect(video.videoWidth, video.videoHeight, width, height);
    const px = rect.x + (1 - point.x) * rect.width;
    const py = rect.y + point.y * rect.height;
    return {
      x: (px / width) * 2 - 1,
      y: 1 - (py / height) * 2,
    };
  }

  _getCoverRect(videoWidth, videoHeight, width, height) {
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const drawWidth = videoWidth * scale;
    const drawHeight = videoHeight * scale;
    return {
      x: (width - drawWidth) / 2,
      y: (height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
      scale,
    };
  }

  _landmarkToScreen(point) {
    const video = this.handTracker?.videoElement;
    if (!video || !video.videoWidth) return null;
    const rect = this._getCoverRect(
      video.videoWidth,
      video.videoHeight,
      this.viewport.width,
      this.viewport.height,
    );
    return {
      x: rect.x + (1 - point.x) * rect.width,
      y: rect.y + point.y * rect.height,
    };
  }

  _clearHandOverlay() {
    const ctx = this.handCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  _drawCamera(now) {
    if (!this.cameraActive || !this.backdropEnabled) return;
    const video = this.handTracker?.videoElement;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    if (now - this.lastCameraDraw < 1000 / 30) return;
    this.lastCameraDraw = now;

    const ctx = this.cameraCtx;
    const dpr = this.overlayDpr;
    const width = this.viewport.width;
    const height = this.viewport.height;
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rect = this._getCoverRect(video.videoWidth, video.videoHeight, width, height);
    this.cameraRect = rect;
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  _drawHandSkeleton(now) {
    if (!this.skeletonEnabled || !this.cameraActive) return;
    const hand = this.handTracker?.getHand(520);
    if (!hand || !isPlausibleHand(hand.landmarks)) {
      this._clearHandOverlay();
      return;
    }
    if (now - this.lastSkeletonDraw < 1000 / 32) return;
    this.lastSkeletonDraw = now;

    const ctx = this.handCtx;
    if (!ctx) return;
    const dpr = this.overlayDpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const points = hand.landmarks.map((point) => this._landmarkToScreen(point));
    if (points.some((point) => !point)) return;

    const tension = this.tension;
    const lineAlpha = 0.23 + tension * 0.17;
    const accent = `rgba(${Math.round(255 - tension * 0)}, ${Math.round(
      199 + tension * 36,
    )}, ${Math.round(170 + tension * 54)}, ${0.62 + tension * 0.2})`;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(255, 168, 132, 0.35)';
    ctx.shadowBlur = 9;

    ctx.strokeStyle = `rgba(255, 226, 202, ${lineAlpha})`;
    ctx.lineWidth = 0.8;
    for (const [from, to] of [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [17, 18], [18, 19], [19, 20],
      [0, 17],
    ]) {
      ctx.beginPath();
      ctx.moveTo(points[from].x, points[from].y);
      ctx.lineTo(points[to].x, points[to].y);
      ctx.stroke();
    }

    for (const index of HAND_PALM_IDS) {
      ctx.beginPath();
      ctx.arc(points[index].x, points[index].y, index === 0 ? 2.1 : 1.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 236, 218, 0.45)';
      ctx.fill();
    }

    for (const index of [4, 8, 12, 16, 20]) {
      const point = points[index];
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2.3, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    const indexTip = points[8];
    const pulse = 7.5 + tension * 7 + Math.sin(now * 0.0045) * 1.2;
    ctx.strokeStyle = `rgba(255, 212, 173, ${0.38 + tension * 0.28})`;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.arc(indexTip.x, indexTip.y, pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(indexTip.x, indexTip.y, pulse + 4.5, -Math.PI * 0.68, -Math.PI * 0.2);
    ctx.strokeStyle = `rgba(255, 184, 173, ${0.22 + tension * 0.26})`;
    ctx.stroke();

    // 掌心的小十字，让追踪像一层安静的测量图层。
    const palmX = points[9].x;
    const palmY = points[9].y;
    ctx.strokeStyle = 'rgba(255, 233, 212, 0.2)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(palmX - 4, palmY);
    ctx.lineTo(palmX + 4, palmY);
    ctx.moveTo(palmX, palmY - 4);
    ctx.lineTo(palmX, palmY + 4);
    ctx.stroke();
    ctx.restore();
  }

  _loop(now) {
    const rawDt = (now - this.lastFrame) / 1000;
    const dt = clamp(Number.isFinite(rawDt) ? rawDt : 0.016, 0, 0.06);
    this.lastFrame = now;

    if (document.hidden) {
      requestAnimationFrame(this._boundLoop);
      return;
    }

    this.elapsed += dt;
    this._resolveFlowerInput(dt, now);
    this.flower?.update(dt, this.elapsed);

    this._drawCamera(now);
    this._drawHandSkeleton(now);
    this._updateHud();
    this._updateFps(dt);

    requestAnimationFrame(this._boundLoop);
  }

  _updateFps(dt) {
    this.fpsFrames += 1;
    this.fpsAccumulator += dt;
    if (this.fpsAccumulator >= 0.8) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccumulator);
      this.fpsFrames = 0;
      this.fpsAccumulator = 0;
      if (this.settingsOpen) {
        this.el.fpsReadout.textContent = `${this.fps} FPS · ${numberFormatter.format(
          this.flower?.particleCount || 0,
        )} PARTICLES`;
      }
    }
  }

  debugSetTension(value) {
    const next = clamp01(Number(value));
    this.debugTension = Number.isFinite(next) ? next : null;
    if (this.debugTension !== null) {
      this.smoother.reset(this.debugTension);
      this.tension = this.debugTension;
    }
    return this.getState();
  }

  clearDebugTension() {
    this.debugTension = null;
  }

  getState() {
    return {
      mode: this.mode,
      particleCount: this.flower?.particleCount ?? 0,
      tension: this.tension,
      targetBloom: this.flower?.targetSpread ?? 0,
      currentSpread: this.flower?.currentSpread ?? 0,
      handPresent: this.handPresent,
      cameraActive: this.cameraActive,
      state: tensionState(this.tension),
      particleMin: CONFIG.particles.min,
      particleMax: CONFIG.particles.max,
    };
  }
}

function bootstrap() {
  const app = new BloomApp();
  app.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
