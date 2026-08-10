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
  };

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
});

test('Android secrets stay ignored and privacy policy reflects actual online data flow', async () => {
  const [gitignore, privacy, releaseGuide, viteConfig] = await Promise.all([
    readText('.gitignore'),
    readText('public/privacy.html'),
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
  assert.match(privacy, /hoon@jellysnow\.com/);
  assert.match(releaseGuide, /최초 등록·업로드하기 전까지만/);
  assert.match(releaseGuide, /ALLOWED_ORIGINS/);
  assert.match(viteConfig, /privacy:\s*resolve\(process\.cwd\(\), 'public\/privacy\.html'\)/);
  assert.match(viteConfig, /terms:\s*resolve\(process\.cwd\(\), 'public\/terms\.html'\)/);
  assert.match(viteConfig, /communityGuidelines:\s*resolve\(process\.cwd\(\), 'public\/community-guidelines\.html'\)/);
  assert.match(viteConfig, /VITE_PUBLIC_APP_URL/);
  assert.match(viteConfig, /'public-app-url'/);
});
