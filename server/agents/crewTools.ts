import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConsoleEntry } from '../../shared/types';
import { act, consoleCheck, screenshot } from '../browser';
import { notify } from '../bus';
import { devServer } from '../devserver';
import { bots, messages } from '../store';
import { appendMemory } from './prompts';

export interface CrewContext {
  botId: string;
  botName: string;
  chatId: string;
  projectId: () => string | null;
  /** The page the user is looking at in the preview. */
  currentPage: () => string | undefined;
  /** A blind reviewer: chat_history shows it the user's messages only. */
  blind?: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function fail(t: string) {
  return { content: [{ type: 'text' as const, text: t }], isError: true };
}

function fmtLogs(logs: ConsoleEntry[], limit = 40): string {
  const order = { error: 0, warn: 1, info: 2, log: 3 } as const;
  const sorted = [...logs].sort((a, b) => order[a.level] - order[b.level]);
  const lines = sorted.slice(0, limit).map((l) => `[${l.level}] ${l.text}`);
  if (logs.length > limit) lines.push(`…以及另外 ${logs.length - limit} 条`);
  return lines.join('\n');
}

const device = z.enum(['desktop', 'tablet', 'mobile']).optional().describe('设备尺寸：desktop 1280×800、tablet 820×1180、mobile 390×844，默认 desktop');

export function crewServer(ctx: CrewContext) {
  const projectId = () => {
    const id = ctx.projectId();
    if (!id) throw new Error('当前对话没有绑定项目');
    return id;
  };
  const pagePath = (p?: string) => p || ctx.currentPage() || '/';

  return createSdkMcpServer({
    name: 'crew',
    version: '1.0.0',
    tools: [
      tool(
        'chat_history',
        '读这个对话里消息的全文。群聊里较早的、和这一轮关系不大的队友消息只给了一行摘要（带 #编号），需要细节时用它查；也可以看最近几条。',
        {
          seqs: z.array(z.number().int()).max(20).optional().describe('要看的消息编号（摘要里的 #后面的数字）'),
          last: z.number().int().min(1).max(20).optional().describe('看最近的几条消息'),
        },
        async ({ seqs, last }) => {
          const all = messages.sorted(ctx.chatId).filter((m) => !m.uiOnly && m.status !== 'streaming' && (!ctx.blind || m.role === 'user'));
          const picked = seqs?.length ? all.filter((m) => seqs.includes(m.seq)) : all.slice(-(last || 5));
          if (!picked.length) return fail('没有找到这些消息。');
          const who = (m: (typeof all)[number]) => (m.role === 'user' ? '用户' : m.role === 'system' ? '系统' : `@${bots.get(m.botId || '')?.name || '队友'}`);
          return text(picked.map((m) => `【${who(m)} · #${m.seq}】\n${(m.prompt || m.text).trim() || '（没有文字）'}`).join('\n\n'));
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'preview_screenshot',
        '用真实的浏览器打开项目预览并截图，返回图片和控制台错误摘要。修改界面后用它确认实际效果；可以指定页面、设备尺寸、整页截图或只截某个元素。',
        {
          path: z.string().optional().describe('页面路径，例如 / 或 /about；不填则是用户当前正在看的页面'),
          device,
          fullPage: z.boolean().optional().describe('截取整页（最多 3 屏高）'),
          selector: z.string().optional().describe('只截取匹配这个 CSS 选择器的元素'),
        },
        async (args) => {
          try {
            const r = await screenshot({ projectId: projectId(), path: pagePath(args.path), device: args.device, fullPage: args.fullPage, selector: args.selector });
            const issues = r.logs.filter((l) => l.level === 'error' || l.level === 'warn');
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            return {
              content: [
                { type: 'image' as const, data: r.png.toString('base64'), mimeType: 'image/png' },
                {
                  type: 'text' as const,
                  text: `页面 ${where}（${r.title || '无标题'}），${args.device || 'desktop'}${r.truncated ? '，页面较长只截取了前 3 屏' : ''}。\n${issues.length ? `控制台问题：\n${fmtLogs(issues)}` : '控制台没有错误或警告。'}`,
                },
              ],
            };
          } catch (e) {
            return fail(`截图失败：${(e as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'preview_console',
        '在浏览器中打开项目预览页面，收集控制台日志、未捕获异常和失败的网络请求。',
        {
          path: z.string().optional().describe('页面路径，不填则是用户当前正在看的页面'),
          waitMs: z.number().optional().describe('页面加载后再等待多少毫秒收集日志，默认 1500'),
        },
        async (args) => {
          try {
            const r = await consoleCheck({ projectId: projectId(), path: pagePath(args.path), waitMs: args.waitMs });
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            if (!r.logs.length) return text(`页面 ${where}（HTTP ${r.status}，${r.title || '无标题'}）：控制台干净，没有日志。`);
            return text(`页面 ${where}（HTTP ${r.status}，${r.title || '无标题'}）共 ${r.logs.length} 条日志：\n${fmtLogs(r.logs, 60)}`);
          } catch (e) {
            return fail(`打开页面失败：${(e as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'browser_act',
        '像真实用户一样在项目预览中操作页面：打开页面、点击、输入、按键、选择、勾选、悬停、等待、滚动、执行脚本、确认页面包含某段文字。页面和登录状态在多次调用之间保留。遇到失败会停下并附带截图。',
        {
          path: z.string().optional().describe('先打开这个页面路径；不填则在当前页面继续（第一次调用会打开用户正在看的页面）'),
          steps: z
            .array(
              z.object({
                action: z.enum(['goto', 'click', 'fill', 'press', 'select', 'check', 'hover', 'wait', 'scroll', 'eval', 'expect_text']),
                selector: z.string().optional().describe('CSS 选择器'),
                text: z.string().optional().describe('按可见文字/标签/占位符定位元素（代替 selector）；expect_text 时是要确认的文字'),
                value: z.string().optional().describe('fill 的内容、select 的选项、goto 的路径、scroll 的 top/bottom/像素、eval 的 JS 表达式、check 的 true/false'),
                key: z.string().optional().describe('press 的按键，如 Enter、Escape、Tab'),
                ms: z.number().optional().describe('wait 的毫秒数或超时'),
              }),
            )
            .describe('按顺序执行的操作'),
          screenshot: z.boolean().optional().describe('操作结束后附带截图'),
          device,
        },
        async (args) => {
          try {
            const r = await act({
              key: `${ctx.chatId}:${ctx.botId}`,
              projectId: projectId(),
              path: args.path,
              steps: args.steps,
              screenshot: args.screenshot,
              device: args.device,
            });
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            const summary = [...r.lines, '', `当前页面：${where}（${r.title || '无标题'}）`, r.logs.length ? `期间的控制台日志：\n${fmtLogs(r.logs)}` : '期间没有控制台日志。'].join('\n');
            const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
            if (r.png) content.push({ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' });
            content.push({ type: 'text', text: summary });
            return { content, isError: r.failed || undefined };
          } catch (e) {
            return fail(`浏览器操作失败：${(e as Error).message}`);
          }
        },
      ),
      tool(
        'dev_server',
        '管理项目的开发服务器（预览依赖它）：start 启动（缺依赖时会自动安装）、stop 停止、restart 重启、status 查看状态、logs 查看最近日志。',
        { action: z.enum(['start', 'stop', 'restart', 'status', 'logs']) },
        async ({ action }) => {
          try {
            const ds = devServer(projectId());
            if (action === 'stop') {
              await ds.stop();
              return text('开发服务器已停止。');
            }
            if (action === 'start' || action === 'restart') {
              if (action === 'restart') await ds.restart();
              else await ds.start();
              const deadline = Date.now() + 120_000;
              while (Date.now() < deadline && (ds.state.status === 'installing' || (ds.state.status === 'starting' && !ds.state.url))) {
                await new Promise((r) => setTimeout(r, 500));
              }
            }
            const s = ds.state;
            const tail = ds
              .logs(action === 'logs' ? 6000 : 1500)
              .replace(ANSI, '')
              .replace(/\r/g, '');
            const status = { stopped: '未运行', installing: '安装依赖中', starting: '启动中', running: '运行中', error: '出错' }[s.status];
            return text(
              `状态：${status}${s.command ? `\n命令：${s.command}` : ''}${s.url ? `\n地址：${s.url}` : ''}${s.error ? `\n错误：${s.error}` : ''}${tail.trim() ? `\n\n最近日志：\n${tail.trim()}` : ''}`,
            );
          } catch (e) {
            return fail((e as Error).message);
          }
        },
      ),
      tool(
        'remember',
        '把值得长期记住的信息写入你的长期记忆（跨对话保留），例如用户的偏好、项目约定、踩过的坑。一次记一条，简短具体。',
        { note: z.string().describe('要记住的内容') },
        async ({ note }) => {
          appendMemory(ctx.botId, note);
          return text('已记住。');
        },
      ),
      tool('notify_user', '给用户发送一条桌面/手机通知。用于定时任务或长任务中发现需要用户关注的事情。', { title: z.string(), body: z.string() }, async ({ title, body }) => {
        notify(`${ctx.botName}：${title}`, body, { chatId: ctx.chatId, level: 'info' });
        return text('通知已发送。');
      }),
    ],
  });
}
