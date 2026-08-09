import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
    mapHash: record.mapHash,
    createdAt: record.createdAt,
    plays: record.plays,
    clears: record.clears,
  };
  if (includeMap) result.map = record.map;
  return result;
}

function validateStoredState(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.maps)) {
    throw new Error('maps.json must contain an object with a maps array');
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
    return {
      id: record.id,
      title: String(record.title),
      author: String(record.author),
      mapHash: calculatedHash,
      map,
      createdAt: String(record.createdAt),
      plays: Number.isSafeInteger(record.plays) && record.plays >= 0 ? record.plays : 0,
      clears: Number.isSafeInteger(record.clears) && record.clears >= 0 ? record.clears : 0,
      ticketId: String(record.ticketId),
    };
  });
  return { version: 1, maps };
}

class MapStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, maps: [] };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = validateStoredState(JSON.parse(raw));
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

function requestIp(request) {
  return request.socket.remoteAddress || 'unknown';
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
  const secret = options.publishSecret ?? process.env.PUBLISH_SECRET ?? randomBytes(32).toString('hex');
  const runtimeEnvironment = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
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

      if (pathname.startsWith('/api/')) {
        applyApiCors(request, response, corsOptions);
        if (request.method === 'OPTIONS') {
          handleApiPreflight(request, response);
          return;
        }
        const ip = requestIp(request);
        if (!requireRateLimit(response, generalLimiter, `all:${ip}`, currentTime)) return;
        if (request.method !== 'GET' && request.method !== 'HEAD'
          && !requireRateLimit(response, writeLimiter, `write:${ip}`, currentTime)) return;
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          status: 'ok',
          service: 'bounce-map-api',
          mapCount: store.list().length,
          now: new Date(currentTime).toISOString(),
        });
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
        const filtered = store.list().filter((record) => !query
          || record.title.toLocaleLowerCase('ko-KR').includes(query)
          || record.author.toLocaleLowerCase('ko-KR').includes(query));
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
        if (!record) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
        sendJson(response, 200, { ok: true, map: publicMapRecord(record, true) });
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
        const title = sanitizeText(body.title, { field: '맵 제목', maxLength: 60 });
        const author = sanitizeText(body.author, { field: '작성자 이름', maxLength: 24, fallback: '익명' });
        const id = `map_${randomBytes(12).toString('base64url')}`;
        const record = {
          id,
          title,
          author,
          mapHash: calculatedMapHash,
          map,
          createdAt: new Date(currentTime).toISOString(),
          plays: 0,
          clears: 0,
          ticketId: ticketPayload.jti,
        };
        await store.update((state) => {
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
          if (!record) throw new ApiError(404, 'MAP_NOT_FOUND', '맵을 찾을 수 없습니다.');
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
