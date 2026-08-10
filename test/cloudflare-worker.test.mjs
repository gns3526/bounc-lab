import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker, { __testing } from '../cloudflare/worker.mjs';

const OWNER_TOKEN = 'owner-token-with-more-than-16-characters';
const OTHER_TOKEN = 'different-owner-token-more-than-16-chars';
const PUBLISH_SECRET = 'worker-test-publish-secret-at-least-32-bytes';
const MODERATION_TOKEN = 'worker-test-moderation-token-at-least-32-bytes';
const VALID_REPLAY = Object.freeze({
  version: 1,
  engineVersion: 'bounce-physics-v1',
  totalTicks: 344,
  events: [[0, 1]],
});

class D1PreparedMock {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1PreparedMock(this.database, this.sql, values);
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.values);
    if (column !== undefined) return row?.[column] ?? null;
    return row ?? null;
  }

  async all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.values),
      meta: {},
    };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }
}

class D1DatabaseMock {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1PreparedMock(this.database, sql);
  }

  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class RateLimiterMock {
  constructor(limit = 10_000) {
    this.limitValue = limit;
    this.counts = new Map();
    this.keys = [];
  }

  async limit({ key }) {
    this.keys.push(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { success: count <= this.limitValue };
  }
}

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

async function fixture(t, overrides = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(await readFile(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const generalRateLimiter = new RateLimiterMock();
  const writeRateLimiter = new RateLimiterMock();
  const env = {
    DB: new D1DatabaseMock(database),
    PUBLISH_SECRET,
    MODERATION_TOKEN,
    ENVIRONMENT: 'production',
    TOSS_APP_NAME: 'penguin-bounce',
    ALLOWED_ORIGINS: 'https://localhost',
    GENERAL_RATE_LIMITER: generalRateLimiter,
    WRITE_RATE_LIMITER: writeRateLimiter,
    REPORT_RATE_LIMIT: '10000',
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, {
          headers: { 'Content-Type': 'text/plain' },
        });
      },
    },
    ...overrides,
  };
  t.after(() => database.close());
  return {
    database,
    env,
    generalRateLimiter: env.GENERAL_RATE_LIMITER,
    writeRateLimiter: env.WRITE_RATE_LIMITER,
  };
}

async function requestApi(env, path, {
  method = 'GET', token, moderationToken, body, headers = {}, address = '203.0.113.10',
} = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('X-Author-Token', token);
  if (moderationToken) requestHeaders.set('X-Moderation-Token', moderationToken);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  requestHeaders.set('CF-Connecting-IP', address);
  const pending = [];
  const response = await worker.fetch(new Request(`https://penguin-bounce.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* Static and empty responses are not JSON. */ }
  return { response, json, text };
}

async function createCompletedAttempt(env, map, token = OWNER_TOKEN) {
  const attempt = await requestApi(env, '/api/attempts', {
    method: 'POST', token, body: { map },
  });
  assert.equal(attempt.response.status, 201, attempt.text);
  const complete = await requestApi(env, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token, body: { replay: VALID_REPLAY },
  });
  assert.equal(complete.response.status, 200, complete.text);
  return { attempt, complete };
}

async function publishMap(env, map, {
  token = OWNER_TOKEN, title = '빙하 협곡', author = '펭귄 제작자',
} = {}) {
  const completed = await createCompletedAttempt(env, map, token);
  const published = await requestApi(env, '/api/maps', {
    method: 'POST',
    token,
    body: {
      map,
      title,
      author,
      publishTicket: completed.complete.json.publishTicket,
      termsVersion: __testing.COMMUNITY_TERMS_VERSION,
    },
  });
  assert.equal(published.response.status, 201, published.text);
  return { ...completed, published };
}

test('Cloudflare Worker serves assets, health and strict CORS responses', async (t) => {
  const { env } = await fixture(t);
  const asset = await requestApi(env, '/terms.html');
  assert.equal(asset.response.status, 200);
  assert.equal(asset.text, 'asset:/terms.html');

  const health = await requestApi(env, '/api/health', {
    headers: { Origin: 'https://localhost' },
  });
  assert.equal(health.response.status, 200, health.text);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.mapCount, 0);
  assert.equal(health.json.storage, 'cloudflare-d1');
  assert.equal(health.response.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');

  const preflight = await requestApi(env, '/api/attempts', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://penguin-bounce.web.tossmini.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, X-Author-Token',
    },
  });
  assert.equal(preflight.response.status, 204, preflight.text);

  const denied = await requestApi(env, '/api/health', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.json.error.code, 'CORS_ORIGIN_DENIED');
});

test('D1 flow verifies a replay, enforces terms and publishes a ticket only once', async (t) => {
  const { database, env } = await fixture(t);
  const map = makeMap();
  const attempt = await requestApi(env, '/api/attempts', {
    method: 'POST', token: OWNER_TOKEN, body: { map },
  });
  assert.equal(attempt.response.status, 201, attempt.text);

  const wrongOwner = await requestApi(env, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OTHER_TOKEN, body: { replay: VALID_REPLAY },
  });
  assert.equal(wrongOwner.response.status, 403);
  assert.equal(wrongOwner.json.error.code, 'ATTEMPT_OWNER_MISMATCH');

  const tooLong = await requestApi(env, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST',
    token: OWNER_TOKEN,
    body: {
      replay: {
        version: 1,
        engineVersion: 'bounce-physics-v1',
        totalTicks: __testing.WORKER_MAX_REPLAY_TICKS + 1,
        events: [[0, 1]],
      },
    },
  });
  assert.equal(tooLong.response.status, 422);
  assert.equal(tooLong.json.error.details.proof.maxSeconds, 60);

  const complete = await requestApi(env, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OWNER_TOKEN, body: { replay: VALID_REPLAY },
  });
  assert.equal(complete.response.status, 200, complete.text);
  const repeatComplete = await requestApi(env, `/api/attempts/${attempt.json.attemptId}/complete`, {
    method: 'POST', token: OWNER_TOKEN, body: { replay: VALID_REPLAY },
  });
  assert.equal(repeatComplete.json.publishTicket, complete.json.publishTicket);

  const missingTerms = await requestApi(env, '/api/maps', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: { map, title: '맵', author: '작성자', publishTicket: complete.json.publishTicket },
  });
  assert.equal(missingTerms.response.status, 400);
  assert.equal(missingTerms.json.error.details.termsVersion, __testing.COMMUNITY_TERMS_VERSION);

  const publishBody = {
    map,
    title: '<b>빙하 협곡</b>',
    author: '펭귄 제작자',
    publishTicket: complete.json.publishTicket,
    termsVersion: __testing.COMMUNITY_TERMS_VERSION,
  };
  const published = await requestApi(env, '/api/maps', {
    method: 'POST', token: OWNER_TOKEN, body: publishBody,
  });
  assert.equal(published.response.status, 201, published.text);
  assert.equal(published.json.map.title, '빙하 협곡');
  assert.equal('ownerHash' in published.json.map, false);
  assert.match(published.json.map.authorId, /^[A-Za-z0-9_-]{22}$/);

  const reuse = await requestApi(env, '/api/maps', {
    method: 'POST', token: OWNER_TOKEN, body: publishBody,
  });
  assert.equal(reuse.response.status, 409);
  assert.equal(reuse.json.error.code, 'PUBLISH_TICKET_USED');

  const stored = database.prepare('SELECT owner_hash FROM maps').get();
  assert.match(stored.owner_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.owner_hash, OWNER_TOKEN);
  assert.equal(env.GENERAL_RATE_LIMITER.keys.some((key) => key.includes('203.0.113.10')), false);
  assert.ok(env.GENERAL_RATE_LIMITER.keys.every((key) => /^[a-f0-9]{64}$/.test(key)));
});

test('map list, counters, reports, owner deletion and author moderation retain the Node API contract', async (t) => {
  const { database, env } = await fixture(t);
  const map = makeMap();
  const first = await publishMap(env, map, { title: '빙하 협곡 첫째' });
  const second = await publishMap(env, map, { title: '빙하 협곡 둘째' });
  const firstMap = first.published.json.map;
  const secondMap = second.published.json.map;
  assert.equal(firstMap.authorId, secondMap.authorId);

  const list = await requestApi(env, '/api/maps?q=협곡&sort=newest&page=1&limit=5');
  assert.equal(list.response.status, 200, list.text);
  assert.equal(list.json.pagination.total, 2);
  assert.equal('map' in list.json.maps[0], false);

  const longSearch = await requestApi(env, `/api/maps?q=${encodeURIComponent('가'.repeat(100))}`);
  assert.equal(longSearch.response.status, 200, longSearch.text);
  assert.equal(longSearch.json.pagination.total, 0);

  const play = await requestApi(env, `/api/maps/${secondMap.id}/play`, { method: 'POST', body: {} });
  const clear = await requestApi(env, `/api/maps/${secondMap.id}/clear`, { method: 'POST', body: {} });
  assert.equal(play.json.plays, 1);
  assert.equal(clear.json.clears, 1);

  const wrongDelete = await requestApi(env, `/api/maps/${firstMap.id}/delete`, {
    method: 'POST', token: OTHER_TOKEN, body: {},
  });
  assert.equal(wrongDelete.response.status, 403);
  const deleted = await requestApi(env, `/api/maps/${firstMap.id}/delete`, {
    method: 'POST', token: OWNER_TOKEN, body: {},
  });
  assert.equal(deleted.response.status, 200, deleted.text);
  assert.equal(deleted.json.deleted, true);

  const report = await requestApi(env, `/api/maps/${secondMap.id}/report`, {
    method: 'POST', token: OTHER_TOKEN, body: { scope: 'author', reason: 'spam' },
  });
  assert.equal(report.response.status, 201, report.text);
  assert.equal('reporterId' in report.json.report, false);
  const reportKeys = database.prepare(
    "SELECT key FROM rate_limits WHERE key LIKE 'report%' ORDER BY key",
  ).all().map((row) => row.key);
  assert.equal(reportKeys.length, 2);
  assert.equal(reportKeys.some((key) => key.includes('203.0.113.10')), false);
  const duplicate = await requestApi(env, `/api/maps/${secondMap.id}/report`, {
    method: 'POST', token: OTHER_TOKEN, body: { scope: 'author', reason: 'spam' },
  });
  assert.equal(duplicate.response.status, 200, duplicate.text);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.report.id, report.json.report.id);

  const unauthorizedQueue = await requestApi(env, '/api/moderation/reports');
  assert.equal(unauthorizedQueue.response.status, 401);
  const queue = await requestApi(env, '/api/moderation/reports?status=open', {
    moderationToken: MODERATION_TOKEN,
  });
  assert.equal(queue.response.status, 200, queue.text);
  assert.equal(queue.json.reports.length, 1);
  assert.equal('reporterId' in queue.json.reports[0], false);

  const moderated = await requestApi(env, `/api/moderation/reports/${report.json.report.id}`, {
    method: 'POST', moderationToken: MODERATION_TOKEN, body: { action: 'hide_author' },
  });
  assert.equal(moderated.response.status, 200, moderated.text);
  assert.deepEqual(moderated.json.affectedMapIds, [secondMap.id]);
  const hidden = await requestApi(env, `/api/maps/${secondMap.id}`);
  assert.equal(hidden.response.status, 404);

  const blockedAttempt = await createCompletedAttempt(env, map, OWNER_TOKEN);
  const blockedPublish = await requestApi(env, '/api/maps', {
    method: 'POST',
    token: OWNER_TOKEN,
    body: {
      map,
      title: '차단 뒤 재게시',
      author: '펭귄 제작자',
      publishTicket: blockedAttempt.complete.json.publishTicket,
      termsVersion: __testing.COMMUNITY_TERMS_VERSION,
    },
  });
  assert.equal(blockedPublish.response.status, 403);
  assert.equal(blockedPublish.json.error.code, 'AUTHOR_PUBLISH_BLOCKED');
});

test('binding rate limiting is shared and expired D1 data cleanup is scheduled', async (t) => {
  const { database, env } = await fixture(t, { GENERAL_RATE_LIMITER: new RateLimiterMock(1) });
  const first = await requestApi(env, '/api/health', { address: '198.51.100.9' });
  assert.equal(first.response.status, 200, first.text);
  const limited = await requestApi(env, '/api/health', { address: '198.51.100.9' });
  assert.equal(limited.response.status, 429, limited.text);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);

  database.prepare(`
    INSERT INTO attempts (id, owner_hash, map_hash, map_json, created_at, expires_at)
    VALUES ('expired', 'owner', 'map', '{}', 1, 2)
  `).run();
  const pending = [];
  await worker.scheduled({ scheduledTime: 3 }, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM attempts WHERE id = 'expired'").get().count, 0);
});
