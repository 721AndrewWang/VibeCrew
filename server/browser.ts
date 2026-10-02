import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import type { ConsoleEntry } from '../shared/types';
import { findChrome } from './config';
import { ensurePreview, previewUrl } from './preview';

export type Device = 'desktop' | 'tablet' | 'mobile';

const DEVICES: Record<Device, { width: number; height: number; mobile: boolean }> = {
  desktop: { width: 1280, height: 800, mobile: false },
  tablet: { width: 820, height: 1180, mobile: true },
  mobile: { width: 390, height: 844, mobile: true },
};

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export const hasBrowser = () => !!findChrome();

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/** Emulated `prefers-color-scheme`: pages with a dark theme switch to it. */
export type ColorScheme = 'light' | 'dark';

interface Session {
  ctx: BrowserContext;
  page: Page;
  device: Device;
  colorScheme: ColorScheme;
  logs: ConsoleEntry[];
  projectId: string;
}
const sessions = new Map<string, Session>();

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  const executablePath = findChrome();
  if (!executablePath) throw new Error('没有找到 Chrome/Chromium。请安装 Google Chrome，或设置环境变量 CREW_CHROME_PATH。');
  launching = (async () => {
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    b.on('disconnected', () => {
      browser = null;
      sessions.clear();
    });
    browser = b;
    return b;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), 10 * 60_000);
}

async function newContext(device: Device, colorScheme: ColorScheme = 'light'): Promise<BrowserContext> {
  const b = await getBrowser();
  const d = DEVICES[device];
  return b.newContext({
    colorScheme,
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: 1,
    isMobile: d.mobile,
    hasTouch: d.mobile,
    userAgent: device === 'mobile' ? MOBILE_UA : undefined,
    reducedMotion: 'reduce',
    locale: 'zh-CN',
  });
}

function collect(page: Page, logs: ConsoleEntry[]) {
  const add = (level: ConsoleEntry['level'], text: string) => {
    logs.push({ level, text: text.slice(0, 2000), ts: Date.now() });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  page.on('console', (m) => {
    // Browsers ask for /favicon.ico on their own; a missing one is not the page's problem.
    if (/favicon\.ico/.test(m.location()?.url || '')) return;
    const t = m.type();
    const level = t === 'error' ? 'error' : t === 'warning' ? 'warn' : t === 'info' ? 'info' : 'log';
    const loc = m.location();
    add(level, m.text() + (level === 'error' && loc?.url ? `  (${loc.url.replace(/^https?:\/\/[^/]+/, '')}:${loc.lineNumber})` : ''));
  });
  page.on('pageerror', (e) => add('error', `Uncaught ${e.name}: ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''}`));
  page.on('requestfailed', (r) => {
    if (r.url().includes('/__crew/')) return;
    add('error', `[network] ${r.method()} ${r.url()} 失败：${r.failure()?.errorText || ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/__crew/') && !/favicon\.ico$/.test(r.url())) add('warn', `[network] ${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

async function resolveUrl(projectId: string, pagePath?: string): Promise<string> {
  await ensurePreview(projectId);
  const p = (pagePath || '/').trim();
  if (/^https?:\/\//i.test(p)) {
    const u = new URL(p);
    return previewUrl(projectId, u.pathname + u.search + u.hash)!;
  }
  return previewUrl(projectId, p)!;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);
}

/** Scrolls through the page so lazy content and on-scroll reveals render before a full-page shot. */
async function scrollThrough(page: Page) {
  await page
    .evaluate(async () => {
      const step = window.innerHeight * 0.8;
      const max = Math.min(document.documentElement.scrollHeight, 20000);
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(200);
}

export interface ShotResult {
  png: Buffer;
  url: string;
  title: string;
  logs: ConsoleEntry[];
  truncated?: boolean;
}

export async function screenshot(opts: { projectId: string; path?: string; device?: Device; fullPage?: boolean; selector?: string; colorScheme?: ColorScheme }): Promise<ShotResult> {
  const device = opts.device || 'desktop';
  const url = await resolveUrl(opts.projectId, opts.path);
  const ctx = await newContext(device, opts.colorScheme);
  touch();
  const logs: ConsoleEntry[] = [];
  try {
    const page = await ctx.newPage();
    collect(page, logs);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await settle(page);
    let png: Buffer;
    let truncated = false;
    if (opts.selector) {
      png = await page.locator(opts.selector).first().screenshot({ timeout: 8000 });
    } else if (opts.fullPage) {
      await scrollThrough(page);
      const d = DEVICES[device];
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const maxH = d.height * 3;
      truncated = height > maxH;
      png = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: d.width, height: Math.min(height, maxH) } });
    } else {
      png = await page.screenshot();
    }
    return { png, url: page.url(), title: await page.title(), logs, truncated };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function consoleCheck(opts: { projectId: string; path?: string; waitMs?: number; colorScheme?: ColorScheme }) {
  const url = await resolveUrl(opts.projectId, opts.path);
  const ctx = await newContext('desktop', opts.colorScheme);
  touch();
  const logs: ConsoleEntry[] = [];
  try {
    const page = await ctx.newPage();
    collect(page, logs);
    const res = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await settle(page);
    await page.waitForTimeout(Math.min(opts.waitMs ?? 1500, 10_000));
    return { url: page.url(), status: res?.status() ?? 0, title: await page.title(), logs };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export interface ActStep {
  action: 'goto' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'hover' | 'wait' | 'scroll' | 'eval' | 'expect_text';
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  ms?: number;
}

function locate(page: Page, s: ActStep, forInput = false): Locator {
  if (s.selector) return page.locator(s.selector).first();
  if (s.text) {
    if (forInput) return page.getByLabel(s.text).or(page.getByPlaceholder(s.text)).first();
    return page
      .getByRole('button', { name: s.text })
      .or(page.getByRole('link', { name: s.text }))
      .or(page.getByText(s.text))
      .first();
  }
  throw new Error('需要 selector 或 text 来定位元素');
}

function describe(s: ActStep): string {
  const target = s.selector || (s.text ? `「${s.text}」` : '');
  switch (s.action) {
    case 'goto':
      return `打开 ${s.value || '/'}`;
    case 'fill':
      return `在 ${target} 输入「${s.value ?? ''}」`;
    case 'press':
      return `按键 ${s.key || s.value}${target ? ` @ ${target}` : ''}`;
    case 'select':
      return `在 ${target} 选择「${s.value}」`;
    case 'wait':
      return s.selector || s.text ? `等待 ${target} 出现` : `等待 ${s.ms ?? 500}ms`;
    case 'scroll':
      return `滚动到 ${s.value || 'bottom'}`;
    case 'eval':
      return `执行脚本`;
    case 'expect_text':
      return `确认页面包含「${s.text || s.value}」`;
    default:
      return `${s.action} ${target}`;
  }
}

export async function act(opts: { key: string; projectId: string; path?: string; steps: ActStep[]; screenshot?: boolean; device?: Device; colorScheme?: ColorScheme }) {
  const device = opts.device || 'desktop';
  let sess = sessions.get(opts.key);
  if (sess && (sess.device !== device || sess.projectId !== opts.projectId || sess.page.isClosed())) {
    await sess.ctx.close().catch(() => {});
    sessions.delete(opts.key);
    sess = undefined;
  }
  if (!sess) {
    const ctx = await newContext(device, opts.colorScheme);
    const page = await ctx.newPage();
    const logs: ConsoleEntry[] = [];
    collect(page, logs);
    sess = { ctx, page, device, colorScheme: opts.colorScheme || 'light', logs, projectId: opts.projectId };
    sessions.set(opts.key, sess);
  } else if (opts.colorScheme && opts.colorScheme !== sess.colorScheme) {
    // Switched in place, so the page, its state and any login are kept.
    await sess.page.emulateMedia({ colorScheme: opts.colorScheme });
    sess.colorScheme = opts.colorScheme;
  }
  touch();
  const { page } = sess;
  const startLog = sess.logs.length;
  const lines: string[] = [];
  if (opts.path || page.url() === 'about:blank') {
    const url = await resolveUrl(opts.projectId, opts.path);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await settle(page);
    lines.push(`✓ 打开 ${opts.path || '/'}`);
  }
  let failed = false;
  for (const s of opts.steps) {
    try {
      switch (s.action) {
        case 'goto':
          await page.goto(await resolveUrl(opts.projectId, s.value || s.text || '/'), { waitUntil: 'load', timeout: 30_000 });
          await settle(page);
          break;
        case 'click':
          await locate(page, s).click({ timeout: 6000 });
          break;
        case 'fill':
          await locate(page, s, true).fill(s.value ?? '', { timeout: 6000 });
          break;
        case 'press':
          if (s.selector || s.text) await locate(page, s, true).press(s.key || s.value || 'Enter', { timeout: 6000 });
          else await page.keyboard.press(s.key || s.value || 'Enter');
          break;
        case 'select':
          await locate(page, s).selectOption(s.value ?? '', { timeout: 6000 });
          break;
        case 'check':
          await locate(page, s).setChecked(s.value !== 'false', { timeout: 6000 });
          break;
        case 'hover':
          await locate(page, s).hover({ timeout: 6000 });
          break;
        case 'wait':
          if (s.selector || s.text) await locate(page, s).waitFor({ timeout: s.ms ?? 8000 });
          else await page.waitForTimeout(Math.min(s.ms ?? 500, 15_000));
          break;
        case 'scroll':
          await page.evaluate((v) => {
            if (v === 'top') window.scrollTo(0, 0);
            else if (!v || v === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
            else window.scrollBy(0, Number(v) || 0);
          }, s.value);
          await page.waitForTimeout(250);
          break;
        case 'eval': {
          const r = await page.evaluate(
            (code) => {
              // Runs page-side code the bot wrote, by design.
              const v = new Function(`return (${code})`)();
              return Promise.resolve(v).then((x) => {
                try {
                  return JSON.stringify(x);
                } catch {
                  return String(x);
                }
              });
            },
            s.value || s.text || 'undefined',
          );
          lines.push(`✓ 执行脚本 → ${String(r).slice(0, 1500)}`);
          continue;
        }
        case 'expect_text': {
          const want = s.text || s.value || '';
          const ok = await page
            .getByText(want)
            .first()
            .isVisible()
            .catch(() => false);
          if (!ok) throw new Error(`页面上没有看到「${want}」`);
          break;
        }
        default:
          throw new Error(`未知操作 ${(s as ActStep).action}`);
      }
      await page.waitForTimeout(150);
      lines.push(`✓ ${describe(s)}`);
    } catch (e) {
      lines.push(`✗ ${describe(s)} —— ${(e as Error).message.split('\n')[0]}`);
      failed = true;
      break;
    }
  }
  await settle(page);
  const newLogs = sess.logs.slice(startLog);
  let png: Buffer | undefined;
  if (opts.screenshot || failed) png = await page.screenshot().catch(() => undefined);
  return { lines, failed, url: page.url(), title: await page.title().catch(() => ''), logs: newLogs, png };
}

export async function resetActSession(key: string) {
  const s = sessions.get(key);
  if (s) {
    sessions.delete(key);
    await s.ctx.close().catch(() => {});
  }
}

export async function closeBrowser() {
  sessions.clear();
  const b = browser;
  browser = null;
  if (b) await b.close().catch(() => {});
}
