/**
 * GitHub Pages 静态构建脚本。
 *
 * 生成 dist/：
 *  - 只包含线上需要的静态文件（不含 preview、tests、server.mjs）
 *  - 注入 canonical / Open Graph / Twitter Card / JSON-LD
 *  - 生成 robots.txt、sitemap.xml、.nojekyll、404.html
 *  - 配置了 customDomain 时生成 CNAME
 *
 * 本地调试：
 *   SITE_URL=https://example.com/ node scripts/build-pages.mjs
 *   GITHUB_REPOSITORY=owner/repo node scripts/build-pages.mjs
 */
import {
  access,
  appendFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SOURCE_INDEX = path.join(ROOT, 'index.html');
const CONFIG_PATH = path.join(ROOT, 'pages.config.json');

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const escapeHtml = (value = '') =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const escapeXml = (value = '') =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function normalizeDomain(raw) {
  if (!raw || !raw.trim()) return '';
  const domain = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\s+/g, '');
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(domain)) {
    throw new Error(`pages.config.json 中的 customDomain 不是合法域名: ${raw}`);
  }
  return domain.toLowerCase();
}

function ensureTrailingSlash(raw) {
  const url = new URL(raw);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.hash = '';
  url.search = '';
  return url.href;
}

function resolveSite() {
  const customDomain = normalizeDomain(config.customDomain);
  if (customDomain) {
    return {
      siteUrl: `https://${customDomain}/`,
      customDomain,
      source: 'pages.config.json',
    };
  }

  const explicit = process.env.SITE_URL?.trim();
  if (explicit) {
    return {
      siteUrl: ensureTrailingSlash(explicit),
      customDomain: '',
      source: 'SITE_URL',
    };
  }

  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) {
    throw new Error(
      '无法确定站点地址。请在 GitHub Actions 中运行（自动提供 GITHUB_REPOSITORY），' +
        '或设置 SITE_URL，例如：SITE_URL=https://example.com/ node scripts/build-pages.mjs',
    );
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`无法解析 GITHUB_REPOSITORY: ${repository}`);
  }

  const isUserSite = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  return {
    siteUrl: isUserSite
      ? `https://${owner.toLowerCase()}.github.io/`
      : `https://${owner.toLowerCase()}.github.io/${repo}/`,
    customDomain: '',
    source: 'GITHUB_REPOSITORY',
  };
}

const { siteUrl, customDomain, source } = resolveSite();
const ogImageUrl = new URL(config.ogImage, siteUrl).href;
const ogImagePath = path.join(ROOT, config.ogImage);
await access(ogImagePath);

if (!DIST.startsWith(ROOT + path.sep)) {
  throw new Error(`拒绝清理非项目目录: ${DIST}`);
}
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const directory of ['src', 'assets', 'vendor', 'licenses']) {
  await cp(path.join(ROOT, directory), path.join(DIST, directory), { recursive: true });
}
for (const file of ['styles.css', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(ROOT, file), path.join(DIST, file));
}

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${siteUrl}#website`,
      url: siteUrl,
      name: config.siteName,
      description: config.description,
      inLanguage: 'zh-CN',
    },
    {
      '@type': 'WebPage',
      '@id': `${siteUrl}#webpage`,
      url: siteUrl,
      name: config.pageTitle,
      description: config.description,
      isPartOf: { '@id': `${siteUrl}#website` },
      primaryImageOfPage: { '@id': `${siteUrl}#primaryimage` },
      inLanguage: 'zh-CN',
    },
    {
      '@type': 'ImageObject',
      '@id': `${siteUrl}#primaryimage`,
      url: ogImageUrl,
      width: 1200,
      height: 630,
      caption: '指尖生花 · 手势控制粒子花朵',
    },
    {
      '@type': 'WebApplication',
      '@id': `${siteUrl}#application`,
      name: config.siteName,
      url: siteUrl,
      description: config.description,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any (Web Browser)',
      browserRequirements:
        '需要支持 WebGL2 与 getUserMedia 的现代浏览器；摄像头画面仅在本机处理。',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'CNY',
      },
      isPartOf: { '@id': `${siteUrl}#website` },
    },
  ],
};

const seoBlock = [
  '<!-- BUILD_SEO_START -->',
  `    <link rel="canonical" href="${escapeHtml(siteUrl)}" />`,
  `    <meta name="description" content="${escapeHtml(config.description)}" />`,
  `    <meta name="keywords" content="${escapeHtml(config.keywords)}" />`,
  `    <meta name="author" content="${escapeHtml(config.author)}" />`,
  '    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />',
  '    <meta property="og:type" content="website" />',
  `    <meta property="og:site_name" content="${escapeHtml(config.siteName)}" />`,
  `    <meta property="og:title" content="${escapeHtml(config.pageTitle)}" />`,
  `    <meta property="og:description" content="${escapeHtml(config.description)}" />`,
  `    <meta property="og:url" content="${escapeHtml(siteUrl)}" />`,
  `    <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />`,
  '    <meta property="og:image:type" content="image/jpeg" />',
  '    <meta property="og:image:width" content="1200" />',
  '    <meta property="og:image:height" content="630" />',
  '    <meta property="og:image:alt" content="指尖生花 · 手势控制粒子花朵" />',
  `    <meta property="og:locale" content="${escapeHtml(config.locale)}" />`,
  '    <meta name="twitter:card" content="summary_large_image" />',
  `    <meta name="twitter:title" content="${escapeHtml(config.pageTitle)}" />`,
  `    <meta name="twitter:description" content="${escapeHtml(config.description)}" />`,
  `    <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />`,
  '    <meta name="twitter:image:alt" content="指尖生花 · 手势控制粒子花朵" />',
  `    <script type="application/ld+json">${JSON.stringify(structuredData).replaceAll('<', '\\u003c')}</script>`,
  '    <!-- BUILD_SEO_END -->',
].join('\n');

let html = await readFile(SOURCE_INDEX, 'utf8');
html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(config.pageTitle)}</title>`);
// 移除源码里的旧描述，统一由构建脚本注入，避免重复 meta。
html = html.replace(/\s*<meta\s+name="description"[^>]*>\s*/i, '\n');
if (/<!-- BUILD_SEO_START -->[\s\S]*?<!-- BUILD_SEO_END -->/i.test(html)) {
  html = html.replace(/<!-- BUILD_SEO_START -->[\s\S]*?<!-- BUILD_SEO_END -->/i, seoBlock);
} else {
  html = html.replace(/<\/head>/i, `    ${seoBlock}\n  </head>`);
}
await writeFile(path.join(DIST, 'index.html'), html, 'utf8');

const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeXml(siteUrl)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
await writeFile(path.join(DIST, 'sitemap.xml'), sitemap, 'utf8');

const robots = `User-agent: *
Allow: /

Sitemap: ${siteUrl}sitemap.xml
`;
await writeFile(path.join(DIST, 'robots.txt'), robots, 'utf8');

const notFound = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <meta name="theme-color" content="${escapeHtml(config.themeColor)}" />
    <title>页面不存在 · 指尖生花</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh; margin: 0; display: grid; place-items: center;
        padding: 24px; background: #06050b; color: #fff4e9;
        font-family: "Iowan Old Style", "Baskerville", "Songti SC", "STSong", "SimSun", serif;
        background-image: radial-gradient(ellipse at 50% 42%, rgba(255,137,141,.12), transparent 46%);
      }
      main { width: min(460px, 100%); text-align: center; }
      .mark { width: 44px; height: 44px; margin: 0 auto 26px; opacity: .72; }
      .mark path, .mark circle { fill: none; stroke: #ffe7cf; stroke-width: 1.1; }
      .mark circle { fill: #ffd6a0; stroke: none; }
      p.kicker { margin: 0 0 14px; color: rgba(255,226,198,.38); font-family: monospace; font-size: 8px; letter-spacing: .3em; }
      h1 { margin: 0; font-size: clamp(32px, 7vw, 48px); font-weight: 400; letter-spacing: .06em; line-height: 1.2; }
      p.copy { margin: 16px 0 28px; color: rgba(255,241,230,.45); font-family: sans-serif; font-size: 12px; line-height: 1.9; }
      a { display: inline-flex; align-items: center; gap: 10px; padding: 11px 20px; border: 1px solid rgba(255,231,211,.32); border-radius: 999px; color: rgba(255,241,230,.8); font-family: sans-serif; font-size: 11px; letter-spacing: .08em; text-decoration: none; }
      a:hover { background: rgba(255,231,211,.08); }
    </style>
  </head>
  <body>
    <main>
      <svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
        <path d="M20 5c4.9 2.9 7.4 6.9 7.4 11.9 0 5.9-3.3 10.4-7.4 13.4-4.1-3-7.4-7.5-7.4-13.4C12.6 11.9 15.1 7.9 20 5Z" />
        <path d="M20 8.4v19.7M12.7 20c2.5 1 4.2 2.4 5.2 4.2M27.3 20c-2.5 1-4.2 2.4-5.2 4.2" />
        <circle cx="20" cy="30.1" r="1.2" />
      </svg>
      <p class="kicker">404 · LOST PETAL</p>
      <h1>这片花瓣飘走了。</h1>
      <p class="copy">你访问的页面不存在。回到花园，让花重新在指尖盛开。</p>
      <a href="${escapeHtml(siteUrl)}">回到指尖生花 <span aria-hidden="true">→</span></a>
    </main>
  </body>
</html>
`;
await writeFile(path.join(DIST, '404.html'), notFound, 'utf8');
await writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');

if (customDomain) {
  await writeFile(path.join(DIST, 'CNAME'), `${customDomain}\n`, 'utf8');
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    '## GitHub Pages build',
    '',
    `- Site URL: ${siteUrl}`,
    `- Resolved from: ${source}`,
    `- Custom domain: ${customDomain || 'not configured'}`,
    '- SEO: canonical, Open Graph, Twitter Card, JSON-LD',
    '- Generated: robots.txt, sitemap.xml, .nojekyll, 404.html',
    '',
  ].join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
}

console.log('');
console.log('  GitHub Pages artifact built');
console.log(`  site: ${siteUrl}`);
console.log(`  from: ${source}`);
console.log(`  dist: ${path.relative(ROOT, DIST)}/`);
console.log(`  cname: ${customDomain || '(not configured)'}`);
console.log('');
