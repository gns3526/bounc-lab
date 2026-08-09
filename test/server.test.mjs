import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { createBounceServer } from '../server.mjs';

const OWNER_TOKEN = 'owner-token-with-more-than-16-characters';
const OTHER_TOKEN = 'different-owner-token-more-than-16-chars';
const TEST_SECRET = 'test-only-publish-secret-at-least-32-bytes';
const VALID_REPLAY = Object.freeze({
  version: 1,
  engineVersion: 'bounce-physics-v1',
  totalTicks: 344,
  events: [[0, 1]],
});

function makeMap() {
  const grid = Array.from({ length: 15 }, () => Array(20).fill(0));
  grid[14].fill(1);
  for (let row = 0; row < 14; row += 1) grid[row][19] = 1;
  grid[12][19] = 0;
  grid[10][6] = 2;
  grid[9][10] = 3;
  grid[8][13] = 4;
  grid[7][14] = 5;
  grid[13][17] = 6;
  return { version: 1, grid, spawn: { c: 1, r: 12 }, exitRow: 12 };
}

async function startFixture(t, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'bounce-api-test-'));
  const publicDirectory = resolve(directory, 'public');
  const dataFile = resolve(directory, 'data', 'maps.json');
  await mkdir(publicDirectory, { recursive: true });
  await writeFile(resolve(publicDirectory, 'index.html'), '<!doctype html><title>Bounce fixture</title>', 'utf8');
  const server = await createBounceServer({
    publicDirectory,
    dataFile,
    publishSecret: TEST_SECRET,
    ...options,
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    if (server.listening) await new Promise((accept) => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  });
  return { server, baseUrl, directory, dataFile, publicDirectory };
}

async function api(baseUrl, path, { method = 'GET', token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders['X-Author-Token'] = token;
  if (body !== undefined && typeof body !== 'string') requestHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { response, json, text };
}

async function publishMap(baseUrl, map, { token = OWNER_TOKEN, title = '테스트 맵', author = '테스터' } = {}) {
  const attempt = await api(baseUrl, '/api/attempts', { method: 'POST', token, body: { map } });
  assert.equal(attempt.response.status, 201, attempt.text);
  const complete = await api(baseUrl, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token, body: { replay: VALID_REPLAY },
  });
  assert.equal(complete.response.status, 200, complete.text);
  const published = await api(baseUrl, '/api/maps', {
    method: 'POST', token, body: { map, title, author, publishTicket: complete.json.publishTicket },
  });
  assert.equal(published.response.status, 201, published.text);
  return { attempt, complete, published };
}

test('health endpoint and static file serving work', async (t) => {
  const { baseUrl, publicDirectory } = await startFixture(t);

  const health = await api(baseUrl, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.status, 'ok');
  assert.equal(health.json.mapCount, 0);

  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Bounce fixture/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  await writeFile(resolve(publicDirectory, 'theme.mp3'), Buffer.from('ID3'));
  const music = await fetch(`${baseUrl}/theme.mp3`);
  assert.equal(music.status, 200);
  assert.equal(music.headers.get('content-type'), 'audio/mpeg');

  const missingApi = await api(baseUrl, '/api/nope');
  assert.equal(missingApi.response.status, 404);
  assert.equal(missingApi.json.error.code, 'API_NOT_FOUND');
});

test('CORS preflight allows SDK3 Toss and explicitly configured origins', async (t) => {
  const { baseUrl } = await startFixture(t, {
    nodeEnv: 'production',
    tossAppName: 'bounce-lab',
    allowedOrigins: 'https://maps.example.com, https://ops.example.com',
  });
  const tossOrigin = 'https://bounce-lab.web.tossmini.com';
  const preflight = await fetch(`${baseUrl}/api/attempts`, {
    method: 'OPTIONS',
    headers: {
      Origin: tossOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, x-author-token',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), tossOrigin);
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Author-Token/i);
  assert.equal(preflight.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(preflight.headers.get('vary') || '', /Origin/);

  const privateOrigin = 'https://bounce-lab.private-web.tossmini.com';
  const privateHealth = await api(baseUrl, '/api/health', { headers: { Origin: privateOrigin } });
  assert.equal(privateHealth.response.status, 200);
  assert.equal(privateHealth.response.headers.get('access-control-allow-origin'), privateOrigin);
  assert.equal(privateHealth.response.headers.get('cross-origin-resource-policy'), 'cross-origin');

  const configuredHealth = await api(baseUrl, '/api/health', {
    headers: { Origin: 'https://ops.example.com' },
  });
  assert.equal(configuredHealth.response.status, 200);
  assert.equal(configuredHealth.response.headers.get('access-control-allow-origin'), 'https://ops.example.com');
});

test('CORS blocks untrusted origins and only allows localhost outside production', async (t) => {
  const production = await startFixture(t, { nodeEnv: 'production', tossAppName: 'bounce-lab' });
  const blocked = await api(production.baseUrl, '/api/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'GET',
    },
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.json.error.code, 'CORS_ORIGIN_DENIED');
  assert.equal(blocked.response.headers.get('access-control-allow-origin'), null);
  assert.equal(blocked.response.headers.get('cross-origin-resource-policy'), 'cross-origin');

  const productionLocal = await api(production.baseUrl, '/api/health', {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(productionLocal.response.status, 403);
  assert.equal(productionLocal.json.error.code, 'CORS_ORIGIN_DENIED');

  const development = await startFixture(t, { nodeEnv: 'development' });
  const developmentLocal = await api(development.baseUrl, '/api/health', {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(developmentLocal.response.status, 200);
  assert.equal(developmentLocal.response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('API rate limiting returns a retry hint', async (t) => {
  const { baseUrl } = await startFixture(t, { generalRateLimit: 1 });
  const first = await api(baseUrl, '/api/health');
  assert.equal(first.response.status, 200);

  const limited = await api(baseUrl, '/api/health');
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
});

test('only the same owner can complete an attempt and publish its exact map once', async (t) => {
  const { baseUrl } = await startFixture(t);
  const map = makeMap();

  const attempt = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map },
  });
  assert.equal(attempt.response.status, 201, attempt.text);
  assert.match(attempt.json.attemptId, /^[A-Za-z0-9_-]+$/);
  assert.match(attempt.json.mapHash, /^[a-f0-9]{64}$/);

  const wrongCompletion = await api(baseUrl, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OTHER_TOKEN, body: {},
  });
  assert.equal(wrongCompletion.response.status, 403);
  assert.equal(wrongCompletion.json.error.code, 'ATTEMPT_OWNER_MISMATCH');

  const missingProof = await api(baseUrl, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OWNER_TOKEN, body: {},
  });
  assert.equal(missingProof.response.status, 422);
  assert.equal(missingProof.json.error.code, 'INVALID_CLEAR_PROOF');
  assert.equal(missingProof.json.error.details.reason, 'REPLAY_REQUIRED');

  const forgedCompletion = await api(baseUrl, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST',
    token: OWNER_TOKEN,
    body: {
      replay: { version: 1, engineVersion: 'bounce-physics-v1', totalTicks: 1, events: [[0, 1]] },
    },
  });
  assert.equal(forgedCompletion.response.status, 422);
  assert.equal(forgedCompletion.json.error.code, 'INVALID_CLEAR_PROOF');
  assert.equal(forgedCompletion.json.error.details.reason, 'REPLAY_DID_NOT_CLEAR');

  const completion = await api(baseUrl, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OWNER_TOKEN, body: { replay: VALID_REPLAY },
  });
  assert.equal(completion.response.status, 200, completion.text);
  assert.equal(completion.json.mapHash, attempt.json.mapHash);
  assert.match(completion.json.publishTicket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(completion.json.verifiedClear.totalTicks, VALID_REPLAY.totalTicks);
  assert.equal(completion.json.verifiedClear.engineVersion, VALID_REPLAY.engineVersion);

  const repeatedCompletion = await api(baseUrl, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OWNER_TOKEN, body: {},
  });
  assert.equal(repeatedCompletion.json.publishTicket, completion.json.publishTicket);

  const changedMap = structuredClone(map);
  changedMap.grid[5][5] = 1;
  const changedPublish = await api(baseUrl, '/api/maps', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: {
      map: changedMap,
      title: '바뀐 맵',
      author: '테스터',
      publishTicket: completion.json.publishTicket,
    },
  });
  assert.equal(changedPublish.response.status, 409);
  assert.equal(changedPublish.json.error.code, 'TICKET_MAP_MISMATCH');

  const wrongOwnerPublish = await api(baseUrl, '/api/maps', {
    method: 'POST',
    token: OTHER_TOKEN,
    body: {
      map,
      title: '훔친 맵',
      author: '다른 사람',
      publishTicket: completion.json.publishTicket,
    },
  });
  assert.equal(wrongOwnerPublish.response.status, 403);
  assert.equal(wrongOwnerPublish.json.error.code, 'TICKET_OWNER_MISMATCH');

  const publish = await api(baseUrl, '/api/maps', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: {
      map,
      title: ' <b>멋진</b>   맵 ',
      author: ' 펭귄\n왕 ',
      publishTicket: completion.json.publishTicket,
    },
  });
  assert.equal(publish.response.status, 201, publish.text);
  assert.equal(publish.json.map.title, '멋진 맵');
  assert.equal(publish.json.map.author, '펭귄 왕');
  assert.deepEqual(publish.json.map.map, map);

  const reuse = await api(baseUrl, '/api/maps', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: {
      map,
      title: '복제 맵',
      author: '테스터',
      publishTicket: completion.json.publishTicket,
    },
  });
  assert.equal(reuse.response.status, 409);
  assert.equal(reuse.json.error.code, 'PUBLISH_TICKET_USED');

  const [ticketPayload, ticketSignature] = completion.json.publishTicket.split('.');
  const tamperedSignature = `${ticketSignature[0] === 'x' ? 'y' : 'x'}${ticketSignature.slice(1)}`;
  const tamperedTicket = `${ticketPayload}.${tamperedSignature}`;
  const tampered = await api(baseUrl, '/api/maps', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: { map, title: '위조', author: '위조', publishTicket: tamperedTicket },
  });
  assert.equal(tampered.response.status, 401);
  assert.equal(tampered.json.error.code, 'INVALID_PUBLISH_TICKET');
});

test('map validation rejects malformed grids, blocked spawn/exit, and missing owner token', async (t) => {
  const { baseUrl } = await startFixture(t);
  const valid = makeMap();

  const noToken = await api(baseUrl, '/api/attempts', { method: 'POST', body: { map: valid } });
  assert.equal(noToken.response.status, 401);
  assert.equal(noToken.json.error.code, 'AUTHOR_TOKEN_REQUIRED');

  const shortGrid = structuredClone(valid);
  shortGrid.grid.pop();
  const badRows = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map: shortGrid },
  });
  assert.equal(badRows.response.status, 400);
  assert.equal(badRows.json.error.code, 'INVALID_GRID');

  const badTile = structuredClone(valid);
  badTile.grid[3][4] = 1.5;
  const badValue = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map: badTile },
  });
  assert.equal(badValue.response.status, 400);
  assert.equal(badValue.json.error.code, 'INVALID_TILE');

  const blockedSpawn = structuredClone(valid);
  blockedSpawn.grid[blockedSpawn.spawn.r][blockedSpawn.spawn.c] = 1;
  const spawnResponse = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map: blockedSpawn },
  });
  assert.equal(spawnResponse.response.status, 400);
  assert.equal(spawnResponse.json.error.code, 'BLOCKED_SPAWN');

  const blockedExit = structuredClone(valid);
  blockedExit.grid[blockedExit.exitRow][19] = 1;
  const exitResponse = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map: blockedExit },
  });
  assert.equal(exitResponse.response.status, 400);
  assert.equal(exitResponse.json.error.code, 'BLOCKED_EXIT');

  const extraExit = structuredClone(valid);
  extraExit.grid[4][19] = 0;
  const extraExitResponse = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map: extraExit },
  });
  assert.equal(extraExitResponse.response.status, 400);
  assert.equal(extraExitResponse.json.error.code, 'MULTIPLE_EXITS');

  const edgeSpawn = structuredClone(valid);
  edgeSpawn.spawn = { c: 19, r: edgeSpawn.exitRow };
  const edgeSpawnResponse = await api(baseUrl, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map: edgeSpawn },
  });
  assert.equal(edgeSpawnResponse.response.status, 400);
  assert.equal(edgeSpawnResponse.json.error.code, 'INVALID_SPAWN');

  const tooLarge = await api(baseUrl, '/api/attempts', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: JSON.stringify({ padding: 'x'.repeat(50 * 1024) }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.json.error.code, 'BODY_TOO_LARGE');
});

test('published maps can be searched, counted concurrently, and loaded after restart', async (t) => {
  const fixture = await startFixture(t);
  const { baseUrl, server, dataFile, publicDirectory } = fixture;
  const map = makeMap();
  const { published } = await publishMap(baseUrl, map, {
    title: '얼음 협곡',
    author: '바운서',
  });
  const id = published.json.map.id;

  const list = await api(baseUrl, '/api/maps?q=협곡&sort=popular&page=1&limit=5');
  assert.equal(list.response.status, 200);
  assert.equal(list.json.pagination.total, 1);
  assert.equal(list.json.maps[0].id, id);
  assert.equal('map' in list.json.maps[0], false, 'list endpoint should return compact metadata');

  const noResult = await api(baseUrl, '/api/maps?search=없는맵');
  assert.equal(noResult.json.pagination.total, 0);
  assert.equal(noResult.json.pagination.totalPages, 0);

  const invalidSort = await api(baseUrl, '/api/maps?sort=magic');
  assert.equal(invalidSort.response.status, 400);
  assert.equal(invalidSort.json.error.code, 'INVALID_SORT');

  const detail = await api(baseUrl, `/api/maps/${encodeURIComponent(id)}`);
  assert.equal(detail.response.status, 200);
  assert.deepEqual(detail.json.map.map, map);

  const playUpdates = await Promise.all(Array.from({ length: 8 }, () => (
    api(baseUrl, `/api/maps/${id}/play`, { method: 'POST', body: {} })
  )));
  assert.ok(playUpdates.every((result) => result.response.status === 200));
  const clearUpdates = await Promise.all(Array.from({ length: 3 }, () => (
    api(baseUrl, `/api/maps/${id}/clear`, { method: 'POST', body: {} })
  )));
  assert.ok(clearUpdates.every((result) => result.response.status === 200));

  const counted = await api(baseUrl, `/api/maps/${id}`);
  assert.equal(counted.json.map.plays, 8);
  assert.equal(counted.json.map.clears, 3);

  const persistedRaw = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(persistedRaw.maps[0].plays, 8);
  assert.equal(persistedRaw.maps[0].clears, 3);

  await new Promise((accept) => server.close(accept));
  const restarted = await createBounceServer({ dataFile, publicDirectory, publishSecret: TEST_SECRET });
  await new Promise((accept, reject) => {
    restarted.once('error', reject);
    restarted.listen(0, '127.0.0.1', accept);
  });
  t.after(async () => {
    if (restarted.listening) await new Promise((accept) => restarted.close(accept));
  });
  const restartedUrl = `http://127.0.0.1:${restarted.address().port}`;
  const afterRestart = await api(restartedUrl, `/api/maps/${id}`);
  assert.equal(afterRestart.response.status, 200, afterRestart.text);
  assert.equal(afterRestart.json.map.plays, 8);
  assert.deepEqual(afterRestart.json.map.map, map);
});
