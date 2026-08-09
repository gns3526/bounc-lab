import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnHasClearance, verifyCompletionReplay } from './physics-proof.mjs';

const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 48 * 1024;
const ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_TTL_MS = 20 * 60 * 1000;
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 256;
const GRID_ROWS = 15;
const GRID_COLUMNS = 20;
const STORAGE_VERSION = 3;
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

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.mp3', 'audio/mpeg'],
  ['.woff2', 'font/woff2'],
]);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function securityHeaders(contentType, { crossOriginResourcePolicy = 'same-origin' } = {}) {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': crossOriginResourcePolicy,
    'X-Frame-Options': 'SAMEORIGIN',
  };
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8', { crossOriginResourcePolicy: 'cross-origin' }),
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(response, error) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : '서버에서 요청을 처리하지 못했습니다.';
  const payload = { ok: false, error: { code, message } };
  if (known && error.details !== undefined) payload.error.details = error.details;
  sendJson(response, status, payload);
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

function createAllowedOrigins({ tossAppName, configuredOrigins }) {
  const origins = new Set();
  if (tossAppName) {
    const normalizedAppName = String(tossAppName).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedAppName)) {
      throw new Error('TOSS_APP_NAME must be a valid DNS label');
    }
    origins.add(`https://${normalizedAppName}.web.tossmini.com`);
    origins.add(`https://${normalizedAppName}.private-web.tossmini.com`);
  }

  const entries = Array.isArray(configuredOrigins)
    ? configuredOrigins
    : String(configuredOrigins ?? '').split(',');
  for (const entry of entries) {
    const trimmed = String(entry).trim();
    if (trimmed) origins.add(normalizeConfiguredOrigin(trimmed));
  }
  return origins;
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

function requestOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return null;
  if (Array.isArray(origin) || typeof origin !== 'string') {
    throw new ApiError(403, 'CORS_ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  }
  try {
    return normalizeConfiguredOrigin(origin);
  } catch {
    throw new ApiError(403, 'CORS_ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  }
}

function appendVary(response, value) {
  const existing = response.getHeader('Vary');
  const values = new Set(String(existing ?? '').split(',').map((item) => item.trim()).filter(Boolean));
  for (const item of value.split(',')) values.add(item.trim());
  response.setHeader('Vary', [...values].join(', '));
}

function applyApiCors(request, response, { allowedOrigins, allowLocalDevelopment }) {
  const origin = requestOrigin(request);
  if (origin === null) return null;
  appendVary(response, 'Origin');
  if (!allowedOrigins.has(origin) && !(allowLocalDevelopment && isLocalDevelopmentOrigin(origin))) {
    throw new ApiError(403, 'CORS_ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  }
  response.setHeader('Access-Control-Allow-Origin', origin);
  return origin;
}

function handleApiPreflight(request, response) {
  const requestedMethod = request.headers['access-control-request-method'];
  if (Array.isArray(requestedMethod) || typeof requestedMethod !== 'string'
    || !CORS_ALLOWED_METHODS.includes(requestedMethod.toUpperCase())) {
    throw new ApiError(405, 'CORS_METHOD_DENIED', '허용되지 않은 CORS 요청 방식입니다.');
  }

  const requestedHeadersValue = request.headers['access-control-request-headers'];
  if (Array.isArray(requestedHeadersValue)) {
    throw new ApiError(400, 'CORS_HEADERS_DENIED', '허용되지 않은 CORS 요청 헤더입니다.');
  }
  const allowedHeaderNames = new Set(CORS_ALLOWED_HEADERS.map((name) => name.toLowerCase()));
  const requestedHeaders = String(requestedHeadersValue ?? '')
    .split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (requestedHeaders.some((name) => !allowedHeaderNames.has(name))) {
    throw new ApiError(400, 'CORS_HEADERS_DENIED', '허용되지 않은 CORS 요청 헤더입니다.');
  }

  appendVary(response, 'Access-Control-Request-Method, Access-Control-Request-Headers');
  response.writeHead(204, {
    'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS.join(', '),
    'Access-Control-Max-Age': '600',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': '0',
  });
  response.end();
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
  if (!clipped) {
    throw new ApiError(400, 'EMPTY_TEXT', `${field}을(를) 입력해주세요.`);
  }
  return clipped;
}

function sanitizeOptionalText(value, { maxLength }) {
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
    throw new ApiError(400, 'INVALID_GRID', `grid는 정확히 ${GRID_ROWS}행이어야 합니다.`);
  }

  const grid = input.grid.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== GRID_COLUMNS) {
      throw new ApiError(400, 'INVALID_GRID', `grid의 ${rowIndex + 1}행은 정확히 ${GRID_COLUMNS}칸이어야 합니다.`);
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
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) {
    throw new ApiError(400, 'INVALID_SPAWN', '시작점이 필요합니다.');
  }
  if (!Number.isInteger(spawn.c) || !Number.isInteger(spawn.r)
    || spawn.c < 0 || spawn.c >= GRID_COLUMNS - 1 || spawn.r < 0 || spawn.r >= GRID_ROWS) {
    throw new ApiError(400, 'INVALID_SPAWN', '시작점이 맵 범위를 벗어났습니다.');
  }
  if (grid[spawn.r][spawn.c] !== 0) {
    throw new ApiError(400, 'BLOCKED_SPAWN', '시작점은 빈칸 위에 있어야 합니다.');
  }

  if (!Number.isInteger(input.exitRow) || input.exitRow < 0 || input.exitRow >= GRID_ROWS) {
    throw new ApiError(400, 'INVALID_EXIT', '출구 행이 맵 범위를 벗어났습니다.');
  }
  if (grid[input.exitRow][GRID_COLUMNS - 1] !== 0) {
    throw new ApiError(400, 'BLOCKED_EXIT', '출구는 오른쪽 끝의 빈칸이어야 합니다.');
  }
  for (let row = 0; row < GRID_ROWS; row += 1) {
    if (row !== input.exitRow && grid[row][GRID_COLUMNS - 1] === 0) {
      throw new ApiError(400, 'MULTIPLE_EXITS', '오른쪽 끝에는 지정한 출구 하나만 열 수 있습니다.', { row });
    }
  }

  const canonicalMap = {
    version: 1,
    grid,
    spawn: { c: spawn.c, r: spawn.r },
    exitRow: input.exitRow,
  };
  if (!spawnHasClearance(canonicalMap)) {
    throw new ApiError(400, 'BLOCKED_SPAWN_CLEARANCE', '시작점의 캐릭터 충돌 범위가 타일과 겹칩니다.');
  }
  return canonicalMap;
}

function mapHash(map) {
  return createHash('sha256').update(JSON.stringify(map)).digest('hex');
}

function hashOwnerToken(token) {
  return createHash('sha256').update(`bounce-owner-v1\0${token}`).digest('hex');
}

function publicAuthorId(ownerHash) {
  return createHash('sha256')
    .update(`bounce-public-author-v1\0${ownerHash}`)
    .digest('base64url')
    .slice(0, 22);
}

function legacyAuthorId(record) {
  return createHash('sha256')
    .update(`bounce-legacy-author-v1\0${record.id}\0${record.author}`)
    .digest('base64url')
    .slice(0, 22);
}

function deriveModerationToken(secret) {
  return createHmac('sha256', secret).update('bounce-moderation-v1').digest('base64url');
}

function validateProductionSecret(value, name) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a 32-512 character secret in production`);
  }
  return value;
}

function requireModerationToken(request, expectedToken) {
  const supplied = request.headers['x-moderation-token'];
  if (Array.isArray(supplied) || typeof supplied !== 'string' || supplied.length > 512) {
    throw new ApiError(401, 'MODERATION_AUTH_REQUIRED', '운영자 인증이 필요합니다.');
  }
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
    throw new ApiError(403, 'MODERATION_AUTH_DENIED', '운영자 인증이 올바르지 않습니다.');
  }
}

function authorTokenFrom(request, body) {
  const header = request.headers['x-author-token'];
  if (Array.isArray(header)) {
    throw new ApiError(400, 'INVALID_AUTHOR_TOKEN', '작성자 토큰 헤더가 올바르지 않습니다.');
  }
  if (header !== undefined && body?.authorToken !== undefined && header !== body.authorToken) {
    throw new ApiError(400, 'TOKEN_MISMATCH', '헤더와 본문의 작성자 토큰이 서로 다릅니다.');
  }
  const token = header ?? body?.authorToken;
  if (typeof token !== 'string' || token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new ApiError(401, 'AUTHOR_TOKEN_REQUIRED', `작성자 토큰은 ${TOKEN_MIN_LENGTH}~${TOKEN_MAX_LENGTH}자의 문자열이어야 합니다.`);
  }
  return token;
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    request.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', '요청 데이터가 너무 큽니다.');
  }

  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      throw new ApiError(413, 'BODY_TOO_LARGE', '요청 데이터가 너무 큽니다.');
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body is not an object');
    }
    return parsed;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '올바른 JSON 객체를 보내주세요.');
  }
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signTicket(payload, secret) {
  const encoded = base64urlJson(payload);
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyTicket(ticket, secret, now) {
  if (typeof ticket !== 'string' || ticket.length > 4096) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓이 올바르지 않습니다.');
  }
  const segments = ticket.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓이 올바르지 않습니다.');
  }
  const expected = createHmac('sha256', secret).update(segments[0]).digest();
  let supplied;
  try {
    supplied = Buffer.from(segments[1], 'base64url');
  } catch {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓이 올바르지 않습니다.');
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓 서명이 올바르지 않습니다.');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓 내용이 올바르지 않습니다.');
  }
  if (!payload || payload.v !== 1 || typeof payload.jti !== 'string'
    || typeof payload.mapHash !== 'string' || typeof payload.ownerHash !== 'string'
    || !Number.isFinite(payload.exp)) {
    throw new ApiError(401, 'INVALID_PUBLISH_TICKET', '게시 티켓 내용이 올바르지 않습니다.');
  }
  if (payload.exp <= now) {
    throw new ApiError(410, 'PUBLISH_TICKET_EXPIRED', '게시 티켓이 만료되었습니다. 맵을 다시 클리어해주세요.');
  }
  return payload;
}

function publicMapRecord(record, includeMap = true) {
  const result = {
    id: record.id,
    title: record.title,
    author: record.author,
    authorId: record.authorId,
    mapHash: record.mapHash,
    createdAt: record.createdAt,
    plays: record.plays,
    clears: record.clears,
  };
  if (includeMap) result.map = record.map;
  return result;
}

function publicReportRecord(report, map) {
  return {
    id: report.id,
    mapId: report.mapId,
    mapTitle: map?.title ?? '삭제된 맵',
    author: map?.author ?? '',
    authorId: report.authorId,
    scope: report.scope,
    reason: report.reason,
    detail: report.detail,
    status: report.status,
    createdAt: report.createdAt,
    resolvedAt: report.resolvedAt,
    resolution: report.resolution,
  };
}

function validateStoredState(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.maps)) {
    throw new Error('maps.json must contain an object with a maps array');
  }
  const inputVersion = input.version ?? 1;
  if (!Number.isSafeInteger(inputVersion) || inputVersion < 1 || inputVersion > STORAGE_VERSION) {
    throw new Error(`Unsupported maps.json version: ${inputVersion}`);
  }
  const ids = new Set();
  const maps = input.maps.map((record) => {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || ids.has(record.id)) {
      throw new Error('maps.json contains an invalid or duplicate map id');
    }
    ids.add(record.id);
    const map = canonicalizeMap(record.map);
    const calculatedHash = mapHash(map);
    if (record.mapHash !== calculatedHash) throw new Error(`Stored map hash mismatch: ${record.id}`);
    const ownerHash = typeof record.ownerHash === 'string' && /^[a-f0-9]{64}$/.test(record.ownerHash)
      ? record.ownerHash
      : null;
    const derivedAuthorId = ownerHash ? publicAuthorId(ownerHash) : legacyAuthorId(record);
    const authorId = typeof record.authorId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(record.authorId)
      ? record.authorId
      : derivedAuthorId;
    return {
      id: record.id,
      title: String(record.title),
      author: String(record.author),
      authorId,
      ownerHash,
      mapHash: calculatedHash,
      map,
      createdAt: String(record.createdAt),
      plays: Number.isSafeInteger(record.plays) && record.plays >= 0 ? record.plays : 0,
      clears: Number.isSafeInteger(record.clears) && record.clears >= 0 ? record.clears : 0,
      ticketId: String(record.ticketId),
      termsVersion: typeof record.termsVersion === 'string' && record.termsVersion
        ? record.termsVersion
        : 'legacy-v1',
      status: record.status === 'hidden' ? 'hidden' : 'active',
      moderatedAt: typeof record.moderatedAt === 'string' ? record.moderatedAt : '',
    };
  });
  const mapIds = new Set(maps.map((record) => record.id));
  const reportIds = new Set();
  const reports = (Array.isArray(input.reports) ? input.reports : []).map((report) => {
    if (!report || typeof report !== 'object' || typeof report.id !== 'string'
      || reportIds.has(report.id) || !mapIds.has(report.mapId)) {
      throw new Error('maps.json contains an invalid or duplicate report');
    }
    reportIds.add(report.id);
    if (!REPORT_SCOPES.includes(report.scope) || !REPORT_REASONS.includes(report.reason)) {
      throw new Error(`Stored report has an unsupported category: ${report.id}`);
    }
    return {
      id: report.id,
      mapId: String(report.mapId),
      authorId: String(report.authorId),
      reporterId: String(report.reporterId),
      scope: report.scope,
      reason: report.reason,
      detail: String(report.detail ?? ''),
      status: ['open', 'resolved', 'dismissed'].includes(report.status) ? report.status : 'open',
      createdAt: String(report.createdAt),
      resolvedAt: typeof report.resolvedAt === 'string' ? report.resolvedAt : '',
      resolution: typeof report.resolution === 'string' ? report.resolution : '',
    };
  });
  const blockedAuthors = [...new Set(Array.isArray(input.blockedAuthors) ? input.blockedAuthors : [])];
  if (blockedAuthors.some((authorId) => typeof authorId !== 'string'
    || !/^[A-Za-z0-9_-]{16,64}$/.test(authorId))) {
    throw new Error('maps.json contains an invalid blocked author id');
  }
  return { version: STORAGE_VERSION, maps, reports, blockedAuthors };
}

class MapStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: STORAGE_VERSION, maps: [], reports: [], blockedAuthors: [] };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = validateStoredState(JSON.parse(raw));
      const normalized = `${JSON.stringify(this.state, null, 2)}\n`;
      if (raw !== normalized) await this.#atomicWrite(this.state);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#atomicWrite(this.state);
    }
  }

  list() {
    return this.state.maps;
  }

  get(id) {
    return this.state.maps.find((map) => map.id === id);
  }

  reports() {
    return this.state.reports;
  }

  blockedAuthors() {
    return this.state.blockedAuthors;
  }

  async update(mutator) {
    const operation = this.writeQueue.then(async () => {
      const next = structuredClone(this.state);
      const result = mutator(next);
      await this.#atomicWrite(next);
      this.state = next;
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async #atomicWrite(state) {
    const directory = dirname(this.filePath);
    const temporary = resolve(directory, `.maps-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

class FixedWindowRateLimiter {
  constructor({ limit, windowMs, maxEntries = 10_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  check(key, now) {
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    if (this.entries.size > this.maxEntries) {
      for (const [candidate, value] of this.entries) {
        if (now >= value.resetAt || this.entries.size > this.maxEntries) this.entries.delete(candidate);
      }
    }
    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
}

function requestIp(request, trustProxy = false) {
  const socketAddress = request.socket.remoteAddress || 'unknown';
  if (!trustProxy) return socketAddress;
  const forwarded = request.headers['x-forwarded-for'];
  if (Array.isArray(forwarded) || typeof forwarded !== 'string' || forwarded.length > 1_024) return socketAddress;
  const addresses = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
  const nearestForwardedAddress = addresses.at(-1) || '';
  return isIP(nearestForwardedAddress) ? nearestForwardedAddress : socketAddress;
}

function requireRateLimit(response, limiter, key, now) {
  const result = limiter.check(key, now);
  if (!result.allowed) {
    sendJson(response, 429, {
      ok: false,
      error: { code: 'RATE_LIMITED', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
    }, { 'Retry-After': String(result.retryAfter) });
    return false;
  }
  return true;
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

async function serveStatic(request, response, pathname, publicDirectory) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders('text/plain; charset=utf-8') });
    response.end('Method Not Allowed');
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, 'INVALID_PATH', '요청 경로가 올바르지 않습니다.');
  }
  if (decoded.includes('\0')) throw new ApiError(400, 'INVALID_PATH', '요청 경로가 올바르지 않습니다.');
  if (decoded === '/') decoded = '/index.html';

  const root = resolve(publicDirectory);
  const target = resolve(root, `.${decoded}`);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    throw new ApiError(403, 'FORBIDDEN_PATH', '이 경로에는 접근할 수 없습니다.');
  }

  let fileStat;
  try {
    fileStat = await stat(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      response.writeHead(404, securityHeaders('text/plain; charset=utf-8'));
      response.end('Not Found');
      return;
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    response.writeHead(404, securityHeaders('text/plain; charset=utf-8'));
    response.end('Not Found');
    return;
  }

  const type = MIME_TYPES.get(extname(target).toLowerCase()) || 'application/octet-stream';
  response.writeHead(200, {
    ...securityHeaders(type),
    'Content-Length': fileStat.size,
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(target).pipe(response);
}

export async function createBounceServer(options = {}) {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const publicDirectory = resolve(options.publicDirectory ?? resolve(moduleDirectory, 'public'));
  const dataFile = resolve(options.dataFile ?? process.env.DATA_FILE ?? resolve(moduleDirectory, 'data', 'maps.json'));
  const now = options.now ?? (() => Date.now());
  const runtimeEnvironment = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const configuredPublishSecret = options.publishSecret ?? process.env.PUBLISH_SECRET;
  const secret = runtimeEnvironment === 'production'
    ? validateProductionSecret(configuredPublishSecret, 'PUBLISH_SECRET')
    : configuredPublishSecret ?? randomBytes(32).toString('hex');
  const configuredModerationToken = options.moderationToken ?? process.env.MODERATION_TOKEN;
  const moderationToken = runtimeEnvironment === 'production'
    ? validateProductionSecret(configuredModerationToken, 'MODERATION_TOKEN')
    : configuredModerationToken ?? deriveModerationToken(secret);
  const trustProxy = options.trustProxy
    ?? /^(?:1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '');
  const allowedOrigins = createAllowedOrigins({
    tossAppName: options.tossAppName ?? process.env.TOSS_APP_NAME,
    configuredOrigins: options.allowedOrigins ?? process.env.ALLOWED_ORIGINS,
  });
  const corsOptions = {
    allowedOrigins,
    allowLocalDevelopment: runtimeEnvironment !== 'production',
  };
  const attempts = new Map();
  const store = new MapStore(dataFile);
  await store.init();

  const generalLimiter = new FixedWindowRateLimiter({ limit: options.generalRateLimit ?? 240, windowMs: 60_000 });
  const writeLimiter = new FixedWindowRateLimiter({ limit: options.writeRateLimit ?? 60, windowMs: 60_000 });
  const reportLimiter = new FixedWindowRateLimiter({
    limit: options.reportRateLimit ?? 8,
    windowMs: options.reportRateWindowMs ?? 60 * 60 * 1000,
  });

  function purgeExpiredAttempts(currentTime) {
    if (attempts.size < 100 && Math.random() > 0.05) return;
    for (const [id, attempt] of attempts) {
      if (attempt.expiresAt <= currentTime) attempts.delete(id);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      const pathname = requestUrl.pathname;
      const currentTime = now();
      const requestAddress = requestIp(request, trustProxy);

      if (pathname.startsWith('/api/')) {
        applyApiCors(request, response, corsOptions);
        if (request.method === 'OPTIONS') {
          handleApiPreflight(request, response);
          return;
        }
        if (!requireRateLimit(response, generalLimiter, `all:${requestAddress}`, currentTime)) return;
        if (request.method !== 'GET' && request.method !== 'HEAD'
          && !requireRateLimit(response, writeLimiter, `write:${requestAddress}`, currentTime)) return;
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          status: 'ok',
          service: 'bounce-map-api',
          mapCount: store.list().filter((record) => record.status === 'active').length,
          now: new Date(currentTime).toISOString(),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/moderation/reports') {
        requireModerationToken(request, moderationToken);
        const status = requestUrl.searchParams.get('status') || 'open';
        if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) {
          throw new ApiError(400, 'INVALID_REPORT_STATUS', 'status는 open, resolved, dismissed, all 중 하나여야 합니다.');
        }
        const reports = store.reports()
          .filter((report) => status === 'all' || report.status === status)
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((report) => publicReportRecord(report, store.get(report.mapId)));
        sendJson(response, 200, { ok: true, reports });
        return;
      }

      const moderationMatch = routeMatch(pathname, /^\/api\/moderation\/reports\/([^/]+)$/);
      if (request.method === 'POST' && moderationMatch) {
        requireModerationToken(request, moderationToken);
        const body = await readJsonBody(request);
        const action = typeof body.action === 'string' ? body.action : '';
        if (!MODERATION_ACTIONS.includes(action)) {
          throw new ApiError(400, 'INVALID_MODERATION_ACTION', `action은 ${MODERATION_ACTIONS.join(', ')} 중 하나여야 합니다.`);
        }
        const reportId = moderationMatch[0];
        const report = store.reports().find((candidate) => candidate.id === reportId);
        if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', '신고를 찾을 수 없습니다.');
        const affectedMapIds = [];
        await store.update((state) => {
          const targetReport = state.reports.find((candidate) => candidate.id === reportId);
          if (!targetReport) throw new ApiError(404, 'REPORT_NOT_FOUND', '신고를 찾을 수 없습니다.');
          const targetMap = state.maps.find((candidate) => candidate.id === targetReport.mapId);
          if (!targetMap) throw new ApiError(404, 'MAP_NOT_FOUND', '신고된 맵을 찾을 수 없습니다.');

          if (action === 'dismiss') {
            targetReport.status = 'dismissed';
            targetReport.resolvedAt = new Date(currentTime).toISOString();
            targetReport.resolution = action;
            return;
          }

          const authorWide = action.endsWith('_author');
          const targets = state.maps.filter((candidate) => authorWide
            ? candidate.authorId === targetReport.authorId
            : candidate.id === targetReport.mapId);
          affectedMapIds.push(...targets.map((candidate) => candidate.id));
          if (authorWide && !state.blockedAuthors.includes(targetReport.authorId)) {
            state.blockedAuthors.push(targetReport.authorId);
          }

          if (action.startsWith('hide_')) {
            for (const candidate of targets) {
              candidate.status = 'hidden';
              candidate.moderatedAt = new Date(currentTime).toISOString();
            }
            targetReport.status = 'resolved';
            targetReport.resolvedAt = new Date(currentTime).toISOString();
            targetReport.resolution = action;
            return;
          }

          const targetIds = new Set(targets.map((candidate) => candidate.id));
          state.maps = state.maps.filter((candidate) => !targetIds.has(candidate.id));
          state.reports = state.reports.filter((candidate) => !targetIds.has(candidate.mapId));
        });
        sendJson(response, 200, { ok: true, action, affectedMapIds });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/maps') {
        const page = safeInteger(requestUrl.searchParams.get('page'), 1, 1, 1_000_000);
        const limit = safeInteger(requestUrl.searchParams.get('limit'), 12, 1, 50);
        const query = (requestUrl.searchParams.get('q') || requestUrl.searchParams.get('search') || '')
          .normalize('NFKC').trim().toLocaleLowerCase('ko-KR').slice(0, 100);
        const sort = requestUrl.searchParams.get('sort') || 'newest';
        const sorters = {
          newest: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
          oldest: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          popular: (a, b) => ((b.clears * 3) + b.plays) - ((a.clears * 3) + a.plays)
            || b.createdAt.localeCompare(a.createdAt),
          plays: (a, b) => b.plays - a.plays || b.createdAt.localeCompare(a.createdAt),
          clears: (a, b) => b.clears - a.clears || b.createdAt.localeCompare(a.createdAt),
        };
        if (!sorters[sort]) {
          throw new ApiError(400, 'INVALID_SORT', 'sort는 newest, oldest, popular, plays, clears 중 하나여야 합니다.');
        }
        const filtered = store.list().filter((record) => record.status === 'active' && (!query
          || record.title.toLocaleLowerCase('ko-KR').includes(query)
          || record.author.toLocaleLowerCase('ko-KR').includes(query)));
        filtered.sort(sorters[sort]);
        const total = filtered.length;
        const start = (page - 1) * limit;
        const maps = filtered.slice(start, start + limit).map((record) => publicMapRecord(record, false));
        sendJson(response, 200, {
          ok: true,
          maps,
          pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
          query: { search: query, sort },
        });
        return;
      }

      const detailMatch = routeMatch(pathname, /^\/api\/maps\/([^/]+)$/);
      if (request.method === 'GET' && detailMatch) {
        const record = store.get(detailMatch[0]);
        if (!record || record.status !== 'active') throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
        sendJson(response, 200, { ok: true, map: publicMapRecord(record, true) });
        return;
      }

      const reportMatch = routeMatch(pathname, /^\/api\/maps\/([^/]+)\/report$/);
      if (request.method === 'POST' && reportMatch) {
        const body = await readJsonBody(request);
        const token = authorTokenFrom(request, body);
        const record = store.get(reportMatch[0]);
        if (!record || record.status !== 'active') throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
        const scope = typeof body.scope === 'string' ? body.scope : '';
        const reason = typeof body.reason === 'string' ? body.reason : '';
        if (!REPORT_SCOPES.includes(scope)) {
          throw new ApiError(400, 'INVALID_REPORT_SCOPE', '신고 대상은 map 또는 author여야 합니다.');
        }
        if (!REPORT_REASONS.includes(reason)) {
          throw new ApiError(400, 'INVALID_REPORT_REASON', '지원하지 않는 신고 사유입니다.');
        }
        const detail = sanitizeOptionalText(body.detail, { maxLength: 240 });
        if (reason === 'other' && !detail) {
          throw new ApiError(400, 'REPORT_DETAIL_REQUIRED', '기타 신고 사유를 간단히 적어주세요.');
        }
        const reporterId = publicAuthorId(hashOwnerToken(token));
        if (!requireRateLimit(response, reportLimiter, `report-ip:${requestAddress}`, currentTime)) return;
        if (!requireRateLimit(response, reportLimiter, `reporter:${reporterId}`, currentTime)) return;

        let reportRecord;
        let duplicate = false;
        await store.update((state) => {
          const targetMap = state.maps.find((candidate) => candidate.id === record.id && candidate.status === 'active');
          if (!targetMap) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
          const existing = state.reports.find((candidate) => candidate.mapId === targetMap.id
            && candidate.reporterId === reporterId && candidate.scope === scope && candidate.status === 'open');
          if (existing) {
            reportRecord = existing;
            duplicate = true;
            return;
          }
          reportRecord = {
            id: `report_${randomBytes(12).toString('base64url')}`,
            mapId: targetMap.id,
            authorId: targetMap.authorId,
            reporterId,
            scope,
            reason,
            detail,
            status: 'open',
            createdAt: new Date(currentTime).toISOString(),
            resolvedAt: '',
            resolution: '',
          };
          state.reports.push(reportRecord);
        });
        sendJson(response, duplicate ? 200 : 201, {
          ok: true,
          duplicate,
          report: { id: reportRecord.id, status: reportRecord.status },
        });
        return;
      }

      const deleteMatch = routeMatch(pathname, /^\/api\/maps\/([^/]+)\/delete$/);
      if (request.method === 'POST' && deleteMatch) {
        const body = await readJsonBody(request);
        const token = authorTokenFrom(request, body);
        const record = store.get(deleteMatch[0]);
        if (!record) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
        if (!record.ownerHash || record.ownerHash !== hashOwnerToken(token)) {
          throw new ApiError(403, 'MAP_OWNER_MISMATCH', '이 맵을 게시한 제작자만 삭제할 수 있습니다.');
        }
        await store.update((state) => {
          state.maps = state.maps.filter((candidate) => candidate.id !== record.id);
          state.reports = state.reports.filter((candidate) => candidate.mapId !== record.id);
        });
        sendJson(response, 200, { ok: true, deleted: true, id: record.id });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/attempts') {
        const body = await readJsonBody(request);
        const token = authorTokenFrom(request, body);
        const map = canonicalizeMap(body.map ?? body);
        const hash = mapHash(map);
        const attemptId = randomBytes(18).toString('base64url');
        attempts.set(attemptId, {
          id: attemptId,
          ownerHash: hashOwnerToken(token),
          map,
          mapHash: hash,
          createdAt: currentTime,
          expiresAt: currentTime + ATTEMPT_TTL_MS,
          ticket: null,
        });
        purgeExpiredAttempts(currentTime);
        sendJson(response, 201, {
          ok: true,
          attemptId,
          mapHash: hash,
          expiresAt: new Date(currentTime + ATTEMPT_TTL_MS).toISOString(),
        });
        return;
      }

      const completeMatch = routeMatch(pathname, /^\/api\/attempts\/([^/]+)\/complete$/);
      if (request.method === 'POST' && completeMatch) {
        const body = await readJsonBody(request);
        const token = authorTokenFrom(request, body);
        const attempt = attempts.get(completeMatch[0]);
        if (!attempt) throw new ApiError(404, 'ATTEMPT_NOT_FOUND', '도전 기록을 찾을 수 없습니다.');
        if (attempt.expiresAt <= currentTime) {
          attempts.delete(attempt.id);
          throw new ApiError(410, 'ATTEMPT_EXPIRED', '도전 기록이 만료되었습니다. 다시 테스트해주세요.');
        }
        if (attempt.ownerHash !== hashOwnerToken(token)) {
          throw new ApiError(403, 'ATTEMPT_OWNER_MISMATCH', '이 도전을 시작한 작성자만 완료할 수 있습니다.');
        }
        if (!attempt.ticket) {
          const proof = verifyCompletionReplay(attempt.map, body.replay);
          if (!proof.ok) {
            throw new ApiError(422, 'INVALID_CLEAR_PROOF', proof.message, {
              reason: proof.code,
              ...(proof.details === undefined ? {} : { proof: proof.details }),
            });
          }
          attempt.clearProof = {
            engineVersion: proof.engineVersion,
            totalTicks: proof.totalTicks,
            time: proof.time,
            bounds: proof.bounds,
          };
          const payload = {
            v: 1,
            jti: randomBytes(18).toString('base64url'),
            attemptId: attempt.id,
            mapHash: attempt.mapHash,
            ownerHash: attempt.ownerHash,
            engineVersion: proof.engineVersion,
            replayTicks: proof.totalTicks,
            iat: currentTime,
            exp: currentTime + TICKET_TTL_MS,
          };
          attempt.ticket = signTicket(payload, secret);
          attempt.ticketExpiresAt = payload.exp;
        }
        sendJson(response, 200, {
          ok: true,
          publishTicket: attempt.ticket,
          mapHash: attempt.mapHash,
          verifiedClear: attempt.clearProof,
          expiresAt: new Date(attempt.ticketExpiresAt).toISOString(),
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/maps') {
        const body = await readJsonBody(request);
        const token = authorTokenFrom(request, body);
        const map = canonicalizeMap(body.map);
        const calculatedMapHash = mapHash(map);
        const ticketPayload = verifyTicket(body.publishTicket, secret, currentTime);
        const ownerHash = hashOwnerToken(token);
        if (ticketPayload.ownerHash !== ownerHash) {
          throw new ApiError(403, 'TICKET_OWNER_MISMATCH', '이 클리어 티켓을 받은 작성자만 게시할 수 있습니다.');
        }
        if (ticketPayload.mapHash !== calculatedMapHash) {
          throw new ApiError(409, 'TICKET_MAP_MISMATCH', '클리어한 맵과 게시하려는 맵이 다릅니다.');
        }
        if (body.termsVersion !== COMMUNITY_TERMS_VERSION) {
          throw new ApiError(400, 'TERMS_ACCEPTANCE_REQUIRED', '최신 커뮤니티 이용규칙에 동의한 뒤 게시해주세요.', {
            termsVersion: COMMUNITY_TERMS_VERSION,
          });
        }
        const title = sanitizeText(body.title, { field: '맵 제목', maxLength: 60 });
        const author = sanitizeText(body.author, { field: '작성자 이름', maxLength: 24, fallback: '익명' });
        const id = `map_${randomBytes(12).toString('base64url')}`;
        const record = {
          id,
          title,
          author,
          authorId: publicAuthorId(ownerHash),
          ownerHash,
          mapHash: calculatedMapHash,
          map,
          createdAt: new Date(currentTime).toISOString(),
          plays: 0,
          clears: 0,
          ticketId: ticketPayload.jti,
          termsVersion: COMMUNITY_TERMS_VERSION,
          status: 'active',
          moderatedAt: '',
        };
        await store.update((state) => {
          if (state.blockedAuthors.includes(record.authorId)) {
            throw new ApiError(403, 'AUTHOR_PUBLISH_BLOCKED', '커뮤니티 이용규칙 위반으로 이 익명 제작자의 게시가 제한되었습니다.');
          }
          if (state.maps.some((candidate) => candidate.ticketId === ticketPayload.jti)) {
            throw new ApiError(409, 'PUBLISH_TICKET_USED', '이미 사용한 게시 티켓입니다.');
          }
          state.maps.push(record);
        });
        attempts.delete(ticketPayload.attemptId);
        sendJson(response, 201, { ok: true, map: publicMapRecord(record, true) });
        return;
      }

      const counterMatch = routeMatch(pathname, /^\/api\/maps\/([^/]+)\/(play|clear)$/);
      if (request.method === 'POST' && counterMatch) {
        await readJsonBody(request);
        const [id, action] = counterMatch;
        const counters = await store.update((state) => {
          const record = state.maps.find((candidate) => candidate.id === id);
          if (!record || record.status !== 'active') throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
          if (action === 'play') record.plays += 1;
          else record.clears += 1;
          return { plays: record.plays, clears: record.clears };
        });
        sendJson(response, 200, { ok: true, mapId: id, ...counters });
        return;
      }

      if (pathname.startsWith('/api/')) {
        throw new ApiError(404, 'API_NOT_FOUND', 'API 경로를 찾을 수 없습니다.');
      }
      await serveStatic(request, response, pathname, publicDirectory);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
      if (!(error instanceof ApiError)) console.error(error);
    }
  });

  server.store = store;
  return server;
}

const isEntryPoint = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
  const port = safeInteger(process.env.PORT, DEFAULT_PORT, 1, 65535);
  const server = await createBounceServer();
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Bounce Ball: http://localhost:${port}`);
    if (!process.env.PUBLISH_SECRET) {
      console.warn('PUBLISH_SECRET이 없어 임시 서명 키를 사용합니다. 서버 재시작 시 기존 게시 티켓은 만료됩니다.');
    }
  });
}
