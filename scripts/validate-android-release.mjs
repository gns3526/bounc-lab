import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const env = { ...loadEnv('android', projectRoot, ''), ...process.env };
const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || '';
const publicAppUrl = env.VITE_PUBLIC_APP_URL?.trim() || '';
const errors = [];
const expectedCapacitorVersion = '8.5.0';

function requireExactVersion(actual, packageName) {
  if (actual !== expectedCapacitorVersion) {
    errors.push(
      `${packageName} must be pinned exactly to ${expectedCapacitorVersion}; received ${actual || 'missing'}.`,
    );
  }
}

function validateProductionUrl(value, variableName) {
  if (!value) {
    errors.push(`${variableName} is required for an Android release build.`);
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${variableName} must be an absolute URL.`);
    return;
  }

  if (url.protocol !== 'https:') {
    errors.push(`${variableName} must use https:// for an Android release build.`);
  }
  if (url.username || url.password) {
    errors.push(`${variableName} must not contain credentials.`);
  }
  if (url.search || url.hash) {
    errors.push(`${variableName} must not contain a query string or fragment.`);
  }

  const hostname = url.hostname.toLowerCase();
  const placeholderHost =
    ['example.com', 'example.net', 'example.org'].some(
      (exampleHost) => hostname === exampleHost || hostname.endsWith(`.${exampleHost}`),
    ) ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.test');
  if (placeholderHost) {
    errors.push(`${variableName} must use a deployed public host, not a placeholder domain.`);
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local')) {
    errors.push(`${variableName} must point to a public host, not localhost.`);
  }
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
requireExactVersion(packageJson.dependencies?.['@capacitor/core'], '@capacitor/core');
requireExactVersion(packageJson.dependencies?.['@capacitor/android'], '@capacitor/android');
requireExactVersion(packageJson.devDependencies?.['@capacitor/cli'], '@capacitor/cli');
validateProductionUrl(apiBaseUrl, 'VITE_API_BASE_URL');
validateProductionUrl(publicAppUrl, 'VITE_PUBLIC_APP_URL');

if (errors.length > 0) {
  for (const error of errors) console.error(`Android release error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Android release validation passed (API=${apiBaseUrl.replace(/\/+$/, '')}, public app=${publicAppUrl.replace(/\/+$/, '')}).`,
  );
}
