import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function frontendFunction(name, nextName) {
  const start = html.indexOf(`  function ${name}(`);
  const end = html.indexOf(`\n\n  function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  const source = html.slice(start, end);
  return new Function(`${source}; return ${name};`)();
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

test('online creation flow and compact controls are present', () => {
  for (const id of [
    'communityOverlay',
    'communityGrid',
    'editorCanvas',
    'editorTestBtn',
    'verificationBadge',
    'mapTitleInput',
    'authorNameInput',
    'pauseBtn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /apiRequest\('\/attempts'/);
  assert.match(html, /apiRequest\('\/maps'/);
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

test('Apps in Toss hooks cover identity, sharing, safe layout, and confirmed exit', () => {
  assert.match(html, /meta name="api-base-url"/);
  assert.match(html, /html\.toss-miniapp #app/);
  assert.match(html, /--toss-safe-top/);
  assert.match(html, /addEventListener\('bounc:toss-ready'/);
  assert.match(html, /window\.__BOUNC_TOSS__\?\.shareMap/);
  assert.match(html, /addEventListener\('bounc:toss-back',openExitDialog\)/);
  assert.match(html, /id="exitOverlay" role="dialog" aria-modal="true"/);
  assert.match(html, /document\.hidden/);
  assert.match(html, /SFX\.stopContinuous\(\)/);
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
