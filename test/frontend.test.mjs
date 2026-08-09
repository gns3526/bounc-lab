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
  assert.doesNotMatch(viewport, /maximum-scale|user-scalable/);
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
