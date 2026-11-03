import { CONFIG } from './config.js';

const HANDS_SCRIPT_URL = new URL(
  '../vendor/mediapipe/hands/hands.js',
  import.meta.url,
).href;
const HANDS_ASSET_BASE = new URL('../vendor/mediapipe/hands/', import.meta.url).href;

export class HandTrackerError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'HandTrackerError';
    this.code = code;
    this.cause = cause;
  }
}

function loadHandsScript() {
  if (window.Hands) return Promise.resolve();

  const existing = document.querySelector('script[data-hands-loader]');
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener(
        'error',
        () => reject(new HandTrackerError('engine-load', '手势识别引擎脚本加载失败')),
        { once: true },
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HANDS_SCRIPT_URL;
    script.async = true;
    script.dataset.handsLoader = 'true';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener(
      'error',
      () => {
        script.remove();
        reject(
          new HandTrackerError(
            'engine-load',
            '手势识别引擎加载失败，请确认 vendor/mediapipe 完整，并通过 HTTP 服务打开页面。',
          ),
        );
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
}

function waitForVideoReady(video) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new HandTrackerError('camera-timeout', '摄像头画面初始化超时'));
    }, 12000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('canplay', onReady, { once: true });
  });
}

function withTimeout(promise, ms, message) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = window.setTimeout(
        () => reject(new HandTrackerError('engine-timeout', message)),
        ms,
      );
    }),
  ]).finally(() => window.clearTimeout(timer));
}

/**
 * 摄像头 + MediaPipe Hands 封装。
 * 只保留最近一只手的 21 个关键点，并在坐标层做一次轻量平滑。
 */
export class HandTracker {
  constructor({ onHands, onFatalError, onStatus } = {}) {
    this.onHands = onHands;
    this.onFatalError = onFatalError;
    this.onStatus = onStatus;
    this.active = false;
    this.hands = null;
    this.stream = null;
    this.video = null;
    this.raf = 0;
    this.detecting = false;
    this.lastSendAt = 0;
    this.smoothedLandmarks = null;
    this.lastHandSeenAt = 0;
    this.lastEmptyAt = 0;
    this.lastResultsAt = 0;
    this.handedness = '';
    this._stopRequested = false;
    this._fatalReported = false;
  }

  get isActive() {
    return this.active;
  }

  get videoElement() {
    return this.video;
  }

  _status(message) {
    this.onStatus?.(message);
  }

  async start() {
    this._stopRequested = false;
    this._fatalReported = false;

    if (!window.isSecureContext && !this._isLocalHost()) {
      throw new HandTrackerError(
        'insecure-context',
        '摄像头只能在 HTTPS 或 localhost 的 HTTP 服务中使用。',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new HandTrackerError(
        'unsupported',
        '当前浏览器不支持摄像头访问，请使用最新版 Chrome / Edge / Safari。',
      );
    }

    this._status('正在载入手势识别引擎…');
    await loadHandsScript();

    if (this._stopRequested) throw new HandTrackerError('cancelled', '已取消');
    if (!window.Hands) {
      throw new HandTrackerError('engine-load', '手势识别引擎初始化失败。');
    }

    this._status('正在等待摄像头权限…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: CONFIG.camera.width },
          height: { ideal: CONFIG.camera.height },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch (error) {
      throw new HandTrackerError('get-user-media', this._cameraErrorMessage(error), error);
    }

    if (this._stopRequested) {
      this._stopStream();
      throw new HandTrackerError('cancelled', '已取消');
    }

    this._createVideoElement();
    this.video.srcObject = this.stream;
    this.stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (this.active && !this._stopRequested) {
          this._reportFatal(
            new HandTrackerError('camera-lost', '摄像头连接已中断，请检查设备后重试。'),
          );
        }
      });
    });

    try {
      await this.video.play();
      await waitForVideoReady(this.video);
    } catch (error) {
      if (error instanceof HandTrackerError) throw error;
      throw new HandTrackerError('camera-timeout', '无法播放摄像头画面。', error);
    }

    if (this._stopRequested) throw new HandTrackerError('cancelled', '已取消');

    this._status('正在准备手部模型…');
    this.hands = new window.Hands({
      locateFile: (file) => `${HANDS_ASSET_BASE}${file}`,
    });
    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: window.innerWidth < 720 ? 0 : 1,
      minDetectionConfidence: CONFIG.camera.detectionConfidence,
      minTrackingConfidence: CONFIG.camera.trackingConfidence,
      selfieMode: false,
    });
    this.hands.onResults((results) => this._handleResults(results));

    // 第一次 send 会初始化 wasm + 模型；等它完成后再切 UI，避免出现假就绪。
    try {
      await withTimeout(
        this.hands.send({ image: this.video }),
        26000,
        '手势识别引擎加载超时，请检查本地服务是否支持 .wasm / .data 文件。',
      );
    } catch (error) {
      if (error instanceof HandTrackerError) throw error;
      throw new HandTrackerError(
        'engine-init',
        '手势识别引擎启动失败。请确认使用 HTTP 服务，并检查浏览器控制台。',
        error,
      );
    }

    if (this._stopRequested) throw new HandTrackerError('cancelled', '已取消');

    this.active = true;
    this._status('vision');
    this._startDetectionLoop();
    return true;
  }

  _createVideoElement() {
    if (this.video) return;
    const video = document.createElement('video');
    video.className = 'input-video';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    document.body.appendChild(video);
    this.video = video;
  }

  _cameraErrorMessage(error) {
    switch (error?.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return '摄像头权限被拒绝。请在浏览器地址栏左侧重新允许摄像头，然后重试。';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '没有找到可用的摄像头设备。请连接摄像头后重试。';
      case 'NotReadableError':
      case 'TrackStartError':
        return '摄像头正被其他应用占用，或硬件暂时无法读取。关闭占用摄像头的程序后再试。';
      case 'OverconstrainedError':
        return '摄像头不支持所需的分辨率，请尝试更换设备或浏览器。';
      case 'AbortError':
        return '摄像头启动被中断，请重试。';
      case 'SecurityError':
        return '浏览器安全策略阻止了摄像头访问，请使用 localhost 或 HTTPS 打开页面。';
      default:
        return '无法访问摄像头。请检查权限、设备连接和本地 HTTP 服务后重试。';
    }
  }

  _handleResults(results) {
    const now = performance.now();
    this.lastResultsAt = now;
    const raw = results?.multiHandLandmarks?.[0] || null;

    if (!raw) {
      this.lastEmptyAt = now;
      return;
    }

    this.handedness =
      results.multiHandedness?.[0]?.label || results.multiHandedness?.[0]?.classification?.[0]?.label || '';

    // 丢失后重新出现时，不让旧手的位置拖慢追踪。
    const wasLost = now - this.lastHandSeenAt > 500 || !this.smoothedLandmarks;
    if (wasLost) {
      this.smoothedLandmarks = raw.map((point) => ({ x: point.x, y: point.y, z: point.z ?? 0 }));
    } else {
      const dt = Math.min(0.06, Math.max(0.012, (now - this.lastHandSeenAt) / 1000));
      const alpha = 1 - Math.exp(-dt / 0.035);
      const previous = this.smoothedLandmarks;
      for (let i = 0; i < raw.length; i += 1) {
        previous[i].x += (raw[i].x - previous[i].x) * alpha;
        previous[i].y += (raw[i].y - previous[i].y) * alpha;
        previous[i].z += ((raw[i].z ?? 0) - previous[i].z) * alpha;
      }
    }

    this.lastHandSeenAt = now;
    this.onHands?.(this.getHand(420));
  }

  /**
   * 返回一手新鲜数据。超过 maxAgeMs 没收到检测结果则视为丢失。
   * landmarks 已做轻量低通平滑。
   */
  getHand(maxAgeMs = 420) {
    if (!this.smoothedLandmarks) return null;
    if (performance.now() - this.lastHandSeenAt > maxAgeMs) return null;
    return {
      landmarks: this.smoothedLandmarks,
      handedness: this.handedness,
      seenAt: this.lastHandSeenAt,
      ageMs: performance.now() - this.lastHandSeenAt,
    };
  }

  getVideoFrameState() {
    if (!this.video || !this.stream) return null;
    return {
      video: this.video,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      readyState: this.video.readyState,
    };
  }

  _startDetectionLoop() {
    const tick = async () => {
      if (!this.active) return;
      this.raf = requestAnimationFrame(tick);

      const now = performance.now();
      if (
        this.detecting ||
        now - this.lastSendAt < 1000 / CONFIG.camera.fps ||
        !this.video ||
        this.video.readyState < 2
      ) {
        return;
      }

      this.detecting = true;
      this.lastSendAt = now;
      try {
        await this.hands.send({ image: this.video });
      } catch (error) {
        if (this.active && !this._stopRequested) {
          this._reportFatal(
            new HandTrackerError(
              'detection-loop',
              '手势识别进程意外停止，请重新开启摄像头。',
              error,
            ),
          );
        }
      } finally {
        this.detecting = false;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  _reportFatal(error) {
    if (this._fatalReported || this._stopRequested) return;
    this._fatalReported = true;
    this.onFatalError?.(error);
  }

  async stop() {
    this._stopRequested = true;
    this.active = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this._stopStream();
    if (this.video) {
      this.video.pause?.();
      this.video.srcObject = null;
    }
    const hands = this.hands;
    this.hands = null;
    if (hands) {
      try {
        await hands.close();
      } catch {
        // MediaPipe close 在部分 Safari 上会抛异常，忽略即可。
      }
    }
    this.smoothedLandmarks = null;
    this.lastHandSeenAt = 0;
    this.lastEmptyAt = 0;
    this.handedness = '';
    this.detecting = false;
  }

  _stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // noop
        }
      });
      this.stream = null;
    }
  }

  _isLocalHost() {
    return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  }
}
