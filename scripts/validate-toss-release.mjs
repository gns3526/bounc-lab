import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const isDevelopment = process.argv.includes('--development');
const mode = isDevelopment ? 'toss-dev' : 'toss';
const sharedTossEnv = loadEnv('toss', projectRoot, '');
const fileEnv = loadEnv(mode, projectRoot, '');
const env = { ...sharedTossEnv, ...fileEnv, ...process.env };
const errors = [];
const warnings = [];
const confirmedAppName = 'penguin-bounce';
const explicitAppName = env.TOSS_APP_NAME?.trim();
const appName = explicitAppName || confirmedAppName;
const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || '';

function requireExactVersion(actual, expected, label) {
  if (actual !== expected) {
    errors.push(`${label} must be pinned exactly to ${expected}; received ${actual || 'missing'}.`);
  }
}

function validateAbsoluteUrl(value, { requireHttps }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push('VITE_API_BASE_URL must be an absolute URL.');
    return;
  }

  if (url.username || url.password) {
    errors.push('VITE_API_BASE_URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    errors.push('VITE_API_BASE_URL must not contain a query string or fragment.');
  }
  if (requireHttps && url.protocol !== 'https:') {
    errors.push('VITE_API_BASE_URL must use https:// for a production Toss build.');
  }
  if (!requireHttps && !['http:', 'https:'].includes(url.protocol)) {
    errors.push('VITE_API_BASE_URL must use http:// or https://.');
  }

  const hostname = url.hostname.toLowerCase();
  const placeholderHost =
    hostname === 'example.com' ||
    hostname.endsWith('.example.com') ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.test');
  if (requireHttps && placeholderHost) {
    errors.push('VITE_API_BASE_URL must use the deployed public API host, not a placeholder domain.');
  }
  if (
    requireHttps &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local'))
  ) {
    errors.push('VITE_API_BASE_URL must point to a public API host, not localhost.');
  }
  if (value.endsWith('/')) {
    warnings.push('VITE_API_BASE_URL ends with "/"; the Vite build will remove it.');
  }
}

const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
requireExactVersion(
  packageJson.dependencies?.['@apps-in-toss/web-framework'],
  '3.0.2',
  '@apps-in-toss/web-framework',
);
requireExactVersion(packageJson.devDependencies?.vite, '8.2.1', 'vite');

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appName)) {
  errors.push('TOSS_APP_NAME must use lowercase kebab-case (letters, numbers, and single hyphens).');
}

if (!isDevelopment && explicitAppName && explicitAppName !== confirmedAppName) {
  errors.push(
    `TOSS_APP_NAME must match the confirmed Apps in Toss appName (${confirmedAppName}); received ${explicitAppName}.`,
  );
}

if (!apiBaseUrl) {
  if (isDevelopment) {
    warnings.push('VITE_API_BASE_URL is empty; the development bundle will use same-origin API requests.');
  } else {
    errors.push('VITE_API_BASE_URL is required for a production Toss build.');
  }
} else {
  validateAbsoluteUrl(apiBaseUrl, { requireHttps: !isDevelopment });
}

for (const warning of warnings) console.warn(`Toss release warning: ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`Toss release error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Toss release validation passed (${isDevelopment ? 'development' : 'production'}, appName=${appName}).`,
  );
}
