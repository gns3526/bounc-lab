import { defineConfig, loadEnv } from 'vite';

const PROVISIONAL_APP_NAME = 'bounc-lab';

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
  const appName = (env.TOSS_APP_NAME || PROVISIONAL_APP_NAME).trim();
  const apiBaseUrl = (env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

  return {
    root: 'public',
    publicDir: false,
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      target: 'es2020',
    },
    plugins: [
      {
        name: 'bounc-toss-html',
        transformIndexHtml: {
          order: 'pre',
          handler(html) {
            const apiMeta = setMetaContent(html, 'api-base-url', apiBaseUrl);
            const transformedHtml = isTossBuild
              ? addHtmlClass(apiMeta.html, 'toss-miniapp')
              : apiMeta.html;
            const tags = apiMeta.found
              ? []
              : [
                  {
                    tag: 'meta',
                    attrs: { name: 'api-base-url', content: apiBaseUrl },
                    injectTo: 'head-prepend',
                  },
                ];

            if (isTossBuild) {
              tags.push(
                {
                  tag: 'meta',
                  attrs: { name: 'toss-app-name', content: appName },
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
