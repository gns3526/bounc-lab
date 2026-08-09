import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const env = { ...loadEnv('android', projectRoot, ''), ...process.env };
const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || '';
const errors = [];
const expectedCapacitorVersion = '8.5.0';

function requireExactVersion(actual, packageName) {
  if (actual !== expectedCapacitorVersion) {
    errors.push(
      `${packageName} must be pinned exactly to ${expectedCapacitorVersion}; received ${actual || 'missing'}.`,
    );
  }
}

function validateProductionApi(value) {
  if (!value) {
    errors.push('VITE_API_BASE_URL is required for an Android release build.');
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push('VITE_API_BASE_URL must be an absolute URL.');
    return;
  }

  if (url.protocol !== 'https:') {
    errors.push('VITE_API_BASE_URL must use https:// for an Android release build.');
  }
  if (url.username || url.password) {
    errors.push('VITE_API_BASE_URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    errors.push('VITE_API_BASE_URL must not contain a query string or fragment.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local')) {
    errors.push('VITE_API_BASE_URL must point to a public API host, not localhost.');
  }
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
requireExactVersion(packageJson.dependencies?.['@capacitor/core'], '@capacitor/core');
requireExactVersion(packageJson.dependencies?.['@capacitor/android'], '@capacitor/android');
requireExactVersion(packageJson.devDependencies?.['@capacitor/cli'], '@capacitor/cli');
validateProductionApi(apiBaseUrl);

if (errors.length > 0) {
  for (const error of errors) console.error(`Android release error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Android release validation passed (API=${apiBaseUrl.replace(/\/+$/, '')}).`);
}
