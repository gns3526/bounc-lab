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
const publicAppUrl = env.VITE_PUBLIC_APP_URL?.trim() || '';
const rawInterstitialAdGroupId = env.VITE_TOSS_INTERSTITIAL_AD_GROUP_ID;
const interstitialAdGroupId =
  rawInterstitialAdGroupId?.trim() || (isDevelopment ? 'ait-ad-test-interstitial-id' : '');
const confirmedAdFreeSku = 'ait.0000062458.d0bd5054.079e0dec8a.6635518646';
const rawAdFreeSku = env.VITE_TOSS_AD_FREE_SKU;
const adFreeSku = rawAdFreeSku?.trim() || '';

function requireExactVersion(actual, expected, label) {
  if (actual !== expected) {
    errors.push(`${label} must be pinned exactly to ${expected}; received ${actual || 'missing'}.`);
  }
}

function validateAbsoluteUrl(value, { requireHttps, variableName }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${variableName} must be an absolute URL.`);
    return;
  }

  if (url.username || url.password) {
    errors.push(`${variableName} must not contain credentials.`);
  }
  if (url.search || url.hash) {
    errors.push(`${variableName} must not contain a query string or fragment.`);
  }
  if (requireHttps && url.protocol !== 'https:') {
    errors.push(`${variableName} must use https:// for a production Toss build.`);
  }
  if (!requireHttps && !['http:', 'https:'].includes(url.protocol)) {
    errors.push(`${variableName} must use http:// or https://.`);
  }

  const hostname = url.hostname.toLowerCase();
  const placeholderHost =
    ['example.com', 'example.net', 'example.org'].some(
      (exampleHost) => hostname === exampleHost || hostname.endsWith(`.${exampleHost}`),
    ) ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.test');
  if (requireHttps && placeholderHost) {
    errors.push(`${variableName} must use a deployed public host, not a placeholder domain.`);
  }
  if (
    requireHttps &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local'))
  ) {
    errors.push(`${variableName} must point to a public host, not localhost.`);
  }
  if (value.endsWith('/')) {
    warnings.push(`${variableName} ends with "/"; the Vite build will remove it.`);
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
  validateAbsoluteUrl(apiBaseUrl, { requireHttps: !isDevelopment, variableName: 'VITE_API_BASE_URL' });
}

if (publicAppUrl) {
  validateAbsoluteUrl(publicAppUrl, {
    requireHttps: !isDevelopment,
    variableName: 'VITE_PUBLIC_APP_URL',
  });
} else if (!isDevelopment) {
  warnings.push(
    'VITE_PUBLIC_APP_URL is empty; Toss intoss sharing still works, but non-Toss browser fallback links use the current page.',
  );
}

if (!isDevelopment) {
  if (!interstitialAdGroupId) {
    errors.push('VITE_TOSS_INTERSTITIAL_AD_GROUP_ID is required for a production Toss build.');
  } else {
    if (rawInterstitialAdGroupId !== interstitialAdGroupId || /\s/.test(interstitialAdGroupId)) {
      errors.push('VITE_TOSS_INTERSTITIAL_AD_GROUP_ID must not contain whitespace.');
    }
    if (/^ait-ad-test-/i.test(interstitialAdGroupId)) {
      errors.push(
        'VITE_TOSS_INTERSTITIAL_AD_GROUP_ID must use a production ad group ID, not an Apps in Toss test ID.',
      );
    }
    if (
      /(?:placeholder|replace[-_ ]?with|change[-_ ]?me|your[-_ ]|example|<|>)/i.test(
        interstitialAdGroupId,
      )
    ) {
      errors.push('VITE_TOSS_INTERSTITIAL_AD_GROUP_ID must not be a placeholder value.');
    }
  }

  if (!adFreeSku) {
    errors.push('VITE_TOSS_AD_FREE_SKU is required for a production Toss build.');
  } else {
    if (rawAdFreeSku !== adFreeSku || /\s/.test(adFreeSku)) {
      errors.push('VITE_TOSS_AD_FREE_SKU must not contain whitespace.');
    }
    if (/(?:^|[._-])test(?:[._-]|$)/i.test(adFreeSku)) {
      errors.push('VITE_TOSS_AD_FREE_SKU must use the production non-consumable SKU, not a test SKU.');
    }
    if (
      /(?:placeholder|replace[-_ ]?with|change[-_ ]?me|your[-_ ]|example|<|>)/i.test(adFreeSku)
    ) {
      errors.push('VITE_TOSS_AD_FREE_SKU must not be a placeholder value.');
    }
    if (adFreeSku !== confirmedAdFreeSku) {
      errors.push(
        `VITE_TOSS_AD_FREE_SKU must match the confirmed Apps in Toss SKU (${confirmedAdFreeSku}); received ${adFreeSku}.`,
      );
    }
  }
} else if (!adFreeSku) {
  warnings.push(
    'VITE_TOSS_AD_FREE_SKU is empty; the development bundle will not offer the ad-free purchase.',
  );
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
