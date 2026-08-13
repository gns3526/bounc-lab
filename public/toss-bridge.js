const root = document.documentElement;
const isTossMiniapp = root.classList.contains('toss-miniapp');
const appName =
  document.querySelector('meta[name="toss-app-name"]')?.getAttribute('content')?.trim() ||
  'penguin-bounce';
const rawInterstitialAdGroupId =
  document
    .querySelector('meta[name="toss-interstitial-ad-group-id"]')
    ?.getAttribute('content')
    ?.trim() || '';
const interstitialAdGroupId = /^%VITE_[A-Z0-9_]+%$/.test(rawInterstitialAdGroupId)
  ? ''
  : rawInterstitialAdGroupId;

const SAFE_AREA_EVENT = 'bounc:toss-safe-area';
const BACK_EVENT = 'bounc:toss-back';
const READY_EVENT = 'bounc:toss-ready';
const ERROR_EVENT = 'bounc:toss-error';
const INTERSTITIAL_TIMEOUT_MS = 90_000;

let safeArea = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
let identity = Object.freeze({ userHash: '', profileName: '' });
let interstitialLoaded = false;
let interstitialLoadPromise = null;
let interstitialShowPromise = null;
let bridgeDisposed = false;
const activeInterstitialCancels = new Set();

function normalizeInset(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function applySafeArea(insets = {}) {
  safeArea = Object.freeze({
    top: normalizeInset(insets.top),
    right: normalizeInset(insets.right),
    bottom: normalizeInset(insets.bottom),
    left: normalizeInset(insets.left),
  });

  root.style.setProperty('--toss-safe-top', `${safeArea.top}px`);
  root.style.setProperty('--toss-safe-right', `${safeArea.right}px`);
  root.style.setProperty('--toss-safe-bottom', `${safeArea.bottom}px`);
  root.style.setProperty('--toss-safe-left', `${safeArea.left}px`);
  window.dispatchEvent(new CustomEvent(SAFE_AREA_EVENT, { detail: safeArea }));
}

function subscribeWindowEvent(eventName, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function');
  }
  const handler = (event) => listener(event.detail);
  window.addEventListener(eventName, handler);
  return () => window.removeEventListener(eventName, handler);
}

async function initializeTossSdk() {
  // Keep this import inside the Toss-only branch. Opening toss-bridge.js from the
  // raw localhost server must never try to resolve or initialize the native SDK.
  const {
    Game,
    SafeArea,
    Screen,
    Share,
    User,
    graniteEvent,
    loadFullScreenAd,
    showFullScreenAd,
  } = await import(
    '@apps-in-toss/web-framework'
  );

  const cleanups = [];

  try {
    applySafeArea(SafeArea.get());
    cleanups.push(
      SafeArea.subscribe({
        onEvent: applySafeArea,
      }),
    );
  } catch (error) {
    console.warn('[BOUNC Toss] Safe Area initialization failed.', error);
  }

  cleanups.push(
    graniteEvent.addEventListener('backEvent', {
      onEvent: () => window.dispatchEvent(new CustomEvent(BACK_EVENT)),
      onError: (error) =>
        window.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail: error })),
    }),
  );

  const [keyResult, profileResult] = await Promise.allSettled([
    typeof User.getAnonymousKey.isSupported !== 'function' || User.getAnonymousKey.isSupported()
      ? User.getAnonymousKey()
      : undefined,
    typeof Game.getUserProfile.isSupported !== 'function' || Game.getUserProfile.isSupported()
      ? Game.getUserProfile()
      : undefined,
  ]);

  if (keyResult.status === 'rejected') {
    console.warn('[BOUNC Toss] Anonymous user key is unavailable.', keyResult.reason);
  }
  if (profileResult.status === 'rejected') {
    console.warn('[BOUNC Toss] Game profile is unavailable.', profileResult.reason);
  }

  const key = keyResult.status === 'fulfilled' ? keyResult.value : undefined;
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : undefined;
  identity = Object.freeze({
    userHash: typeof key?.hash === 'string' ? key.hash : '',
    profileName:
      profile?.statusCode === 'SUCCESS' && typeof profile.nickname === 'string'
        ? profile.nickname
        : '',
  });

  const sdk = {
    Game,
    Screen,
    Share,
    User,
    identity,
    loadFullScreenAd,
    showFullScreenAd,
  };
  window.addEventListener(
    'pagehide',
    () => {
      bridgeDisposed = true;
      for (const cancel of [...activeInterstitialCancels]) cancel();
      for (const cleanup of cleanups.splice(0)) cleanup?.();
    },
    { once: true },
  );

  return sdk;
}

const sdkPromise = isTossMiniapp ? initializeTossSdk() : null;

// Prevent a rejected SDK initialization from becoming an unhandled rejection;
// individual bridge methods still surface the original failure to their caller.
const ready = isTossMiniapp
  ? sdkPromise.then(
      (sdk) => {
        window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: sdk.identity }));
        return sdk.identity;
      },
      (error) => {
        console.error('[BOUNC Toss] SDK initialization failed.', error);
        window.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail: error }));
        return false;
      },
    )
  : Promise.resolve(false);

function requireSdk() {
  if (!sdkPromise) {
    throw new Error('Apps in Toss SDK is unavailable outside the Toss build.');
  }
  return sdkPromise;
}

async function getAnonymousKey() {
  const { User } = await requireSdk();
  return User.getAnonymousKey();
}

async function getUserProfile() {
  const { Game } = await requireSdk();
  return Game.getUserProfile();
}

async function closeView() {
  const { Screen } = await requireSdk();
  return Screen.close();
}

async function shareMap(mapId, title = 'BOUNC LAB 맵', text = '') {
  const normalizedMapId = String(mapId ?? '').trim();
  if (!normalizedMapId) throw new TypeError('mapId is required');

  const { Share } = await requireSdk();
  const path = `intoss://${appName}?map=${encodeURIComponent(normalizedMapId)}`;
  const link = await Share.createLink({ path });
  const message = [String(title).trim(), String(text).trim(), link].filter(Boolean).join('\n');
  await Share.sendMessage({ message });
  return link;
}

function isSupported(method) {
  if (typeof method !== 'function') return false;
  try {
    return typeof method.isSupported !== 'function' || method.isSupported();
  } catch (_) {
    return false;
  }
}

function preloadInterstitial() {
  if (bridgeDisposed || !isTossMiniapp || !interstitialAdGroupId || interstitialShowPromise) {
    return Promise.resolve(false);
  }
  if (interstitialLoaded) return Promise.resolve(true);
  if (interstitialLoadPromise) return interstitialLoadPromise;

  interstitialLoadPromise = requireSdk()
    .then(({ loadFullScreenAd }) => {
      if (!isSupported(loadFullScreenAd)) return false;

      return new Promise((resolve) => {
        let cleanup;
        let finished = false;
        let timeoutId;
        const finish = (loaded) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutId);
          activeInterstitialCancels.delete(cancel);
          try {
            cleanup?.();
          } catch (_) {}
          interstitialLoaded = loaded;
          resolve(loaded);
        };
        const cancel = () => finish(false);
        activeInterstitialCancels.add(cancel);
        timeoutId = setTimeout(cancel, INTERSTITIAL_TIMEOUT_MS);

        try {
          cleanup = loadFullScreenAd({
            options: { adGroupId: interstitialAdGroupId },
            onEvent: (event) => {
              if (event?.type === 'loaded') finish(true);
            },
            onError: cancel,
          });
          if (finished) cleanup?.();
        } catch (_) {
          cancel();
        }
      });
    })
    .catch(() => false)
    .finally(() => {
      interstitialLoadPromise = null;
    });

  return interstitialLoadPromise;
}

function showInterstitial() {
  if (bridgeDisposed || !isTossMiniapp || !interstitialAdGroupId) return Promise.resolve(false);
  if (interstitialShowPromise) return interstitialShowPromise;
  if (!interstitialLoaded) {
    void preloadInterstitial();
    return Promise.resolve(false);
  }

  interstitialLoaded = false;
  interstitialShowPromise = requireSdk()
    .then(({ showFullScreenAd }) => {
      if (!isSupported(showFullScreenAd)) return false;

      return new Promise((resolve) => {
        let cleanup;
        let finished = false;
        let shown = false;
        let pageWasHidden = false;
        let timeoutId;
        const finish = (result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutId);
          document.removeEventListener('visibilitychange', handleVisibilityChange);
          activeInterstitialCancels.delete(cancel);
          try {
            cleanup?.();
          } catch (_) {}
          resolve(result);
        };
        const handleVisibilityChange = () => {
          if (document.hidden) {
            pageWasHidden = true;
            return;
          }
          // Some older Toss Android versions do not emit `dismissed`. Returning
          // from a native ad after an actual show/impression is an equivalent
          // terminal signal, so the game must be allowed to continue.
          if (pageWasHidden && shown) {
            finish(Object.freeze({ shown: true, outcome: 'returned' }));
          }
        };
        const cancel = () =>
          finish(shown ? Object.freeze({ shown: true, outcome: 'timeout' }) : false);
        activeInterstitialCancels.add(cancel);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        timeoutId = setTimeout(cancel, INTERSTITIAL_TIMEOUT_MS);

        try {
          cleanup = showFullScreenAd({
            options: { adGroupId: interstitialAdGroupId },
            onEvent: (event) => {
              const type = event?.type;
              if (type === 'show' || type === 'impression' || type === 'clicked') shown = true;
              if (type === 'dismissed') {
                finish(Object.freeze({ shown: true, outcome: 'dismissed' }));
              } else if (type === 'failedToShow') {
                finish(false);
              }
            },
            onError: () => finish(false),
          });
          if (finished) cleanup?.();
        } catch (_) {
          finish(false);
        }
      });
    })
    .catch(() => false)
    .finally(() => {
      interstitialShowPromise = null;
      void preloadInterstitial();
    });

  return interstitialShowPromise;
}

const bridge = Object.freeze({
  isTossMiniapp,
  appName,
  ready,
  get identity() {
    return identity;
  },
  User: Object.freeze({ getAnonymousKey }),
  Game: Object.freeze({ getUserProfile }),
  Ads: Object.freeze({ preloadInterstitial, showInterstitial }),
  SafeArea: Object.freeze({
    get: () => safeArea,
    subscribe: (listener) => subscribeWindowEvent(SAFE_AREA_EVENT, listener),
  }),
  getAnonymousKey,
  getUserProfile,
  backEvent: (listener) => subscribeWindowEvent(BACK_EVENT, listener),
  closeView,
  shareMap,
});

Object.defineProperty(window, '__BOUNC_TOSS__', {
  value: bridge,
  configurable: false,
  enumerable: false,
  writable: false,
});
