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
const rawAdFreeSku =
  document.querySelector('meta[name="toss-ad-free-sku"]')?.getAttribute('content')?.trim() || '';
const adFreeSku = /^%VITE_[A-Z0-9_]+%$/.test(rawAdFreeSku) ? '' : rawAdFreeSku;

const SAFE_AREA_EVENT = 'bounc:toss-safe-area';
const BACK_EVENT = 'bounc:toss-back';
const READY_EVENT = 'bounc:toss-ready';
const ERROR_EVENT = 'bounc:toss-error';
const PURCHASE_STATE_EVENT = 'bounc:toss-purchase-state';
const INTERSTITIAL_TIMEOUT_MS = 90_000;
const AD_FREE_STORAGE_KEY = `bounc:ad-free:v1:${adFreeSku}`;

let safeArea = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
let identity = Object.freeze({ userHash: '', profileName: '' });
let purchaseState = Object.freeze({
  status: isTossMiniapp && adFreeSku ? 'checking' : 'unavailable',
  sku: adFreeSku,
  displayAmount: '',
  productType: '',
  productValid: false,
  source: 'startup',
  message: '',
});
let adFreeProduct = null;
let entitlementSyncPromise = null;
let purchasePromise = null;
let interstitialLoaded = false;
let interstitialLoadPromise = null;
let interstitialShowPromise = null;
let bridgeDisposed = false;
const activeInterstitialCancels = new Set();
const activePurchaseCancels = new Set();

if (isTossMiniapp) {
  window.addEventListener('pageshow', (event) => {
    // pagehide permanently disposes native subscriptions. A BFCache restore
    // must create a fresh SDK bridge instead of reviving that disposed page.
    if (event.persisted) window.location.reload();
  });
}

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
    IAP,
    SafeArea,
    Screen,
    Share,
    Storage,
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
    IAP,
    Screen,
    Share,
    Storage,
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
      for (const cancel of [...activePurchaseCancels]) cancel();
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
      async (sdk) => {
        await synchronizeAdFreeEntitlement('startup');
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

function disableInterstitial() {
  interstitialLoaded = false;
  for (const cancel of [...activeInterstitialCancels]) cancel();
}

function isConfirmedAdSupported() {
  return purchaseState.status === 'ad-supported';
}

function setPurchaseState(status, patch = {}) {
  purchaseState = Object.freeze({
    ...purchaseState,
    status,
    sku: adFreeSku,
    message: '',
    ...patch,
  });

  if (status !== 'ad-supported') disableInterstitial();
  if (!bridgeDisposed) {
    window.dispatchEvent(new CustomEvent(PURCHASE_STATE_EVENT, { detail: purchaseState }));
    if (status === 'ad-supported') queueMicrotask(() => void preloadInterstitial());
  }
  return purchaseState;
}

function parseStoredGrant(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const grant = JSON.parse(value);
    if (
      !identity.userHash ||
      grant?.userHash !== identity.userHash ||
      grant?.sku !== adFreeSku ||
      typeof grant?.orderId !== 'string' ||
      !grant.orderId
    ) {
      return null;
    }
    return grant;
  } catch (_) {
    return null;
  }
}

async function writeStoredGrant(Storage, orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId || !identity.userHash) return false;
  try {
    await Storage.setItem(
      AD_FREE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        userHash: identity.userHash,
        sku: adFreeSku,
        orderId: normalizedOrderId,
      }),
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function removeStoredGrant(Storage) {
  try {
    await Storage.removeItem(AD_FREE_STORAGE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

async function processAdFreeProductGrant(Storage, orderId, source = 'purchase') {
  const stored = await writeStoredGrant(Storage, orderId);
  if (!stored) {
    setPurchaseState('error', { source, message: 'storage-write-failed' });
    return false;
  }
  setPurchaseState('ad-free', { source, orderId: String(orderId || '') });
  return true;
}

function newestOrder(orders) {
  return [...orders].sort((left, right) => {
    const leftTime = Date.parse(left?.date || left?.paymentCompletedDate || '') || 0;
    const rightTime = Date.parse(right?.date || right?.paymentCompletedDate || '') || 0;
    return rightTime - leftTime;
  })[0];
}

function latestStatusPerOrder(orders) {
  const latest = new Map();
  for (const order of orders) {
    const orderId = String(order?.orderId || '').trim();
    if (!orderId) continue;
    const existing = latest.get(orderId);
    const orderTime = Date.parse(order?.date || '') || 0;
    const existingTime = Date.parse(existing?.date || '') || 0;
    if (!existing || orderTime >= existingTime) latest.set(orderId, order);
  }
  return [...latest.values()];
}

function purchaseErrorCode(error) {
  return [
    typeof error === 'string' ? error : '',
    error?.code,
    error?.errorCode,
    error?.name,
    error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
    .toUpperCase();
}

function synchronizeAdFreeEntitlement(source = 'restore') {
  if (!isTossMiniapp || !adFreeSku || bridgeDisposed) {
    return Promise.resolve(setPurchaseState('unavailable', { source }));
  }
  if (entitlementSyncPromise) return entitlementSyncPromise;

  setPurchaseState('checking', { source });
  entitlementSyncPromise = requireSdk()
    .then(async ({ IAP, Storage }) => {
      const rawStoredGrant = await Storage.getItem(AD_FREE_STORAGE_KEY);
      const storedGrant = parseStoredGrant(rawStoredGrant);
      if (rawStoredGrant && !storedGrant && !(await removeStoredGrant(Storage))) {
        return setPurchaseState('error', { source, message: 'stale-cache-remove-failed' });
      }
      if (!identity.userHash) {
        return setPurchaseState('unknown', { source, message: 'identity-unavailable' });
      }

      if (!isSupported(IAP.getProductItemList)) {
        return setPurchaseState(storedGrant ? 'ad-free' : 'unavailable', {
          source: storedGrant ? 'cached' : source,
          message: 'product-list-unsupported',
        });
      }

      const productResult = await IAP.getProductItemList();
      const product = productResult?.products?.find((item) => item?.sku === adFreeSku);
      if (!product || product.type !== 'NON_CONSUMABLE') {
        adFreeProduct = null;
        return setPurchaseState('error', {
          source,
          productValid: false,
          productType: product?.type || '',
          displayAmount: product?.displayAmount || '',
          message: product ? 'invalid-product-type' : 'product-not-found',
        });
      }

      adFreeProduct = Object.freeze({ ...product });
      const productPatch = {
        productValid: true,
        productType: product.type,
        displayAmount: String(product.displayAmount || ''),
      };
      setPurchaseState('checking', { source, ...productPatch });

      let pendingSupported = isSupported(IAP.getPendingOrders);
      const grantedPendingOrders = [];
      if (pendingSupported) {
        const pendingResult = await IAP.getPendingOrders();
        const pendingOrders = (pendingResult?.orders || []).filter(
          (order) => order?.sku === adFreeSku,
        );
        if (pendingOrders.length > 0) {
          setPurchaseState('pending', { source: 'pending', ...productPatch });
          if (!isSupported(IAP.completeProductGrant)) {
            return setPurchaseState('pending', {
              source: 'pending',
              ...productPatch,
              message: 'complete-grant-unsupported',
            });
          }
          for (const order of pendingOrders) {
            if (!(await writeStoredGrant(Storage, order.orderId))) {
              return setPurchaseState('error', {
                source: 'pending',
                ...productPatch,
                message: 'storage-write-failed',
              });
            }
            const completed = await IAP.completeProductGrant({
              params: { orderId: order.orderId },
            });
            if (!completed) {
              return setPurchaseState('error', {
                source: 'pending',
                ...productPatch,
                message: 'complete-grant-failed',
              });
            }
            grantedPendingOrders.push(order);
          }
        }
      }

      if (!isSupported(IAP.getCompletedOrRefundedOrders)) {
        return setPurchaseState(storedGrant || grantedPendingOrders.length ? 'ad-free' : 'unknown', {
          source: storedGrant || grantedPendingOrders.length ? 'cached' : source,
          ...productPatch,
          message: 'history-unsupported',
        });
      }

      // SDK 3.0.2 currently accepts no pagination argument, so only the first
      // completed/refunded page can be queried safely.
      const history = await IAP.getCompletedOrRefundedOrders();
      const matchingHistory = latestStatusPerOrder(
        (history?.orders || []).filter((order) => order?.sku === adFreeSku),
      );
      const activeCompletedOrder = newestOrder(
        matchingHistory.filter((order) => order.status === 'COMPLETED'),
      );
      const refundedOrderIds = new Set(
        matchingHistory
          .filter((order) => order.status === 'REFUNDED')
          .map((order) => String(order.orderId)),
      );
      const activePendingOrder = newestOrder(
        grantedPendingOrders.filter((order) => !refundedOrderIds.has(String(order.orderId))),
      );

      // A refund applies to its own order only. If any other non-consumable
      // order is still completed (for example, a repurchase), entitlement stays active.
      if (activePendingOrder || activeCompletedOrder) {
        const activeOrderId = activePendingOrder?.orderId || activeCompletedOrder?.orderId || '';
        if (!(await writeStoredGrant(Storage, activeOrderId))) {
          return setPurchaseState('error', {
            source: activePendingOrder ? 'pending' : 'history',
            ...productPatch,
            message: 'storage-write-failed',
          });
        }
        return setPurchaseState('ad-free', {
          source: activePendingOrder ? 'pending' : 'history',
          ...productPatch,
          orderId: activeOrderId,
        });
      }

      if (history?.hasNext && matchingHistory.length === 0) {
        // An older matching order may be beyond the first page. Never revoke a
        // cached entitlement or enable ads from an incomplete history scan.
        return setPurchaseState(storedGrant ? 'ad-free' : 'unknown', {
          source: storedGrant ? 'cached' : source,
          ...productPatch,
          orderId: storedGrant?.orderId || '',
          message: 'history-incomplete',
        });
      }

      if (!pendingSupported) {
        return setPurchaseState(storedGrant ? 'ad-free' : 'unknown', {
          source: storedGrant ? 'cached' : source,
          ...productPatch,
          orderId: storedGrant?.orderId || '',
          message: 'pending-orders-unsupported',
        });
      }

      if (!(await removeStoredGrant(Storage))) {
        return setPurchaseState('error', {
          source,
          ...productPatch,
          message: 'storage-remove-failed',
        });
      }
      return setPurchaseState('ad-supported', {
        source: matchingHistory.some((order) => order.status === 'REFUNDED')
          ? 'refunded'
          : source,
        ...productPatch,
        orderId: '',
      });
    })
    .catch(() => setPurchaseState('error', { source, message: 'sync-failed' }))
    .finally(() => {
      entitlementSyncPromise = null;
    });

  return entitlementSyncPromise;
}

function purchaseAdFree() {
  if (purchasePromise) return purchasePromise;
  if (
    bridgeDisposed ||
    !isTossMiniapp ||
    !adFreeSku ||
    purchaseState.status === 'checking' ||
    purchaseState.status === 'pending'
  ) {
    return Promise.resolve(false);
  }
  if (purchaseState.status === 'ad-free') return Promise.resolve(purchaseState);
  if (purchaseState.status !== 'ad-supported') return Promise.resolve(false);

  purchasePromise = requireSdk()
    .then(({ IAP, Storage }) => {
      if (
        !adFreeProduct ||
        adFreeProduct.type !== 'NON_CONSUMABLE' ||
        !isSupported(IAP.createOneTimePurchaseOrder)
      ) {
        return setPurchaseState('error', {
          source: 'purchase',
          message: 'purchase-unsupported',
        });
      }

      setPurchaseState('pending', { source: 'purchase' });
      return new Promise((resolve) => {
        let cleanup;
        let cleanupFinished = false;
        let settled = false;
        const cleanupOnce = () => {
          if (cleanupFinished || typeof cleanup !== 'function') return;
          cleanupFinished = true;
          try {
            cleanup?.();
          } catch (_) {}
        };
        const finish = (result) => {
          if (settled) return;
          settled = true;
          activePurchaseCancels.delete(cancel);
          cleanupOnce();
          resolve(result);
        };
        const cancel = () => finish(false);
        activePurchaseCancels.add(cancel);

        try {
          cleanup = IAP.createOneTimePurchaseOrder({
            options: {
              sku: adFreeSku,
              processProductGrant: ({ orderId }) =>
                processAdFreeProductGrant(Storage, orderId, 'purchase'),
            },
            onEvent: (event) => {
              if (event?.type !== 'success') return;
              if (purchaseState.status !== 'ad-free') {
                setPurchaseState('error', {
                  source: 'purchase',
                  message: 'grant-not-persisted',
                });
                finish(false);
                return;
              }
              finish(purchaseState);
            },
            onError: (error) => {
              const code = purchaseErrorCode(error);
              if (code.includes('PAYMENT_PENDING')) {
                setPurchaseState('pending', {
                  source: 'purchase',
                  message: 'payment-pending',
                });
              } else if (code.includes('USER_CANCELED') || code.includes('USER_CANCELLED')) {
                setPurchaseState('ad-supported', {
                  source: 'purchase',
                  message: 'user-canceled',
                });
              } else {
                setPurchaseState('error', {
                  source: 'purchase',
                  message: 'purchase-failed',
                });
              }
              finish(false);
            },
          });
          if (settled) cleanupOnce();
        } catch (_) {
          setPurchaseState('error', { source: 'purchase', message: 'purchase-failed' });
          finish(false);
        }
      });
    })
    .catch(() => setPurchaseState('error', { source: 'purchase', message: 'purchase-failed' }))
    .finally(() => {
      purchasePromise = null;
    });

  return purchasePromise;
}

function restoreAdFreePurchase() {
  return synchronizeAdFreeEntitlement('restore');
}

function preloadInterstitial() {
  if (
    bridgeDisposed ||
    !isTossMiniapp ||
    !interstitialAdGroupId ||
    !isConfirmedAdSupported() ||
    interstitialShowPromise
  ) {
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
          const permitted = loaded && isConfirmedAdSupported();
          interstitialLoaded = permitted;
          resolve(permitted);
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
  if (
    bridgeDisposed ||
    !isTossMiniapp ||
    !interstitialAdGroupId ||
    !isConfirmedAdSupported()
  ) {
    return Promise.resolve(false);
  }
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
  Purchases: Object.freeze({
    getState: () => purchaseState,
    subscribe: (listener) => subscribeWindowEvent(PURCHASE_STATE_EVENT, listener),
    purchaseAdFree,
    restoreAdFreePurchase,
    syncAdFreeEntitlement: synchronizeAdFreeEntitlement,
  }),
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
