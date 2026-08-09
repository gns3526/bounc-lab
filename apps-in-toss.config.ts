import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@apps-in-toss/web-framework/config';

const CONFIRMED_APP_NAME = 'penguin-bounce';

function readEnvValue(fileName: string, key: string) {
  try {
    const source = readFileSync(resolve(process.cwd(), fileName), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] !== key) continue;

      const value = match[2];
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        return value.slice(1, -1);
      }
      return value;
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
  }
  return undefined;
}

// The Apps in Toss console appName is immutable. Environment overrides are
// supported for deployment wiring, while release validation rejects mismatches.
const appName =
  process.env.TOSS_APP_NAME?.trim() ||
  readEnvValue('.env.toss.local', 'TOSS_APP_NAME')?.trim() ||
  readEnvValue('.env.toss', 'TOSS_APP_NAME')?.trim() ||
  CONFIRMED_APP_NAME;

export default defineConfig({
  appName,
  brand: {
    primaryColor: '#4DA7F7',
  },
  webView: {
    bounces: false,
    pullToRefreshEnabled: false,
    overScrollMode: 'never',
    mediaPlaybackRequiresUserAction: true,
    allowsBackForwardNavigationGestures: false,
  },
  permissions: [],
  webBundleDir: 'dist',
});
