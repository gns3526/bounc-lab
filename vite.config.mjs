import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

const CONFIRMED_APP_NAME = 'penguin-bounce';
const TOSS_TEST_INTERSTITIAL_AD_GROUP_ID = 'ait-ad-test-interstitial-id';

function addHtmlClass(html, className) {
  return html.replace(/<html\b([^>]*)>/i, (tag, attributes) => {
    const classAttribute = /\bclass\s*=\s*(["'])(.*?)\1/i;
    if (classAttribute.test(attributes)) {
      const nextAttributes = attributes.replace(classAttribute, (_match, quote, classes) => {
        const values = new Set(classes.split(/\s+/).filter(Boolean));
        values.add(className);
        return `class=${quote}${[...values].join(' ')}${quote}`;
      });
      return `<html${nextAttributes}>`;
    }
    return `<html class="${className}"${attributes}>`;
  });
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function setMetaContent(html, name, content) {
  const escapedContent = escapeHtmlAttribute(content);
  const metaPattern = new RegExp(
    `<meta\\b[^>]*\\bname\\s*=\\s*(["'])${name}\\1[^>]*>`,
    'i',
  );
  const match = html.match(metaPattern);
  if (!match) return { html, found: false };

  const tag = match[0];
  const contentPattern = /\bcontent\s*=\s*(["'])(.*?)\1/i;
  const updatedTag = contentPattern.test(tag)
    ? tag.replace(contentPattern, `content="${escapedContent}"`)
    : tag.replace(/\s*\/?>(?=\s*$)/, ` content="${escapedContent}" />`);
  return { html: html.replace(metaPattern, updatedTag), found: true };
}

export default defineConfig(({ mode }) => {
  const isTossBuild = mode === 'toss' || mode === 'toss-dev';
  const sharedTossEnv = isTossBuild ? loadEnv('toss', process.cwd(), '') : {};
  const env = { ...sharedTossEnv, ...loadEnv(mode, process.cwd(), '') };
  const appName = (env.TOSS_APP_NAME || CONFIRMED_APP_NAME).trim();
  const apiBaseUrl = (env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const publicAppUrl = (env.VITE_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  const tossInterstitialAdGroupId = (
    env.VITE_TOSS_INTERSTITIAL_AD_GROUP_ID ||
    (mode === 'toss-dev' ? TOSS_TEST_INTERSTITIAL_AD_GROUP_ID : '')
  ).trim();
  const tossAdFreeSku = (env.VITE_TOSS_AD_FREE_SKU || '').trim();
  const localApiProxy = (env.LOCAL_API_PROXY_URL || 'http://127.0.0.1:8787').trim();

  return {
    root: 'public',
    publicDir: false,
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      target: 'es2020',
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), 'public/index.html'),
          privacy: resolve(process.cwd(), 'public/privacy.html'),
          terms: resolve(process.cwd(), 'public/terms.html'),
          dataDeletion: resolve(process.cwd(), 'public/data-deletion.html'),
          communityGuidelines: resolve(process.cwd(), 'public/community-guidelines.html'),
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': localApiProxy },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: { '/api': localApiProxy },
    },
    plugins: [
      {
        name: 'bounc-toss-html',
        transformIndexHtml: {
          order: 'pre',
          handler(html) {
            const apiMeta = setMetaContent(html, 'api-base-url', apiBaseUrl);
            const publicAppMeta = setMetaContent(apiMeta.html, 'public-app-url', publicAppUrl);
            const transformedHtml = isTossBuild
              ? addHtmlClass(publicAppMeta.html, 'toss-miniapp')
              : publicAppMeta.html;
            const tags = [];
            if (!apiMeta.found) {
              tags.push({
                tag: 'meta',
                attrs: { name: 'api-base-url', content: apiBaseUrl },
                injectTo: 'head-prepend',
              });
            }
            if (!publicAppMeta.found) {
              tags.push({
                tag: 'meta',
                attrs: { name: 'public-app-url', content: publicAppUrl },
                injectTo: 'head-prepend',
              });
            }

            if (isTossBuild) {
              tags.push(
                {
                  tag: 'meta',
                  attrs: { name: 'toss-app-name', content: appName },
                  injectTo: 'head-prepend',
                },
                {
                  tag: 'meta',
                  attrs: {
                    name: 'toss-interstitial-ad-group-id',
                    content: tossInterstitialAdGroupId,
                  },
                  injectTo: 'head-prepend',
                },
                {
                  tag: 'meta',
                  attrs: { name: 'toss-ad-free-sku', content: tossAdFreeSku },
                  injectTo: 'head-prepend',
                },
                {
                  tag: 'script',
                  attrs: { type: 'module', src: '/toss-bridge.js' },
                  injectTo: 'body',
                },
              );
            }

            return { html: transformedHtml, tags };
          },
        },
      },
    ],
  };
});
