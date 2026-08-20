import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const tossBridge = await readFile(new URL('../public/toss-bridge.js', import.meta.url), 'utf8');
const staticHeaders = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');

function frontendFunction(name, nextName) {
  const start = html.indexOf(`  function ${name}(`);
  const end = html.indexOf(`\n\n  function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  const source = html.slice(start, end);
  return new Function(`${source}; return ${name};`)();
}

function tossBridgeFunction(name, nextName) {
  const start = tossBridge.indexOf(`function ${name}(`);
  const end = tossBridge.indexOf(`\n\nfunction ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} must exist in the Toss bridge`);
  assert.notEqual(end, -1, `${nextName} must follow ${name} in the Toss bridge`);
  const source = tossBridge.slice(start, end);
  return new Function(`${source}; return ${name};`)();
}

function embeddedArray(name) {
  const declaration = html.indexOf(`  const ${name} =`);
  const start = html.indexOf('[', declaration);
  const end = html.indexOf('];', start);
  assert.notEqual(declaration, -1, `${name} declaration must exist`);
  assert.notEqual(start, -1, `${name} array must start`);
  assert.notEqual(end, -1, `${name} array must end`);
  return new Function(`return (${html.slice(start, end + 1)});`)();
}

function officialDangerFixture() {
  const stages = embeddedArray('RAW_STAGES').map((stage) =>
    stage.trim().split('\n').map((row) => [...row].map(Number)),
  );
  const stageMeta = embeddedArray('STAGE_META');
  const start = html.indexOf('  const OFFICIAL_DANGER_BANDS');
  const end = html.indexOf('\n\n  function showAppToast', start);
  assert.notEqual(start, -1, 'official danger rules must exist');
  assert.notEqual(end, -1, 'official danger rules must be self-contained');
  const source = html.slice(start, end);
  const api = new Function(
    'STAGES',
    'STAGE_META',
    `${source}; return {officialDangerProfile, officialDangerCandidates, applyOfficialDanger, cloneStage};`,
  )(stages, stageMeta);
  return { stages, stageMeta, source, ...api };
}

function validCustomMap() {
  const grid = Array.from({ length: 15 }, () => Array(20).fill(1));
  for (let row = 1; row < 14; row += 1) {
    for (let column = 1; column < 19; column += 1) grid[row][column] = 0;
  }
  grid[12][19] = 0;
  return { version: 1, grid, spawn: { c: 1, r: 12 }, exitRow: 12 };
}

test('single-file frontend parses and keeps DOM ids unique', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'DOM id values must be unique');
});

test('Cloudflare static assets keep browser security headers', () => {
  assert.match(staticHeaders, /X-Content-Type-Options:\s*nosniff/i);
  assert.match(staticHeaders, /X-Frame-Options:\s*SAMEORIGIN/i);
  assert.match(staticHeaders, /Referrer-Policy:\s*same-origin/i);
  assert.match(staticHeaders, /Content-Security-Policy:/i);
  assert.match(staticHeaders, /connect-src 'self'/);
});

test('online creation flow and compact controls are present', () => {
  for (const id of [
    'communityOverlay',
    'communityGrid',
    'editorCanvas',
    'editorTestBtn',
    'verificationBadge',
    'mapTitleInput',
    'authorNameInput',
    'communityTermsCheck',
    'communityHideMapBtn',
    'communityHideAuthorBtn',
    'communityReportBtn',
    'communityDeleteBtn',
    'reportOverlay',
    'reportSubmitBtn',
    'pauseBtn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /apiRequest\('\/attempts'/);
  assert.match(html, /apiRequest\('\/maps'/);
  assert.match(html, /termsVersion:COMMUNITY_TERMS_VERSION/);
  assert.match(html, /if\(auth\)headers\['X-Author-Token'\]=ownerToken/);
  assert.match(html, /apiRequest\(`\/maps\?sort=/);
  assert.match(html, /\/report`,\{method:'POST'/);
  assert.match(html, /\/delete`,\{method:'POST'/);
  assert.match(html, /BLOCKED_MAPS_KEY/);
  assert.match(html, /BLOCKED_AUTHORS_KEY/);
  assert.match(html, /맵이 바뀌어 다시 클리어해야 합니다/);
  assert.match(html, /#soundBtn,#restartBtn\{display:none!important\}/);
});

test('game shortcuts preserve native input and control keyboard behavior', () => {
  const helperSource = html.match(/function isEditableOrInteractiveTarget\(target\)\{[\s\S]*?\n\s*\}/)?.[0];
  assert.ok(helperSource, 'interactive-target guard must exist');
  assert.match(helperSource, /input,textarea,select,button,summary,a\[href\]/);
  assert.match(helperSource, /\[contenteditable\]/);

  const keydownBody = html.match(/addEventListener\('keydown',e=>\{([\s\S]*?)\},\{passive:false\}\);/)?.[1];
  assert.ok(keydownBody, 'global keydown handler must exist');

  const guard = "if(e.isComposing||state!=='playing'||isEditableOrInteractiveTarget(e.target))return;";
  assert.ok(keydownBody.includes(guard), 'keydown handler must exit outside gameplay and on interactive targets');
  assert.ok(
    keydownBody.indexOf(guard) < keydownBody.indexOf('e.preventDefault()'),
    'interactive-target guard must run before preventDefault',
  );
});

test('mobile editor keeps essential controls readable and accessible', () => {
  const viewport = html.match(/<meta name="viewport" content="([^"]+)"/i)?.[1] || '';
  assert.match(viewport, /maximum-scale=1/);
  assert.match(viewport, /user-scalable=no/);
  assert.match(html, /class="publish-label"><span>맵 제목<\/span>/);
  assert.match(html, /id="editorStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="verificationBadge" role="status" aria-live="polite"/);
  assert.match(html, /id="communityStatus" role="status" aria-live="polite"/);
  assert.match(html, /publish-field,.community-toolbar input,.community-toolbar select,.setting-row select\{height:44px;min-height:44px;font-size:16px\}/);
  assert.match(html, /#pauseBtn\{min-width:44px;height:44px\}/);
  assert.match(html, /\.editor-tool\{min-height:44px;font-size:10px\}/);
  assert.match(html, /\.editor-tool\{min-width:44px;min-height:44px/);
  assert.match(html, /\.toast-inline\{position:absolute;z-index:120/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
});

test('touch is the default control and rapid left-right pointer handoff is not dropped', () => {
  assert.match(
    html,
    /safeStore\.get\('penguinBoundControlMode','touch'\) === 'joystick' \? 'joystick' : 'touch'/,
  );
  assert.match(
    html,
    /if\(controlPointer!==null\)\{\s*if\(controlMode!=='touch'\|\|e\.pointerId===controlPointer\)return;[\s\S]*?gameWrap\.releasePointerCapture\(previousPointer\)/,
  );
  assert.match(html, /controlPointer=e\.pointerId;[\s\S]*?updateTouchControl\(e\.clientX\)/);
});

test('folded portrait editor scrolls inside the safe viewport to reach bottom actions', () => {
  assert.match(
    html,
    /\.editor-layout\{[\s\S]*?overflow:auto;overscroll-behavior:contain;[\s\S]*?touch-action:pan-y/,
  );
  assert.match(
    html,
    /overflow-x:hidden;overflow-y:auto;padding-bottom:max\(12px,env\(safe-area-inset-bottom,0px\)\)/,
  );
  assert.match(html, /canvas\.editor-canvas[^}]*touch-action:none/);
});

test('Apps in Toss hooks cover identity, sharing, safe layout, and confirmed exit', () => {
  assert.match(html, /meta name="api-base-url"/);
  assert.match(html, /meta name="public-app-url"/);
  assert.match(html, /html\.toss-miniapp #app/);
  assert.match(html, /--toss-safe-top/);
  assert.match(html, /addEventListener\('bounc:toss-ready'/);
  assert.match(html, /window\.__BOUNC_TOSS__\?\.shareMap/);
  assert.match(html, /const publicAppUrl=.*meta\[name="public-app-url"\]/);
  assert.match(html, /MAX_VERIFICATION_REPLAY_TICKS\s*=\s*120\s*\*\s*60\s*;/);
  assert.match(html, /replay\.totalTicks>=MAX_VERIFICATION_REPLAY_TICKS/);
  assert.match(html, /맵 게시용 클리어는 1분 안에 완료해야 합니다/);
  assert.match(html, /new URL\(publicAppUrl\|\|location\.href,location\.href\)/);
  assert.match(html, /addEventListener\('bounc:toss-back',openExitDialog\)/);
  assert.match(html, /id="exitOverlay" role="dialog" aria-modal="true"/);
  assert.match(html, /document\.hidden/);
  assert.match(html, /SFX\.stopContinuous\(\)/);
  assert.match(tossBridge, /'penguin-bounce'/);
  assert.doesNotMatch(tossBridge, /'bounc-lab'/);
});

test('Toss interstitials fail open and only interrupt eligible official clear transitions', () => {
  assert.match(tossBridge, /meta\[name="toss-interstitial-ad-group-id"\]/);
  assert.match(tossBridge, /loadFullScreenAd/);
  assert.match(tossBridge, /showFullScreenAd/);
  assert.match(tossBridge, /INTERSTITIAL_TIMEOUT_MS = 90_000/);
  assert.match(tossBridge, /Ads: Object\.freeze\(\{ preloadInterstitial, showInterstitial \}\)/);
  assert.match(tossBridge, /if \(!interstitialLoaded\) \{[\s\S]*?return Promise\.resolve\(false\)/);
  assert.match(tossBridge, /options: \{ adGroupId: interstitialAdGroupId \}/);
  assert.match(tossBridge, /event\?\.type === 'loaded'/);
  assert.match(tossBridge, /type === 'dismissed'/);
  assert.match(tossBridge, /type === 'failedToShow'/);
  assert.match(tossBridge, /pageWasHidden && shown/);
  assert.match(tossBridge, /outcome: 'returned'/);
  assert.match(tossBridge, /removeEventListener\('visibilitychange', handleVisibilityChange\)/);
  assert.match(tossBridge, /bridgeDisposed = true/);
  assert.match(tossBridge, /activeInterstitialCancels\.delete\(cancel\)/);
  assert.match(tossBridge, /interstitialShowPromise = null;\s*void preloadInterstitial\(\)/);

  const isCandidate = frontendFunction(
    'isOfficialInterstitialCandidate',
    'shouldShowOfficialInterstitial',
  );
  assert.equal(isCandidate(3, 60_000, Infinity), true);
  assert.equal(isCandidate(6, 61_000, 90_000), true);
  assert.equal(isCandidate(2, 999_999, Infinity), false);
  assert.equal(isCandidate(3, 59_999, Infinity), false);
  assert.equal(isCandidate(3, 999_999, 89_999), false);

  assert.match(
    html,
    /return !customMode&&playContext==='official'&&isOfficialInterstitialCandidate/,
  );
  assert.match(html, /if\(!customMode&&playContext==='official'\)officialClearCount\+\+/);
  assert.match(
    html,
    /if\(shouldShowOfficialInterstitial\(\)\)await showOfficialInterstitialBeforeNextStage\(\)/,
  );
  assert.match(html, /if\(clearAdvancePending\)return;\s*clearAdvancePending=true/);
  assert.match(html, /state='ad';paused=true/);
  assert.match(html, /releasePointerControl\(\);SFX\.stopContinuous\(\);BGM\.pause\(\)/);
  assert.match(html, /if\(result&&result\.shown===true\)lastInterstitialShownAt=performance\.now\(\)/);
  assert.match(html, /if\(!muted&&!document\.hidden\)BGM\.resume\(\)/);
  assert.match(html, /if\(adTransitionActive\|\|purchaseTransitionActive\)return;if\(state==='playing'&&!paused\)togglePause/);

  for (const [startName, endName] of [
    ['restartStage', 'die'],
    ['die', 'completeStage'],
    ['loadCustomStage', 'startCustomGame'],
  ]) {
    const start = html.indexOf(`  function ${startName}(`);
    const end = [
      html.indexOf(`\n\n  function ${endName}(`, start),
      html.indexOf(`\n\n  async function ${endName}(`, start),
    ].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    assert.doesNotMatch(
      html.slice(start, end),
      /showInterstitial|showOfficialInterstitial/,
      `${startName} must never display an ad`,
    );
  }
});

test('Toss ad removal is account-bound, permanent, restorable, and fail-closed for ads', () => {
  assert.match(tossBridge, /meta\[name="toss-ad-free-sku"\]/);
  assert.doesNotMatch(tossBridge, /ait\.0000062458/, 'the SKU must come from Toss-only HTML metadata');
  assert.match(tossBridge, /\bIAP,\s*\n\s*SafeArea/);
  assert.match(tossBridge, /\bStorage,\s*\n\s*User/);
  assert.match(tossBridge, /product\.type !== 'NON_CONSUMABLE'/);
  assert.match(tossBridge, /displayAmount: String\(product\.displayAmount \|\| ''\)/);

  assert.match(tossBridge, /grant\?\.userHash !== identity\.userHash/);
  assert.match(tossBridge, /userHash: identity\.userHash/);
  assert.match(tossBridge, /rawStoredGrant && !storedGrant && !\(await removeStoredGrant\(Storage\)\)/);
  assert.match(tossBridge, /if \(!normalizedOrderId \|\| !identity\.userHash\) return false/);
  const grantWrite = tossBridge.slice(
    tossBridge.indexOf('async function writeStoredGrant('),
    tossBridge.indexOf('\n\nasync function removeStoredGrant('),
  );
  assert.ok(
    grantWrite.indexOf('await Storage.setItem(') < grantWrite.indexOf('return true'),
    'a grant may return true only after native Storage.setItem resolves',
  );
  assert.match(
    tossBridge,
    /async function processAdFreeProductGrant[\s\S]*?const stored = await writeStoredGrant[\s\S]*?if \(!stored\)[\s\S]*?return false;[\s\S]*?setPurchaseState\('ad-free'[\s\S]*?return true;/,
  );

  assert.match(tossBridge, /await synchronizeAdFreeEntitlement\('startup'\)/);
  assert.match(tossBridge, /restoreAdFreePurchase[\s\S]*?synchronizeAdFreeEntitlement\('restore'\)/);
  assert.match(tossBridge, /const pendingResult = await IAP\.getPendingOrders\(\)/);
  assert.match(tossBridge, /await IAP\.completeProductGrant\(\{\s*params: \{ orderId: order\.orderId \}/);
  assert.match(tossBridge, /const history = await IAP\.getCompletedOrRefundedOrders\(\);/);
  assert.doesNotMatch(
    tossBridge,
    /await IAP\.getCompletedOrRefundedOrders\([^)]/,
    'SDK 3.0.2 history lookup must not receive an unsupported pagination argument',
  );
  assert.match(tossBridge, /if \(history\?\.hasNext && matchingHistory\.length === 0\)[\s\S]*?storedGrant \? 'ad-free' : 'unknown'/);
  assert.match(tossBridge, /message: 'history-incomplete'/);
  assert.match(tossBridge, /order\.status === 'REFUNDED'/);

  const latestStatusPerOrder = tossBridgeFunction('latestStatusPerOrder', 'purchaseErrorCode');
  const folded = latestStatusPerOrder([
    { orderId: 'order-a', status: 'COMPLETED', date: '2026-01-01T00:00:00Z' },
    { orderId: 'order-a', status: 'REFUNDED', date: '2026-02-01T00:00:00Z' },
    { orderId: 'order-b', status: 'COMPLETED', date: '2026-01-15T00:00:00Z' },
  ]);
  assert.deepEqual(
    folded.map(({ orderId, status }) => ({ orderId, status })),
    [
      { orderId: 'order-a', status: 'REFUNDED' },
      { orderId: 'order-b', status: 'COMPLETED' },
    ],
    'a refunded old order must not cancel a separate completed repurchase',
  );
  assert.match(
    tossBridge,
    /matchingHistory\.filter\(\(order\) => order\.status === 'COMPLETED'\)/,
  );
  assert.match(tossBridge, /if \(activePendingOrder \|\| activeCompletedOrder\)/);
  assert.match(tossBridge, /!refundedOrderIds\.has\(String\(order\.orderId\)\)/);

  const purchaseErrorCode = tossBridgeFunction('purchaseErrorCode', 'synchronizeAdFreeEntitlement');
  assert.match(purchaseErrorCode({ code: 'PAYMENT_PENDING' }), /PAYMENT_PENDING/);
  assert.match(purchaseErrorCode({ code: 'UNKNOWN', message: 'USER_CANCELED' }), /USER_CANCELED/);
  assert.match(purchaseErrorCode('USER_CANCELLED'), /USER_CANCELLED/);

  assert.match(tossBridge, /if \(purchasePromise\) return purchasePromise/);
  assert.match(tossBridge, /purchaseState\.status !== 'ad-supported'/);
  assert.match(tossBridge, /const cleanupOnce = \(\) =>/);
  assert.match(tossBridge, /cleanupFinished \|\| typeof cleanup !== 'function'/);
  assert.match(tossBridge, /activePurchaseCancels\.delete\(cancel\)/);
  assert.match(tossBridge, /for \(const cancel of \[\.\.\.activePurchaseCancels\]\) cancel\(\)/);
  assert.match(
    tossBridge,
    /if \(isTossMiniapp\) \{\s*window\.addEventListener\('pageshow', \(event\) => \{[\s\S]*?if \(event\.persisted\) window\.location\.reload\(\)/,
  );
  assert.match(tossBridge, /code\.includes\('PAYMENT_PENDING'\)/);
  assert.match(tossBridge, /message: 'payment-pending'/);
  assert.match(tossBridge, /code\.includes\('USER_CANCELED'\)/);
  assert.match(tossBridge, /message: 'user-canceled'/);
  assert.match(tossBridge, /return purchaseState\.status === 'ad-supported'/);
  assert.match(tossBridge, /!isConfirmedAdSupported\(\)/);
  assert.match(tossBridge, /if \(status !== 'ad-supported'\) disableInterstitial\(\)/);

  assert.match(html, /\.toss-purchase\{display:none/);
  assert.match(html, /html\.toss-miniapp \.toss-purchase\{display:grid\}/);
  assert.match(html, /id="tossPurchasePanel"/);
  assert.match(html, /id="adFreePurchaseBtn" disabled>광고 제거 · 확인 중/);
  assert.match(html, /id="adFreeRestoreBtn" disabled>구매 복원/);
  assert.match(html, /const priceLabel=displayAmount\?`광고 제거 · \$\{displayAmount\}`/);
  assert.match(html, /'payment-pending':'결제 승인을 기다리고 있어요/);
  assert.match(html, /'user-canceled':'결제가 취소됐어요/);
  assert.match(html, /purchaseAdFree:purchases\?\.restoreAdFreePurchase/);
  assert.match(html, /purchaseTransitionActive=true;[\s\S]*?SFX\.stopContinuous\(\);BGM\.pause\(\)/);
  assert.match(html, /ui\.adFreePurchaseBtn\.onclick=.*runTossPurchaseAction\('purchase'\)/);
  assert.match(html, /ui\.adFreeRestoreBtn\.onclick=.*runTossPurchaseAction\('restore'\)/);
  assert.match(html, /if\(adTransitionActive\|\|purchaseTransitionActive\)return/);
  assert.match(html, /!adTransitionActive&&!purchaseTransitionActive&&!muted/);
  assert.match(html, /function restartStage\(fromDeath=false\) \{\s*if\(purchaseTransitionActive\)return/);
  assert.match(html, /function togglePause\(force,silent=false\) \{\s*if\(purchaseTransitionActive\|\|state!=='playing'\)return/);
});

test('two bundled BGM tracks form a gesture-unlocked background playlist', async () => {
  assert.match(html, /id="bgmAudio" preload="metadata" playsinline/);
  assert.match(html, /data-bgm-track src="\.\/assets\/audio\/penguin-bounce-01\.mp3"/);
  assert.match(html, /data-bgm-track src="\.\/assets\/audio\/penguin-bounce-02\.mp3"/);
  assert.match(html, /const BGM_TRACKS=/);
  assert.match(html, /ui\.bgmAudio\.addEventListener\('ended',\(\)=>BGM\.next\(\)\)/);
  assert.match(html, /addEventListener\('pointerdown',unlockGameAudio/);
  assert.match(html, /BGM\.pause\(\)/);
  assert.match(html, /Promise\.all\(\[SFX\.unlock\(\),BGM\.unlock\(\)\]\)/);

  for (const fileName of ['penguin-bounce-01.mp3', 'penguin-bounce-02.mp3']) {
    const bytes = await readFile(new URL(`../public/assets/audio/${fileName}`, import.meta.url));
    assert.ok(bytes.length > 1_000_000, `${fileName} must contain the full track`);
    assert.equal(bytes.subarray(0, 3).toString('ascii'), 'ID3');
  }
});

test('mobile viewport fills the surface and follows the player without page scrolling', () => {
  assert.match(html, /function syncViewportLayout\(\)/);
  assert.match(html, /window\.visualViewport/);
  assert.match(html, /const compactSurface=viewportW<=900\|\|viewportH<=650\|\|root\.classList\.contains\('toss-miniapp'\)/);
  assert.match(html, /const appW=compactSurface\?availableW:Math\.min\(980,availableW,availableH\*\(4\/3\)\)/);
  assert.match(html, /root\.style\.setProperty\('--app-h'/);
  assert.match(html, /function syncGameCanvasViewport\(\)/);
  assert.match(html, /const coverScale=Math\.max\(cssW\/WORLD_W,cssH\/WORLD_H\)/);
  assert.match(html, /function updateGameCamera\(\)/);
  assert.match(html, /cameraAxisTarget\(player\.x/);
  assert.match(html, /ctx\.setTransform\(drawScale,0,0,drawScale,-gameCamera\.x\*drawScale,-gameCamera\.y\*drawScale\)/);
  assert.match(html, /html\.toss-miniapp #game\{[\s\S]*?inset:0;width:100%;height:100%;aspect-ratio:auto;transform:none/);
  assert.match(html, /addEventListener\('orientationchange',scheduleViewportLayout/);
  assert.match(html, /window\.visualViewport\?\.addEventListener\('resize',scheduleViewportLayout/);
  assert.match(html, /#selectOverlay>\.card>\.levels\{grid-row:3\}/);
  assert.match(html, /#selectOverlay>\.card>\.menu-row\{grid-row:4\}/);
  assert.match(html, /\.community-card>\.community-grid\{grid-row:4\}/);
  assert.match(html, /\.community-card>\.community-primary\{grid-row:6\}/);
  assert.match(html, /\.editor-tools\{grid-template-columns:repeat\(5,minmax\(44px,1fr\)\)/);
  assert.doesNotMatch(html, /body\{padding:3px\}#app\{width:min\(100vw/);
});

test('official-stage danger rises deterministically while custom-map physics stays fixed', () => {
  const { stages, source, officialDangerProfile, cloneStage } = officialDangerFixture();
  assert.equal(stages.length, 100);
  assert.doesNotMatch(source, /Math\.random/, 'official danger must never use random deaths');

  const profiles = stages.map((_, index) => officialDangerProfile(index));
  for (let index = 1; index < profiles.length; index += 1) {
    const previous = profiles[index - 1];
    const current = profiles[index];
    assert.ok(current.level >= previous.level, `danger level fell at stage ${index + 1}`);
    assert.ok(current.pressure >= previous.pressure, `pressure fell at stage ${index + 1}`);
    assert.ok(current.addedHazards >= previous.addedHazards, `hazard budget fell at stage ${index + 1}`);
    assert.ok(current.bombHazards >= previous.bombHazards, `bomb budget fell at stage ${index + 1}`);
    assert.ok(current.fragileDelay <= previous.fragileDelay, `fragile delay rose at stage ${index + 1}`);
    assert.ok(current.bombHitScale >= previous.bombHitScale, `bomb tolerance rose at stage ${index + 1}`);
    assert.ok(current.bombInset <= previous.bombInset, `bomb inset rose at stage ${index + 1}`);
    if (index >= 20) assert.ok(current.pressure > previous.pressure, `late pressure must rise at stage ${index + 1}`);
  }
  assert.equal(profiles[19].fragileDelay, 0.18, 'stages 1-20 remain the teaching section');
  assert.ok(Math.abs(profiles[99].fragileDelay - 0.1) < 1e-12);
  assert.ok(Math.abs(profiles[99].bombHitScale - 0.96) < 1e-12);
  assert.ok(Math.abs(profiles[99].bombInset - 1.5) < 1e-12);

  const originalSnapshot = structuredClone(stages);
  const enhancedStages = stages.map((original, index) => {
    const first = cloneStage(index);
    const second = cloneStage(index);
    assert.deepEqual(first, second, `stage ${index + 1} danger placement must be deterministic`);
    const changes = [];
    for (let row = 0; row < 15; row += 1) for (let column = 0; column < 20; column += 1) {
      if (first[row][column] === original[row][column]) continue;
      changes.push({ row, column, tile: first[row][column] });
      assert.equal(original[row][column], 1, 'only stable ice may be replaced');
      assert.ok(first[row][column] === 3 || first[row][column] === 6, 'danger tiles must be fragile ice or bombs');
      assert.equal(original[row - 1][column], 0, 'danger tile must be on an exposed surface');
      assert.equal(original[row][column - 1], 1, 'danger tile must retain a stable left landing');
      assert.equal(original[row][column + 1], 1, 'danger tile must retain a stable right landing');
      assert.ok(
        original[row][column - 2] === 1 || original[row][column + 2] === 1,
        'at least one side of a danger tile must retain a two-tile landing',
      );
    }
    assert.ok(changes.length <= profiles[index].addedHazards, 'safe placement may skip, never exceed, its budget');
    const addedBombs = changes.filter((change) => change.tile === 6).length;
    assert.equal(
      addedBombs,
      Math.min(profiles[index].bombHazards, changes.length),
      'sparse late maps must preserve the lethal part of their danger budget',
    );
    for (let a = 0; a < changes.length; a += 1) for (let b = a + 1; b < changes.length; b += 1) {
      const rowGap = Math.abs(changes[a].row - changes[b].row);
      const columnGap = Math.abs(changes[a].column - changes[b].column);
      assert.ok(columnGap >= 2 && (rowGap > 1 || columnGap >= 3), 'procedural danger tiles must stay separated');
    }
    return first;
  });
  assert.deepEqual(stages, originalSnapshot, 'official source maps must remain immutable');
  assert.deepEqual(enhancedStages[19], stages[19], 'stage 20 must remain unchanged');
  assert.notDeepEqual(enhancedStages[20], stages[20], 'stage 21 starts the rising hazard curve');

  const previouslySafeLateStages = [80, 81, 82, 83, 90, 91, 92, 93];
  for (const index of previouslySafeLateStages) {
    const originalBombs = stages[index].flat().filter((tile) => tile === 6).length;
    const enhancedBombs = enhancedStages[index].flat().filter((tile) => tile === 6).length;
    assert.ok(enhancedBombs >= originalBombs + 2, `stage ${index + 1} must gain meaningful lethal risk`);
  }
  const lateBombMaps = enhancedStages.slice(80).filter((stage) => stage.flat().includes(6)).length;
  assert.ok(lateBombMaps >= 18, 'at least nine tenths of stages 81-100 must contain bombs');

  assert.match(html, /const danger=customMode\?\{bombHitScale:\.88,bombInset:3\}:officialDangerProfile\(stageIndex\)/);
  assert.match(html, /const delay=customMode\?\.18:officialDangerProfile\(stageIndex\)\.fragileDelay/);
  assert.match(html, /위험도 \$\{dangerLevel\}\/10/);
});

test('pause menu exposes every control directly below the break heading', () => {
  const pauseMarkup=html.match(/<section class="overlay hidden" id="pauseOverlay">([\s\S]*?)<\/section>/)?.[1]||'';
  assert.match(pauseMarkup, /<h2>잠깐 쉬어가기<\/h2>/);
  assert.match(pauseMarkup, /class="pause-controls"/);
  assert.match(pauseMarkup, /id="resumeBtn"/);
  assert.match(pauseMarkup, /id="controlModeSelect"/);
  assert.match(pauseMarkup, /id="pauseRestartBtn"/);
  assert.match(pauseMarkup, /id="pauseSoundBtn"/);
  assert.match(pauseMarkup, /id="pauseSelectBtn"/);
  assert.match(pauseMarkup, /id="pauseEditorBtn"/);
  assert.doesNotMatch(pauseMarkup, /<details|<summary|게임 설정과 다른 메뉴/);
});

test('published map metadata is locked until the layout is edited again', () => {
  assert.match(html, /function setEditorMetadataLocked\(locked\)/);
  assert.match(html, /setEditorMetadataLocked\(!!publishedDraft\)/);
  assert.match(html, /field\.readOnly=locked/);
  assert.match(html, /activeAttempt=null;verifiedDraft=null;publishedDraft=null/);
  assert.match(html, /복사해서 새 맵 만들기/);
});

test('custom-map normalization rejects malformed data without repairing it', () => {
  const normalizeCustomMap = frontendFunction('normalizeCustomMap', 'readSavedCustomMap');
  const valid = validCustomMap();
  const normalized = normalizeCustomMap(valid);
  assert.deepEqual(normalized, valid);
  assert.notEqual(normalized.grid, valid.grid, 'normalization must clone the grid');

  const invalidTile = structuredClone(valid);
  invalidTile.grid[4][4] = '1';
  assert.equal(normalizeCustomMap(invalidTile), null, 'numeric strings must not be coerced');

  const outOfRangeTile = structuredClone(valid);
  outOfRangeTile.grid[4][4] = 7;
  assert.equal(normalizeCustomMap(outOfRangeTile), null, 'out-of-range tiles must not become empty cells');

  const extraExit = structuredClone(valid);
  extraExit.grid[5][19] = 0;
  assert.equal(normalizeCustomMap(extraExit), null, 'extra exits must not be silently closed');

  const mismatchedExit = structuredClone(valid);
  mismatchedExit.exitRow = 5;
  assert.equal(normalizeCustomMap(mismatchedExit), null, 'exitRow must identify the sole opening');

  const unsupportedVersion = structuredClone(valid);
  unsupportedVersion.version = 2;
  assert.equal(normalizeCustomMap(unsupportedVersion), null);
});
