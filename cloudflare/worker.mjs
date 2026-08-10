import { MAX_REPLAY_TICKS, spawnHasClearance, verifyCompletionReplay } from '../physics-proof.mjs';

const MAX_BODY_BYTES = 48 * 1024;
const ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_TTL_MS = 20 * 60 * 1000;
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 256;
const GRID_ROWS = 15;
const GRID_COLUMNS = 20;
const WORKER_MAX_REPLAY_TICKS = MAX_REPLAY_TICKS;
const COMMUNITY_TERMS_VERSION = '2026-08-10-v1';
const REPORT_SCOPES = Object.freeze(['map', 'author']);
const REPORT_REASONS = Object.freeze([
  'abuse',
  'hate',
  'sexual',
  'violence',
  'personal_info',
  'spam',
  'illegal',
  'copyright',
  'other',
]);
const MODERATION_ACTIONS = Object.freeze([
  'dismiss',
  'hide_map',
  'hide_author',
  'delete_map',
  'delete_author',
]);
const CORS_ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'OPTIONS']);
const CORS_ALLOWED_HEADERS = Object.freeze(['Accept', 'Content-Type', 'X-Author-Token']);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
}

function jsonResponse(status, payload, corsHeaders = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function errorResponse(error, corsHeaders = {}) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const payload = {
    ok: false,
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '서버에서 요청을 처리하지 못했습니다.',
    },
  };
  if (known && error.details !== undefined) payload.error.details = error.details;
  if (!known) console.error('Unhandled Worker API error', error);
  return jsonResponse(status, payload, corsHeaders);
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeConfiguredOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid CORS origin: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.origin === 'null') {
    throw new Error(`CORS origin must be an http(s) origin without a path: ${value}`);
  }
  return parsed.origin;
}

function isLocalDevelopmentOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function createCorsHeaders(request, env, requestUrl) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  let normalized;
  try {
    normalized = normalizeConfiguredOrigin(origin);
  } catch {
    throw new ApiError(403, 'CORS_ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  }

  const allowed = new Set([requestUrl.origin]);
  const tossAppName = String(env.TOSS_APP_NAME ?? '').trim().toLowerCase();
  if (tossAppName) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tossAppName)) {
      throw new Error('TOSS_APP_NAME must be a valid DNS label');
    }
    allowed.add(`https://${tossAppName}.web.tossmini.com`);
    allowed.add(`https://${tossAppName}.private-web.tossmini.com`);
  }
  for (const entry of String(env.ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed) allowed.add(normalizeConfiguredOrigin(trimmed));
  }
  const development = String(env.ENVIRONMENT ?? 'production').toLowerCase() !== 'production';
  if (!allowed.has(normalized) && !(development && isLocalDevelopmentOrigin(normalized))) {
    throw new ApiError(403, 'CORS_ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  }
  return {
    'Access-Control-Allow-Origin': normalized,
    Vary: 'Origin',
  };
}

function preflightResponse(request, corsHeaders) {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (!requestedMethod || !CORS_ALLOWED_METHODS.includes(requestedMethod.toUpperCase())) {
    throw new ApiError(405, 'CORS_METHOD_DENIED', '허용되지 않은 CORS 요청 방식입니다.');
  }
  const allowedHeaders = new Set(CORS_ALLOWED_HEADERS.map((value) => value.toLowerCase()));
  const requestedHeaders = String(request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (requestedHeaders.some((value) => !allowedHeaders.has(value))) {
    throw new ApiError(400, 'CORS_HEADERS_DENIED', '허용되지 않은 CORS 요청 헤더입니다.');
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...securityHeaders('text/plain; charset=utf-8'),
      ...corsHeaders,
      'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS.join(', '),
      'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS.join(', '),
      'Access-Control-Max-Age': '600',
      Vary: [corsHeaders.Vary, 'Access-Control-Request-Method', 'Access-Control-Request-Headers']
        .filter(Boolean).join(', '),
    },
  });
}

function validateSecret(value, name) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a 32-512 character secret`);
  }
  return value;
}

function validateBindings(env) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') throw new Error('D1 binding DB is required');
  if (!env?.GENERAL_RATE_LIMITER || typeof env.GENERAL_RATE_LIMITER.limit !== 'function') {
    throw new Error('Rate limiting binding GENERAL_RATE_LIMITER is required');
  }
  if (!env?.WRITE_RATE_LIMITER || typeof env.WRITE_RATE_LIMITER.limit !== 'function') {
    throw new Error('Rate limiting binding WRITE_RATE_LIMITER is required');
  }
  validateSecret(env.PUBLISH_SECRET, 'PUBLISH_SECRET');
  validateSecret(env.MODERATION_TOKEN, 'MODERATION_TOKEN');
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, 'BODY_TOO_LARGE', '요청 데이터가 너무 큽니다.');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, 'BODY_TOO_LARGE', '요청 데이터가 너무 큽니다.');
  }
  if (bytes.byteLength === 0) return {};
  try {
    const parsed = JSON.parse(textDecoder.decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '올바른 JSON 객체를 보내주세요.');
  }
}

function sanitizeText(value, { field, maxLength, fallback = '' }) {
  if (value === undefined || value === null) value = fallback;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_TEXT', `${field}은(는) 문자열이어야 합니다.`);
  }
  const sanitized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = [...sanitized].slice(0, maxLength).join('').trim();
  if (!clipped) throw new ApiError(400, 'EMPTY_TEXT', `${field}을(를) 입력해주세요.`);
  return clipped;
}

function sanitizeOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_TEXT', '신고 설명은 문자열이어야 합니다.');
  }
  return [...value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()].slice(0, maxLength).join('').trim();
}

function canonicalizeMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'INVALID_MAP', '맵 데이터가 필요합니다.');
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new ApiError(400, 'UNSUPPORTED_MAP_VERSION', '지원하지 않는 맵 버전입니다.');
  }
  if (!Array.isArray(input.grid) || input.grid.length !== GRID_ROWS) {
    throw new ApiError(400, 'INVALID_GRID', `grid는 정확히 ${GRID_ROWS}줄이어야 합니다.`);
  }
  const grid = input.grid.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== GRID_COLUMNS) {
      throw new ApiError(400, 'INVALID_GRID', `grid의 ${rowIndex + 1}줄은 정확히 ${GRID_COLUMNS}칸이어야 합니다.`);
    }
    return row.map((tile, columnIndex) => {
      if (!Number.isInteger(tile) || tile < 0 || tile > 6) {
        throw new ApiError(400, 'INVALID_TILE', '타일 값은 0부터 6까지의 정수여야 합니다.', {
          row: rowIndex,
          column: columnIndex,
        });
      }
      return tile;
    });
  });
  const spawn = input.spawn;
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)
    || !Number.isInteger(spawn.c) || !Number.isInteger(spawn.r)
    || spawn.c < 0 || spawn.c >= GRID_COLUMNS - 1 || spawn.r < 0 || spawn.r >= GRID_ROWS) {
    throw new ApiError(400, 'INVALID_SPAWN', '시작점이 맵 범위를 벗어났습니다.');
  }
  if (grid[spawn.r][spawn.c] !== 0) {
    throw new ApiError(400, 'BLOCKED_SPAWN', '시작점은 빈칸에 있어야 합니다.');
  }
  if (!Number.isInteger(input.exitRow) || input.exitRow < 0 || input.exitRow >= GRID_ROWS) {
    throw new ApiError(400, 'INVALID_EXIT', '출구 줄이 맵 범위를 벗어났습니다.');
  }
  if (grid[input.exitRow][GRID_COLUMNS - 1] !== 0) {
    throw new ApiError(400, 'BLOCKED_EXIT', '출구는 오른쪽 끝의 빈칸이어야 합니다.');
  }
  for (let row = 0; row < GRID_ROWS; row += 1) {
    if (row !== input.exitRow && grid[row][GRID_COLUMNS - 1] === 0) {
      throw new ApiError(400, 'MULTIPLE_EXITS', '오른쪽 끝에는 지정한 출구 하나만 있어야 합니다.', { row });
    }
  }
  const map = { version: 1, grid, spawn: { c: spawn.c, r: spawn.r }, exitRow: input.exitRow };
  if (!spawnHasClearance(map)) {
    throw new ApiError(400, 'BLOCKED_SPAWN_CLEARANCE', '시작점의 캐릭터 충돌 범위가 타일과 겹칩니다.');
  }
  return map;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)));
}

async function sha256Hex(value) {
  return bytesToHex(await sha256Bytes(value));
}

async function hashOwnerToken(token) {
  return sha256Hex(`bounce-owner-v1\0${token}`);
}

async function publicAuthorId(ownerHash) {
  return bytesToBase64Url(await sha256Bytes(`bounce-public-author-v1\0${ownerHash}`)).slice(0, 22);
}

async function calculateMapHash(map) {
  return sha256Hex(JSON.stringify(map));
}

async function hmacBytes(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value)));
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function randomId(prefix, byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64Url(bytes)}`;
}

async function signTicket(payload, secret) {
  const encoded = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmacBytes(secret, encoded));
  return `${encoded}.${signature}`;
}

async function verifyTicket(ticket, secret, now) {
  if (typeof ticket !== 'string' || ticket.length > 4096) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓이 올바르지 않습니다.');
  }
  const segments = ticket.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓이 올바르지 않습니다.');
  }
  let supplied;
  try {
    supplied = base64UrlToBytes(segments[1]);
  } catch {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓이 올바르지 않습니다.');
  }
  const expected = await hmacBytes(secret, segments[0]);
  if (!constantTimeEqual(supplied, expected)) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓 서명이 올바르지 않습니다.');
  }
  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(base64UrlToBytes(segments[0])));
  } catch {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓 내용이 올바르지 않습니다.');
  }
  if (!payload || payload.v !== 1 || typeof payload.jti !== 'string'
    || typeof payload.attemptId !== 'string' || typeof payload.mapHash !== 'string'
    || typeof payload.ownerHash !== 'string' || !Number.isFinite(payload.exp)) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓 내용이 올바르지 않습니다.');
  }
  if (payload.exp <= now) {
    throw new ApiError(410, 'PUBLISH_TICKET_EXPIRED', '게시 티켓이 만료되었습니다. 맵을 다시 클리어해주세요.');
  }
  return payload;
}

function authorTokenFrom(request, body) {
  const header = request.headers.get('X-Author-Token');
  if (header !== null && body?.authorToken !== undefined && header !== body.authorToken) {
    throw new ApiError(400, 'TOKEN_MISMATCH', '헤더와 본문의 작성자 토큰이 서로 다릅니다.');
  }
  const token = header ?? body?.authorToken;
  if (typeof token !== 'string' || token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new ApiError(401, 'AUTHOR_TOKEN_REQUIRED', `작성자 토큰은 ${TOKEN_MIN_LENGTH}~${TOKEN_MAX_LENGTH}자의 문자열이어야 합니다.`);
  }
  return token;
}

async function requireModerationToken(request, expected) {
  const supplied = request.headers.get('X-Moderation-Token');
  if (typeof supplied !== 'string' || supplied.length > 512) {
    throw new ApiError(401, 'MODERATION_AUTH_REQUIRED', '운영자 인증이 필요합니다.');
  }
  const [left, right] = await Promise.all([sha256Bytes(supplied), sha256Bytes(expected)]);
  if (!constantTimeEqual(left, right)) {
    throw new ApiError(403, 'MODERATION_AUTH_DENIED', '운영자 인증이 올바르지 않습니다.');
  }
}

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch {
    throw new ApiError(400, 'INVALID_PATH', '요청 경로가 올바르지 않습니다.');
  }
}

function publicMapRecord(row, includeMap = true) {
  const result = {
    id: row.id,
    title: row.title,
    author: row.author,
    authorId: row.author_id,
    mapHash: row.map_hash,
    createdAt: row.created_at,
    plays: Number(row.plays),
    clears: Number(row.clears),
  };
  if (includeMap) result.map = JSON.parse(row.map_json);
  return result;
}

function publicReportRecord(row) {
  return {
    id: row.id,
    mapId: row.map_id,
    mapTitle: row.map_title ?? '삭제된 맵',
    author: row.map_author ?? '',
    authorId: row.author_id,
    scope: row.scope,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

function requestAddress(request) {
  const cloudflareAddress = request.headers.get('CF-Connecting-IP');
  if (cloudflareAddress && cloudflareAddress.length <= 128) return cloudflareAddress;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded && forwarded.length <= 1024) return forwarded.split(',').at(-1)?.trim() || 'unknown';
  return 'unknown';
}

async function persistentRateLimit(db, key, limit, windowMs, now) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const expiresAt = windowStart + windowMs;
  const row = await db.prepare(`
    INSERT INTO rate_limits (key, window_start, count, expires_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      window_start = CASE WHEN rate_limits.expires_at <= excluded.window_start THEN excluded.window_start ELSE rate_limits.window_start END,
      count = CASE WHEN rate_limits.expires_at <= excluded.window_start THEN 1 ELSE rate_limits.count + 1 END,
      expires_at = CASE WHEN rate_limits.expires_at <= excluded.window_start THEN excluded.expires_at ELSE rate_limits.expires_at END
    RETURNING count, expires_at
  `).bind(key, windowStart, expiresAt).first();
  const count = Number(row?.count ?? limit + 1);
  const reset = Number(row?.expires_at ?? expiresAt);
  return {
    allowed: count <= limit,
    retryAfter: Math.max(1, Math.ceil((reset - now) / 1000)),
  };
}

function limitedResponse(result, corsHeaders) {
  return jsonResponse(429, {
    ok: false,
    error: { code: 'RATE_LIMITED', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  }, corsHeaders, { 'Retry-After': String(result.retryAfter) });
}

async function bindingRateLimit(binding, key, retryAfter = 60) {
  const result = await binding.limit({ key });
  return { allowed: result?.success === true, retryAfter };
}

function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR').slice(0, 100);
}

async function getMap(db, id) {
  return db.prepare('SELECT * FROM maps WHERE id = ?').bind(id).first();
}

async function handleHealth(env, now, corsHeaders) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM maps WHERE status = 'active'").first();
  return jsonResponse(200, {
    ok: true,
    status: 'ok',
    service: 'bounce-map-api',
    storage: 'cloudflare-d1',
    mapCount: Number(row?.count ?? 0),
    now: new Date(now).toISOString(),
  }, corsHeaders);
}

async function handleMapList(env, url, corsHeaders) {
  const page = safeInteger(url.searchParams.get('page'), 1, 1, 1_000_000);
  const limit = safeInteger(url.searchParams.get('limit'), 12, 1, 50);
  const query = normalizeSearch(url.searchParams.get('q') || url.searchParams.get('search') || '');
  const sort = url.searchParams.get('sort') || 'newest';
  const orderBy = {
    newest: 'created_at DESC, id DESC',
    oldest: 'created_at ASC, id ASC',
    popular: '((clears * 3) + plays) DESC, created_at DESC',
    plays: 'plays DESC, created_at DESC',
    clears: 'clears DESC, created_at DESC',
  }[sort];
  if (!orderBy) {
    throw new ApiError(400, 'INVALID_SORT', 'sort는 newest, oldest, popular, plays, clears 중 하나여야 합니다.');
  }
  // D1 limits LIKE/GLOB patterns to 50 bytes. instr() supports the full validated query safely.
  const where = query ? "status = 'active' AND instr(search_text, ?) > 0" : "status = 'active'";
  const bindings = query ? [query] : [];
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM maps WHERE ${where}`)
    .bind(...bindings).first();
  const result = await env.DB.prepare(`
    SELECT id, title, author, author_id, map_hash, created_at, plays, clears
    FROM maps WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).bind(...bindings, limit, (page - 1) * limit).all();
  const total = Number(totalRow?.count ?? 0);
  return jsonResponse(200, {
    ok: true,
    maps: (result.results ?? []).map((row) => publicMapRecord(row, false)),
    pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
    query: { search: query, sort },
  }, corsHeaders);
}

async function handleMapDetail(env, id, corsHeaders) {
  const row = await getMap(env.DB, id);
  if (!row || row.status !== 'active') throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
  return jsonResponse(200, { ok: true, map: publicMapRecord(row, true) }, corsHeaders);
}

async function handleAttemptCreate(request, env, now, corsHeaders) {
  const body = await readJsonBody(request);
  const token = authorTokenFrom(request, body);
  const map = canonicalizeMap(body.map ?? body);
  const [ownerHash, mapHash] = await Promise.all([hashOwnerToken(token), calculateMapHash(map)]);
  const attemptId = randomId('', 18);
  const expiresAt = now + ATTEMPT_TTL_MS;
  await env.DB.prepare(`
    INSERT INTO attempts (id, owner_hash, map_hash, map_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(attemptId, ownerHash, mapHash, JSON.stringify(map), now, expiresAt).run();
  return jsonResponse(201, {
    ok: true,
    attemptId,
    mapHash,
    expiresAt: new Date(expiresAt).toISOString(),
  }, corsHeaders);
}

async function handleAttemptComplete(request, env, id, now, corsHeaders) {
  const body = await readJsonBody(request);
  const token = authorTokenFrom(request, body);
  let attempt = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first();
  if (!attempt) throw new ApiError(404, 'ATTEMPT_NOT_FOUND', '도전 기록을 찾을 수 없습니다.');
  if (Number(attempt.expires_at) <= now) {
    await env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(id).run();
    throw new ApiError(410, 'ATTEMPT_EXPIRED', '도전 기록이 만료되었습니다. 다시 테스트해주세요.');
  }
  if (attempt.owner_hash !== await hashOwnerToken(token)) {
    throw new ApiError(403, 'ATTEMPT_OWNER_MISMATCH', '이 도전을 시작한 작성자만 완료할 수 있습니다.');
  }
  if (!attempt.publish_ticket) {
    if (Number.isInteger(body.replay?.totalTicks) && body.replay.totalTicks > WORKER_MAX_REPLAY_TICKS) {
      throw new ApiError(422, 'INVALID_CLEAR_PROOF', '무료 온라인 게시 검증은 최대 1분 리플레이를 지원합니다.', {
        reason: 'INVALID_REPLAY_LENGTH',
        proof: { maxTicks: WORKER_MAX_REPLAY_TICKS, maxSeconds: WORKER_MAX_REPLAY_TICKS / 120 },
      });
    }
    const proof = verifyCompletionReplay(JSON.parse(attempt.map_json), body.replay);
    if (!proof.ok) {
      throw new ApiError(422, 'INVALID_CLEAR_PROOF', proof.message, {
        reason: proof.code,
        ...(proof.details === undefined ? {} : { proof: proof.details }),
      });
    }
    const clearProof = {
      engineVersion: proof.engineVersion,
      totalTicks: proof.totalTicks,
      time: proof.time,
      bounds: proof.bounds,
    };
    const ticketExpiresAt = now + TICKET_TTL_MS;
    const payload = {
      v: 1,
      jti: randomId('', 18),
      attemptId: id,
      mapHash: attempt.map_hash,
      ownerHash: attempt.owner_hash,
      engineVersion: proof.engineVersion,
      replayTicks: proof.totalTicks,
      iat: now,
      exp: ticketExpiresAt,
    };
    const ticket = await signTicket(payload, env.PUBLISH_SECRET);
    await env.DB.prepare(`
      UPDATE attempts SET publish_ticket = ?, ticket_expires_at = ?, clear_proof_json = ?
      WHERE id = ? AND publish_ticket IS NULL
    `).bind(ticket, ticketExpiresAt, JSON.stringify(clearProof), id).run();
    attempt = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first();
  }
  return jsonResponse(200, {
    ok: true,
    publishTicket: attempt.publish_ticket,
    mapHash: attempt.map_hash,
    verifiedClear: JSON.parse(attempt.clear_proof_json),
    expiresAt: new Date(Number(attempt.ticket_expires_at)).toISOString(),
  }, corsHeaders);
}

async function handleMapPublish(request, env, now, corsHeaders) {
  const body = await readJsonBody(request);
  const token = authorTokenFrom(request, body);
  const map = canonicalizeMap(body.map);
  const [mapHash, ownerHash, ticket] = await Promise.all([
    calculateMapHash(map),
    hashOwnerToken(token),
    verifyTicket(body.publishTicket, env.PUBLISH_SECRET, now),
  ]);
  if (ticket.ownerHash !== ownerHash) {
    throw new ApiError(403, 'TICKET_OWNER_MISMATCH', '이 클리어 티켓을 받은 작성자만 게시할 수 있습니다.');
  }
  if (ticket.mapHash !== mapHash) {
    throw new ApiError(409, 'TICKET_MAP_MISMATCH', '클리어한 맵과 게시하려는 맵이 다릅니다.');
  }
  if (body.termsVersion !== COMMUNITY_TERMS_VERSION) {
    throw new ApiError(400, 'TERMS_ACCEPTANCE_REQUIRED', '최신 커뮤니티 이용규칙에 동의한 뒤 게시해주세요.', {
      termsVersion: COMMUNITY_TERMS_VERSION,
    });
  }
  const title = sanitizeText(body.title, { field: '맵 제목', maxLength: 60 });
  const author = sanitizeText(body.author, { field: '작성자 이름', maxLength: 24, fallback: '익명' });
  const authorId = await publicAuthorId(ownerHash);
  const blocked = await env.DB.prepare('SELECT author_id FROM blocked_authors WHERE author_id = ?')
    .bind(authorId).first();
  if (blocked) {
    throw new ApiError(403, 'AUTHOR_PUBLISH_BLOCKED', '커뮤니티 이용규칙 위반으로 이 작성자의 게시가 제한되었습니다.');
  }
  const used = await env.DB.prepare('SELECT id FROM maps WHERE ticket_id = ?').bind(ticket.jti).first();
  if (used) throw new ApiError(409, 'PUBLISH_TICKET_USED', '이미 사용한 게시 티켓입니다.');

  const id = randomId('map_', 12);
  const createdAt = new Date(now).toISOString();
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO maps (
        id, title, author, author_id, owner_hash, map_hash, map_json, search_text,
        created_at, plays, clears, ticket_id, terms_version, status, moderated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'active', ''
      WHERE NOT EXISTS (SELECT 1 FROM blocked_authors WHERE author_id = ?)
    `).bind(
      id, title, author, authorId, ownerHash, mapHash, JSON.stringify(map),
      normalizeSearch(`${title} ${author}`), createdAt, ticket.jti, COMMUNITY_TERMS_VERSION, authorId,
    ).run();
    if (Number(inserted.meta?.changes ?? 0) === 0) {
      throw new ApiError(403, 'AUTHOR_PUBLISH_BLOCKED', '커뮤니티 이용규칙 위반으로 이 작성자의 게시가 제한되었습니다.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const duplicate = await env.DB.prepare('SELECT id FROM maps WHERE ticket_id = ?').bind(ticket.jti).first();
    if (duplicate) throw new ApiError(409, 'PUBLISH_TICKET_USED', '이미 사용한 게시 티켓입니다.');
    throw error;
  }
  await env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(ticket.attemptId).run();
  const row = await getMap(env.DB, id);
  if (!row) {
    throw new ApiError(409, 'MAP_NO_LONGER_AVAILABLE', '게시 직후 맵을 불러올 수 없습니다. 다시 검증해 주세요.');
  }
  return jsonResponse(201, { ok: true, map: publicMapRecord(row, true) }, corsHeaders);
}

async function handleCounter(request, env, id, action, corsHeaders) {
  await readJsonBody(request);
  const column = action === 'play' ? 'plays' : 'clears';
  const row = await env.DB.prepare(`
    UPDATE maps SET ${column} = ${column} + 1
    WHERE id = ? AND status = 'active'
    RETURNING plays, clears
  `).bind(id).first();
  if (!row) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
  return jsonResponse(200, {
    ok: true,
    mapId: id,
    plays: Number(row.plays),
    clears: Number(row.clears),
  }, corsHeaders);
}

async function handleOwnerDelete(request, env, id, corsHeaders) {
  const body = await readJsonBody(request);
  const token = authorTokenFrom(request, body);
  const row = await getMap(env.DB, id);
  if (!row) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
  if (!row.owner_hash || row.owner_hash !== await hashOwnerToken(token)) {
    throw new ApiError(403, 'MAP_OWNER_MISMATCH', '이 맵을 게시한 제작자만 삭제할 수 있습니다.');
  }
  await env.DB.prepare('DELETE FROM maps WHERE id = ?').bind(id).run();
  return jsonResponse(200, { ok: true, deleted: true, id }, corsHeaders);
}

async function handleReport(request, env, id, now, corsHeaders, requestKey) {
  const body = await readJsonBody(request);
  const token = authorTokenFrom(request, body);
  const map = await getMap(env.DB, id);
  if (!map || map.status !== 'active') throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!REPORT_SCOPES.includes(scope)) {
    throw new ApiError(400, 'INVALID_REPORT_SCOPE', '신고 대상은 map 또는 author여야 합니다.');
  }
  if (!REPORT_REASONS.includes(reason)) {
    throw new ApiError(400, 'INVALID_REPORT_REASON', '지원하지 않는 신고 사유입니다.');
  }
  const detail = sanitizeOptionalText(body.detail, 240);
  if (reason === 'other' && !detail) {
    throw new ApiError(400, 'REPORT_DETAIL_REQUIRED', '기타 신고 사유를 간단히 적어주세요.');
  }
  const reporterId = await publicAuthorId(await hashOwnerToken(token));
  const reportLimit = safeInteger(env.REPORT_RATE_LIMIT, 8, 1, 1000);
  const reportWindow = safeInteger(env.REPORT_RATE_WINDOW_MS, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
  const ipLimit = await persistentRateLimit(env.DB, `report-ip:${requestKey}`, reportLimit, reportWindow, now);
  if (!ipLimit.allowed) return limitedResponse(ipLimit, corsHeaders);
  const reporterLimit = await persistentRateLimit(
    env.DB, `reporter:${reporterId}`, reportLimit, reportWindow, now,
  );
  if (!reporterLimit.allowed) return limitedResponse(reporterLimit, corsHeaders);

  const reportId = randomId('report_', 12);
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO reports (
      id, map_id, author_id, reporter_id, scope, reason, detail, status,
      created_at, resolved_at, resolution
    )
    SELECT ?, maps.id, maps.author_id, ?, ?, ?, ?, 'open', ?, '', ''
    FROM maps
    WHERE maps.id = ? AND maps.status = 'active'
  `).bind(
    reportId, reporterId, scope, reason, detail, new Date(now).toISOString(), id,
  ).run();
  const duplicate = Number(result.meta?.changes ?? 0) === 0;
  let report = { id: reportId, status: 'open' };
  if (duplicate) {
    const activeMap = await env.DB.prepare(
      "SELECT id FROM maps WHERE id = ? AND status = 'active'",
    ).bind(id).first();
    if (!activeMap) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
    report = await env.DB.prepare(`
      SELECT id, status FROM reports
      WHERE map_id = ? AND reporter_id = ? AND scope = ? AND status = 'open'
    `).bind(id, reporterId, scope).first();
    if (!report) throw new ApiError(409, 'REPORT_NOT_ACCEPTED', '신고를 접수하지 못했습니다. 다시 시도해 주세요.');
  }
  return jsonResponse(duplicate ? 200 : 201, {
    ok: true,
    duplicate,
    report: { id: report.id, status: report.status },
  }, corsHeaders);
}

async function handleModerationList(request, env, url, corsHeaders) {
  await requireModerationToken(request, env.MODERATION_TOKEN);
  const status = url.searchParams.get('status') || 'open';
  if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) {
    throw new ApiError(400, 'INVALID_REPORT_STATUS', 'status는 open, resolved, dismissed, all 중 하나여야 합니다.');
  }
  const where = status === 'all' ? '' : 'WHERE reports.status = ?';
  const result = await env.DB.prepare(`
    SELECT reports.*, maps.title AS map_title, maps.author AS map_author
    FROM reports LEFT JOIN maps ON maps.id = reports.map_id
    ${where}
    ORDER BY reports.created_at DESC
  `).bind(...(status === 'all' ? [] : [status])).all();
  return jsonResponse(200, {
    ok: true,
    reports: (result.results ?? []).map(publicReportRecord),
  }, corsHeaders);
}

async function handleModerationAction(request, env, id, now, corsHeaders) {
  await requireModerationToken(request, env.MODERATION_TOKEN);
  const body = await readJsonBody(request);
  const action = typeof body.action === 'string' ? body.action : '';
  if (!MODERATION_ACTIONS.includes(action)) {
    throw new ApiError(400, 'INVALID_MODERATION_ACTION', `action은 ${MODERATION_ACTIONS.join(', ')} 중 하나여야 합니다.`);
  }
  const report = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
  if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', '신고를 찾을 수 없습니다.');
  const target = await getMap(env.DB, report.map_id);
  if (!target) throw new ApiError(404, 'MAP_NOT_FOUND', '신고된 맵을 찾을 수 없습니다.');
  const resolvedAt = new Date(now).toISOString();
  if (action === 'dismiss') {
    await env.DB.prepare(`
      UPDATE reports SET status = 'dismissed', resolved_at = ?, resolution = ? WHERE id = ?
    `).bind(resolvedAt, action, id).run();
    return jsonResponse(200, { ok: true, action, affectedMapIds: [] }, corsHeaders);
  }

  const authorWide = action.endsWith('_author');
  const result = await env.DB.prepare(`
    SELECT id FROM maps WHERE ${authorWide ? 'author_id = ?' : 'id = ?'}
  `).bind(authorWide ? report.author_id : report.map_id).all();
  const affectedMapIds = (result.results ?? []).map((row) => row.id);
  const statements = [];
  if (authorWide) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO blocked_authors (author_id, blocked_at, reason)
      VALUES (?, ?, ?)
    `).bind(report.author_id, resolvedAt, action));
  }
  if (action.startsWith('hide_')) {
    statements.push(env.DB.prepare(`
      UPDATE maps SET status = 'hidden', moderated_at = ?
      WHERE ${authorWide ? 'author_id = ?' : 'id = ?'}
    `).bind(resolvedAt, authorWide ? report.author_id : report.map_id));
    statements.push(env.DB.prepare(`
      UPDATE reports SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?
    `).bind(resolvedAt, action, id));
  } else {
    statements.push(env.DB.prepare(`
      DELETE FROM maps WHERE ${authorWide ? 'author_id = ?' : 'id = ?'}
    `).bind(authorWide ? report.author_id : report.map_id));
  }
  await env.DB.batch(statements);
  return jsonResponse(200, { ok: true, action, affectedMapIds }, corsHeaders);
}

async function handleApi(request, env, url, corsHeaders, executionContext) {
  const now = Date.now();
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const addressHash = await sha256Hex(`bounce-rate-address-v1\0${requestAddress(request)}`);
  const general = await bindingRateLimit(env.GENERAL_RATE_LIMITER, addressHash);
  if (!general.allowed) return limitedResponse(general, corsHeaders);
  if (method !== 'GET' && method !== 'HEAD') {
    const write = await bindingRateLimit(env.WRITE_RATE_LIMITER, addressHash);
    if (!write.allowed) return limitedResponse(write, corsHeaders);
  }

  if (method === 'GET' && path === '/api/health') return handleHealth(env, now, corsHeaders);
  if (method === 'GET' && path === '/api/maps') return handleMapList(env, url, corsHeaders);
  if (method === 'GET' && path === '/api/moderation/reports') {
    return handleModerationList(request, env, url, corsHeaders);
  }
  const moderationMatch = routeMatch(path, /^\/api\/moderation\/reports\/([^/]+)$/);
  if (method === 'POST' && moderationMatch) {
    return handleModerationAction(request, env, moderationMatch[0], now, corsHeaders);
  }
  const reportMatch = routeMatch(path, /^\/api\/maps\/([^/]+)\/report$/);
  if (method === 'POST' && reportMatch) {
    return handleReport(request, env, reportMatch[0], now, corsHeaders, addressHash);
  }
  const deleteMatch = routeMatch(path, /^\/api\/maps\/([^/]+)\/delete$/);
  if (method === 'POST' && deleteMatch) {
    return handleOwnerDelete(request, env, deleteMatch[0], corsHeaders);
  }
  const completeMatch = routeMatch(path, /^\/api\/attempts\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    return handleAttemptComplete(request, env, completeMatch[0], now, corsHeaders);
  }
  if (method === 'POST' && path === '/api/attempts') {
    const response = await handleAttemptCreate(request, env, now, corsHeaders);
    if (executionContext?.waitUntil && Math.random() < 0.05) {
      executionContext.waitUntil(cleanupExpired(env, now));
    }
    return response;
  }
  if (method === 'POST' && path === '/api/maps') {
    return handleMapPublish(request, env, now, corsHeaders);
  }
  const counterMatch = routeMatch(path, /^\/api\/maps\/([^/]+)\/(play|clear)$/);
  if (method === 'POST' && counterMatch) {
    return handleCounter(request, env, counterMatch[0], counterMatch[1], corsHeaders);
  }
  const detailMatch = routeMatch(path, /^\/api\/maps\/([^/]+)$/);
  if (method === 'GET' && detailMatch) return handleMapDetail(env, detailMatch[0], corsHeaders);
  throw new ApiError(404, 'API_NOT_FOUND', 'API 경로를 찾을 수 없습니다.');
}

async function cleanupExpired(env, now = Date.now()) {
  if (!env?.DB) return;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attempts WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now),
  ]);
}

export const worker = {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (env?.ASSETS?.fetch) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404, headers: securityHeaders('text/plain; charset=utf-8') });
    }
    let corsHeaders = {};
    try {
      validateBindings(env);
      corsHeaders = createCorsHeaders(request, env, url);
      if (request.method.toUpperCase() === 'OPTIONS') return preflightResponse(request, corsHeaders);
      return await handleApi(request, env, url, corsHeaders, executionContext);
    } catch (error) {
      return errorResponse(error, corsHeaders);
    }
  },

  async scheduled(controller, env, executionContext) {
    const operation = cleanupExpired(env, controller?.scheduledTime ?? Date.now());
    if (executionContext?.waitUntil) executionContext.waitUntil(operation);
    else await operation;
  },
};

export default worker;

export const __testing = Object.freeze({
  COMMUNITY_TERMS_VERSION,
  WORKER_MAX_REPLAY_TICKS,
  canonicalizeMap,
  cleanupExpired,
});
