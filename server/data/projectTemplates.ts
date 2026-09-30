export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  needsInstall: boolean;
  files: (title: string) => Record<string, string>;
}

const GITIGNORE = 'node_modules\ndist\n.DS_Store\n.env\n.env.*\n!.env.example\ntest-results\nplaywright-report\n';

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'static',
    name: '静态网页',
    description: 'HTML + CSS + JS，无需安装，保存即刷新',
    needsInstall: false,
    files: (title) => ({
      '.gitignore': GITIGNORE,
      'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="hero">
      <p class="eyebrow">Crew</p>
      <h1>${title}</h1>
      <p class="lead">这是一个空白的起点。在左边告诉你的机器人小队想做什么，它们会在这里把页面做出来。</p>
      <button id="cta" class="btn">点我试试</button>
      <p id="count" class="muted">还没有点击</p>
    </main>
    <script src="main.js"></script>
  </body>
</html>
`,
      'styles.css': `:root {
  --bg: #f7f7fb;
  --fg: #16161d;
  --muted: #6b6b7b;
  --accent: #5b5bf0;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f0f14;
    --fg: #f2f2f7;
    --muted: #9a9aab;
    --accent: #8c8cff;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
}

.hero {
  max-width: 640px;
  padding: 48px 24px;
  text-align: center;
}

.eyebrow {
  color: var(--accent);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 13px;
}

h1 {
  font-size: clamp(2rem, 6vw, 3.5rem);
  margin: 8px 0 16px;
  line-height: 1.1;
}

.lead {
  color: var(--muted);
  font-size: 1.1rem;
  line-height: 1.7;
}

.btn {
  margin-top: 24px;
  padding: 12px 24px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: white;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
}

.muted {
  color: var(--muted);
}
`,
      'main.js': `const btn = document.getElementById('cta');
const count = document.getElementById('count');
let n = 0;

btn.addEventListener('click', () => {
  n += 1;
  count.textContent = \`已点击 \${n} 次\`;
});
`,
    }),
  },
  {
    id: 'tailwind',
    name: 'Tailwind 静态页',
    description: 'HTML + Tailwind CSS（CDN），适合快速做落地页',
    needsInstall: false,
    files: (title) => ({
      '.gitignore': GITIGNORE,
      'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  </head>
  <body class="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
    <main class="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
      <span class="rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">Crew</span>
      <h1 class="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">${title}</h1>
      <p class="mt-6 text-lg leading-8 text-slate-600 dark:text-slate-400">告诉你的机器人小队想做什么，它们会用 Tailwind 把页面做出来。</p>
      <div class="mt-10 flex gap-4">
        <a href="#" class="rounded-full bg-indigo-600 px-6 py-3 font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:-translate-y-0.5 hover:bg-indigo-500">开始使用</a>
        <a href="#" class="rounded-full px-6 py-3 font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-white dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-900">了解更多</a>
      </div>
    </main>
  </body>
</html>
`,
    }),
  },
  {
    id: 'vite-react',
    name: 'Vite + React + TS',
    description: '现代 React 应用，热更新（首次启动会自动 npm install）',
    needsInstall: true,
    files: (title) => ({
      '.gitignore': GITIGNORE,
      'package.json': JSON.stringify(
        {
          name: slugify(title) || 'app',
          private: true,
          version: '0.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
          devDependencies: {
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^6.0.0',
            typescript: '^5.9.0',
            vite: '^8.0.0',
          },
        },
        null,
        2,
      ) + '\n',
      'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            isolatedModules: true,
          },
          include: ['src'],
        },
        null,
        2,
      ) + '\n',
      'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
      'src/App.tsx': `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="hero">
      <p className="eyebrow">Crew · React</p>
      <h1>${title}</h1>
      <p className="lead">告诉你的机器人小队想做什么，它们会在这里把应用做出来。</p>
      <button className="btn" onClick={() => setCount((c) => c + 1)}>
        已点击 {count} 次
      </button>
    </main>
  );
}
`,
      'src/index.css': `:root {
  --bg: #f7f7fb;
  --fg: #16161d;
  --muted: #6b6b7b;
  --accent: #5b5bf0;
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f0f14;
    --fg: #f2f2f7;
    --muted: #9a9aab;
    --accent: #8c8cff;
  }
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--fg);
}

.hero {
  max-width: 640px;
  padding: 48px 24px;
  text-align: center;
}

.eyebrow {
  color: var(--accent);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  font-size: clamp(2rem, 6vw, 3.5rem);
  margin: 8px 0 16px;
}

.lead {
  color: var(--muted);
  line-height: 1.7;
}

.btn {
  margin-top: 24px;
  padding: 12px 24px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}
`,
    }),
  },
  {
    id: 'vite-vue',
    name: 'Vite + Vue 3',
    description: 'Vue 3 单文件组件，热更新（首次启动会自动 npm install）',
    needsInstall: true,
    files: (title) => ({
      '.gitignore': GITIGNORE,
      'package.json': JSON.stringify(
        {
          name: slugify(title) || 'app',
          private: true,
          version: '0.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          dependencies: { vue: '^3.5.0' },
          devDependencies: { '@vitejs/plugin-vue': '^6.0.0', vite: '^8.0.0' },
        },
        null,
        2,
      ) + '\n',
      'vite.config.js': `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
});
`,
      'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
      'src/main.js': `import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
`,
      'src/App.vue': `<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <main class="hero">
    <p class="eyebrow">Crew · Vue</p>
    <h1>${title}</h1>
    <p class="lead">告诉你的机器人小队想做什么，它们会在这里把应用做出来。</p>
    <button class="btn" @click="count++">已点击 {{ count }} 次</button>
  </main>
</template>
`,
      'src/style.css': `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
  background: #f7f7fb;
  color: #16161d;
}

.hero {
  max-width: 640px;
  padding: 48px 24px;
  text-align: center;
}

.eyebrow {
  color: #42b883;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  font-size: clamp(2rem, 6vw, 3.5rem);
}

.lead {
  color: #6b6b7b;
  line-height: 1.7;
}

.btn {
  margin-top: 24px;
  padding: 12px 24px;
  border: 0;
  border-radius: 999px;
  background: #42b883;
  color: #fff;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}
`,
    }),
  },
];

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}
