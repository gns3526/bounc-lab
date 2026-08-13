import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRootUrl = new URL('../', import.meta.url);
const projectRoot = fileURLToPath(projectRootUrl);
const readText = (path) => readFile(new URL(path, projectRootUrl), 'utf8');

test('Android wrapper pins Capacitor and exposes reproducible build commands', async () => {
  const packageJson = JSON.parse(await readText('package.json'));
  assert.equal(packageJson.dependencies?.['@capacitor/core'], '8.5.0');
  assert.equal(packageJson.dependencies?.['@capacitor/android'], '8.5.0');
  assert.equal(packageJson.devDependencies?.['@capacitor/cli'], '8.5.0');
  assert.equal(packageJson.scripts?.['build:android:web'], 'node scripts/validate-android-release.mjs && vite build --mode android');
  assert.equal(packageJson.scripts?.['sync:android'], 'npm run build:android:web && cap sync android');
  assert.match(packageJson.scripts?.['build:android:aab'] || '', /gradlew\.bat bundleRelease/);
  assert.match(packageJson.scripts?.['build:android:apk'] || '', /gradlew\.bat assembleRelease/);

  const config = await readText('capacitor.config.ts');
  assert.match(config, /appId:\s*'com\.jellysnow\.penguinbounce'/);
  assert.match(config, /appName:\s*'펭귄 바운스'/);
  assert.match(config, /webDir:\s*'dist'/);
  assert.match(config, /androidScheme:\s*'https'/);
  assert.match(config, /allowMixedContent:\s*false/);
});

test('Android native project allows both orientations, signs releases, and targets API 36', async () => {
  const [variables, buildGradle, manifest, strings, keystoreExample, launcher, splash] = await Promise.all([
    readText('android/variables.gradle'),
    readText('android/app/build.gradle'),
    readText('android/app/src/main/AndroidManifest.xml'),
    readText('android/app/src/main/res/values/strings.xml'),
    readText('android/keystore.properties.example'),
    readFile(new URL('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', projectRootUrl)),
    readFile(new URL('android/app/src/main/res/drawable-land-xhdpi/splash.png', projectRootUrl)),
  ]);

  assert.match(variables, /compileSdkVersion\s*=\s*36/);
  assert.match(variables, /targetSdkVersion\s*=\s*36/);
  const minimum = Number(variables.match(/minSdkVersion\s*=\s*(\d+)/)?.[1]);
  assert.ok(minimum >= 21, `minSdkVersion must be at least 21, received ${minimum}`);
  assert.match(buildGradle, /namespace\s*=\s*"com\.jellysnow\.penguinbounce"/);
  assert.match(buildGradle, /applicationId\s+"com\.jellysnow\.penguinbounce"/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android:screenOrientation="unspecified"/);
  assert.doesNotMatch(manifest, /android:screenOrientation="(?:portrait|landscape|sensorPortrait|sensorLandscape)"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(strings, /<string name="app_name">펭귄 바운스<\/string>/);
  assert.match(buildGradle, /rootProject\.file\('keystore\.properties'\)/);
  assert.match(buildGradle, /signingConfig signingConfigs\.release/);
  assert.match(buildGradle, /gradle\.taskGraph\.whenReady/);
  assert.match(buildGradle, /Release signing credentials are required for every release build/);
  assert.match(buildGradle, /PENGUIN_SIGNING_CREDENTIALS_FILE/);
  assert.match(buildGradle, /PENGUIN_SIGNING_PROFILE/);
  assert.match(keystoreExample, /storeFile=/);
  assert.ok(launcher.byteLength > 30_000, 'launcher icon should contain Penguin Bounce artwork');
  assert.ok(splash.byteLength > 100_000, 'splash should contain Penguin Bounce artwork');
});

test('Android release validation requires public HTTPS API and share URLs', () => {
  const script = fileURLToPath(new URL('scripts/validate-android-release.mjs', projectRootUrl));
  const baseEnvironment = { ...process.env, VITE_API_BASE_URL: '', VITE_PUBLIC_APP_URL: '' };

  const missing = spawnSync(process.execPath, [script], { cwd: projectRoot, env: baseEnvironment, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /VITE_API_BASE_URL is required/);
  assert.match(missing.stderr, /VITE_PUBLIC_APP_URL is required/);

  const insecure = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: {
      ...baseEnvironment,
      VITE_API_BASE_URL: 'http://penguin-bounce-release.workers.dev',
      VITE_PUBLIC_APP_URL: 'https://penguin-bounce-release.workers.dev',
    },
    encoding: 'utf8',
  });
  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /must use https:\/\//);

  const valid = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: {
      ...baseEnvironment,
      VITE_API_BASE_URL: 'https://penguin-bounce-release.workers.dev',
      VITE_PUBLIC_APP_URL: 'https://penguin-bounce-release.workers.dev',
    },
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Android release validation passed/);

  const localShareUrl = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: {
      ...baseEnvironment,
      VITE_API_BASE_URL: 'https://penguin-bounce-release.workers.dev',
      VITE_PUBLIC_APP_URL: 'https://localhost',
    },
    encoding: 'utf8',
  });
  assert.notEqual(localShareUrl.status, 0);
  assert.match(localShareUrl.stderr, /VITE_PUBLIC_APP_URL must point to a public host/);
});

test('Toss validation checks a configured browser fallback URL while preserving intoss sharing', async () => {
  const script = fileURLToPath(new URL('scripts/validate-toss-release.mjs', projectRootUrl));
  const baseEnvironment = {
    ...process.env,
    VITE_API_BASE_URL: 'https://penguin-bounce-release.workers.dev',
    VITE_PUBLIC_APP_URL: '',
    TOSS_APP_NAME: 'penguin-bounce',
    VITE_TOSS_INTERSTITIAL_AD_GROUP_ID: 'penguin-bounce-interstitial-production',
    VITE_TOSS_AD_FREE_SKU: 'ait.0000062458.d0bd5054.079e0dec8a.6635518646',
  };

  const missingAdGroup = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_INTERSTITIAL_AD_GROUP_ID: '' },
    encoding: 'utf8',
  });
  assert.notEqual(missingAdGroup.status, 0);
  assert.match(missingAdGroup.stderr, /VITE_TOSS_INTERSTITIAL_AD_GROUP_ID is required/);

  const whitespaceAdGroup = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_INTERSTITIAL_AD_GROUP_ID: ' production-ad ' },
    encoding: 'utf8',
  });
  assert.notEqual(whitespaceAdGroup.status, 0);
  assert.match(whitespaceAdGroup.stderr, /must not contain whitespace/);

  const testAdGroup = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_INTERSTITIAL_AD_GROUP_ID: 'ait-ad-test-interstitial-id' },
    encoding: 'utf8',
  });
  assert.notEqual(testAdGroup.status, 0);
  assert.match(testAdGroup.stderr, /not an Apps in Toss test ID/);

  const placeholderAdGroup = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_INTERSTITIAL_AD_GROUP_ID: 'replace-with-production-id' },
    encoding: 'utf8',
  });
  assert.notEqual(placeholderAdGroup.status, 0);
  assert.match(placeholderAdGroup.stderr, /must not be a placeholder/);

  const developmentDefault = spawnSync(process.execPath, [script, '--development'], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_INTERSTITIAL_AD_GROUP_ID: '' },
    encoding: 'utf8',
  });
  assert.equal(developmentDefault.status, 0, developmentDefault.stderr);

  const missingAdFreeSku = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_AD_FREE_SKU: '' },
    encoding: 'utf8',
  });
  assert.notEqual(missingAdFreeSku.status, 0);
  assert.match(missingAdFreeSku.stderr, /VITE_TOSS_AD_FREE_SKU is required/);

  const whitespaceAdFreeSku = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_AD_FREE_SKU: ' ait.0000062458.d0bd5054.079e0dec8a.6635518646 ' },
    encoding: 'utf8',
  });
  assert.notEqual(whitespaceAdFreeSku.status, 0);
  assert.match(whitespaceAdFreeSku.stderr, /VITE_TOSS_AD_FREE_SKU must not contain whitespace/);

  const testAdFreeSku = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_AD_FREE_SKU: 'ait.test.remove-ads' },
    encoding: 'utf8',
  });
  assert.notEqual(testAdFreeSku.status, 0);
  assert.match(testAdFreeSku.stderr, /not a test SKU/);

  const placeholderAdFreeSku = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_AD_FREE_SKU: 'replace-with-ad-free-sku' },
    encoding: 'utf8',
  });
  assert.notEqual(placeholderAdFreeSku.status, 0);
  assert.match(placeholderAdFreeSku.stderr, /VITE_TOSS_AD_FREE_SKU must not be a placeholder/);

  const unconfirmedAdFreeSku = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_AD_FREE_SKU: 'ait.0000062458.d0bd5054.079e0dec8a.6635518647' },
    encoding: 'utf8',
  });
  assert.notEqual(unconfirmedAdFreeSku.status, 0);
  assert.match(unconfirmedAdFreeSku.stderr, /must match the confirmed Apps in Toss SKU/);

  const developmentWithoutAdFreeSku = spawnSync(process.execPath, [script, '--development'], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_TOSS_AD_FREE_SKU: '' },
    encoding: 'utf8',
  });
  assert.equal(developmentWithoutAdFreeSku.status, 0, developmentWithoutAdFreeSku.stderr);
  assert.match(developmentWithoutAdFreeSku.stderr, /will not offer the ad-free purchase/);

  const localShareUrl = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_PUBLIC_APP_URL: 'https://localhost' },
    encoding: 'utf8',
  });
  assert.notEqual(localShareUrl.status, 0);
  assert.match(localShareUrl.stderr, /VITE_PUBLIC_APP_URL must point to a public host/);

  const valid = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...baseEnvironment, VITE_PUBLIC_APP_URL: 'https://penguin-bounce-release.workers.dev' },
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);

  const tossBridge = await readText('public/toss-bridge.js');
  assert.match(tossBridge, /intoss:\/\//);
  assert.match(tossBridge, /Share\.createLink/);

  const viteConfig = await readText('vite.config.mjs');
  assert.match(viteConfig, /VITE_TOSS_INTERSTITIAL_AD_GROUP_ID/);
  assert.match(viteConfig, /toss-interstitial-ad-group-id/);
  assert.match(viteConfig, /ait-ad-test-interstitial-id/);
  assert.match(viteConfig, /VITE_TOSS_AD_FREE_SKU/);
  assert.match(viteConfig, /toss-ad-free-sku/);
});

test('Toss ad-free SKU metadata is injected only into Toss HTML transforms', async () => {
  const { default: createViteConfig } = await import('../vite.config.mjs');
  const source = '<!doctype html><html><head></head><body></body></html>';
  const confirmedAdFreeSku = 'ait.0000062458.d0bd5054.079e0dec8a.6635518646';
  const previousAdFreeSku = process.env.VITE_TOSS_AD_FREE_SKU;
  process.env.VITE_TOSS_AD_FREE_SKU = confirmedAdFreeSku;

  function transformForMode(mode) {
    const config = createViteConfig({ mode });
    const plugin = config.plugins.find((candidate) => candidate.name === 'bounc-toss-html');
    return plugin.transformIndexHtml.handler(source);
  }

  try {
    const tossResult = transformForMode('toss');
    const tossTagNames = tossResult.tags.map((tag) => tag.attrs?.name).filter(Boolean);
    assert.ok(tossTagNames.includes('toss-ad-free-sku'));
    assert.ok(
      tossResult.tags.some(
        (tag) => tag.attrs?.name === 'toss-ad-free-sku' && tag.attrs?.content === confirmedAdFreeSku,
      ),
    );
    assert.ok(tossResult.tags.some((tag) => tag.attrs?.src === '/toss-bridge.js'));

    for (const mode of ['web', 'android']) {
      const result = transformForMode(mode);
      assert.ok(!result.tags.some((tag) => tag.attrs?.name === 'toss-ad-free-sku'));
      assert.ok(!result.tags.some((tag) => tag.attrs?.src === '/toss-bridge.js'));
      assert.doesNotMatch(result.html, /toss-miniapp/);
    }
  } finally {
    if (previousAdFreeSku === undefined) delete process.env.VITE_TOSS_AD_FREE_SKU;
    else process.env.VITE_TOSS_AD_FREE_SKU = previousAdFreeSku;
  }
});

test('Android secrets stay ignored and privacy policy reflects actual online data flow', async () => {
  const [gitignore, privacy, terms, deletionGuide, releaseGuide, viteConfig] = await Promise.all([
    readText('.gitignore'),
    readText('public/privacy.html'),
    readText('public/terms.html'),
    readText('public/data-deletion.html'),
    readText('ANDROID_RELEASE.md'),
    readText('vite.config.mjs'),
  ]);

  for (const pattern of ['*.jks', '*.keystore', '*.aab', '*.apk', 'keystore.properties', 'key.properties', 'android/local.properties']) {
    assert.match(gitignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(privacy, /맵 제목/);
  assert.match(privacy, /제작자 표시명/);
  assert.match(privacy, /익명 작성자 토큰/);
  assert.match(privacy, /IP 주소/);
  assert.match(privacy, /요청 횟수 제한/);
  assert.match(privacy, /내 맵 삭제/);
  assert.match(privacy, /신고 정보/);
  assert.match(privacy, /Cloudflare Workers/);
  assert.match(privacy, /Cloudflare D1/);
  assert.match(privacy, /대한민국 외 지역/);
  assert.match(privacy, /Time Travel 복구 지점에는 삭제·수정 전 데이터가 최대 7일간/);
  assert.match(privacy, /IP 주소 원문 대신 SHA-256/);
  assert.match(privacy, /Apps in Toss 통합 광고/);
  assert.match(privacy, /Google AdMob/);
  assert.match(privacy, /광고 요청·노출·클릭 정보/);
  assert.match(privacy, /Google Play·ONEstore용 Android 앱과 일반 웹 배포판에는 광고 또는 인앱결제 SDK가 포함되지 않습니다/);
  assert.match(privacy, /주문 ID/);
  assert.match(privacy, /ait\.0000062458\.d0bd5054\.079e0dec8a\.6635518646/);
  assert.match(privacy, /Toss Native Storage/);
  assert.match(privacy, /Google LLC/);
  assert.match(privacy, /Apple Inc\./);
  assert.match(privacy, /Cloudflare D1에는 결제 정보를 저장하지 않습니다/);
  assert.match(privacy, /시행일: 2026년 8월 14일 · 문서 버전 1\.4/);
  assert.match(privacy, /hoon@jellysnow\.com/);
  assert.match(terms, /비소모품/);
  assert.match(terms, /구매 복원/);
  assert.match(terms, /환불이 완료되면 광고 제거 권한이 해제되고 광고가 다시 표시/);
  assert.match(terms, /약관 버전: 2026-08-14-v2/);
  assert.match(deletionGuide, /데이터 삭제는 결제 취소나 환불 신청이 아닙니다/);
  assert.match(deletionGuide, /구매 복원/);
  assert.match(releaseGuide, /최초 등록·업로드하기 전까지만/);
  assert.match(releaseGuide, /ALLOWED_ORIGINS/);
  assert.match(viteConfig, /privacy:\s*resolve\(process\.cwd\(\), 'public\/privacy\.html'\)/);
  assert.match(viteConfig, /terms:\s*resolve\(process\.cwd\(\), 'public\/terms\.html'\)/);
  assert.match(viteConfig, /dataDeletion:\s*resolve\(process\.cwd\(\), 'public\/data-deletion\.html'\)/);
  assert.match(viteConfig, /communityGuidelines:\s*resolve\(process\.cwd\(\), 'public\/community-guidelines\.html'\)/);
  assert.match(viteConfig, /VITE_PUBLIC_APP_URL/);
  assert.match(viteConfig, /'public-app-url'/);
});
