// What a bot's turn runs with: its effective settings, environment, MCP servers, and the context
// lines and images that go into its prompt.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Bot, Chat, ChatMessage, Project } from '../../shared/types';
import { modelEnv } from '../claudeAuth';
import { cleanEnv } from '../config';
import { PLUGINS } from '../data/catalog';
import { devServer } from '../devserver';
import { configOf, devCommand } from '../projects';
import { ALWAYS_ALLOWED, sandboxStatus } from '../sandbox';
import { settings } from '../store';
import { IMAGE_MIMES, readUpload } from '../uploads';

/** projectId -> page the user is looking at in the preview. */
const previewPages = new Map<string, string>();

export function setPreviewPage(projectId: string, page: string) {
  previewPages.set(projectId, page);
}

export function previewPageOf(projectId: string): string | undefined {
  return previewPages.get(projectId);
}

/**
 * A bot as it works in this chat: the chat's switches (composer) override its own settings. A
 * read-only bot (a reviewer, say) stays read-only; that is its role, changed on the bot itself.
 */
export function effectiveBot(chat: Chat, bot: Bot): Bot {
  return {
    ...bot,
    permission: bot.permission === 'plan' ? 'plan' : chat.permission || bot.permission,
    model: chat.model !== undefined ? chat.model : bot.model,
    effort: chat.effort !== undefined ? chat.effort : bot.effort,
  };
}

/** The bots' environment: which endpoint, credentials and models their Claude Code uses. */
export function agentEnv(): Record<string, string> {
  return cleanEnv(modelEnv());
}

function substitute(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? process.env[k] ?? '');
}

/** MCP servers for a bot: enabled catalog plugins plus custom entries. */
export function pluginServers(bot: Bot): Record<string, McpServerConfig> {
  const secrets = settings.get().pluginSecrets || {};
  const out: Record<string, McpServerConfig> = {};
  const add = (name: string, e: (typeof PLUGINS)[number]['server']) => {
    if (e.type === 'http' || e.type === 'sse') {
      out[name] = {
        type: e.type,
        url: substitute(e.url || '', secrets),
        headers: Object.fromEntries(Object.entries(e.headers || {}).map(([k, v]) => [k, substitute(v, secrets)])),
      };
    } else if (e.command) {
      out[name] = {
        type: 'stdio',
        command: e.command,
        args: (e.args || []).map((a) => substitute(a, secrets)),
        env: Object.fromEntries(Object.entries(e.env || {}).map(([k, v]) => [k, substitute(v, secrets)])),
      };
    }
  };
  for (const id of bot.plugins || []) {
    const p = PLUGINS.find((x) => x.id === id);
    if (p) add(p.id, p.server);
  }
  for (const [name, e] of Object.entries(bot.mcpServers || {})) {
    if (name !== 'crew') add(name, e);
  }
  return out;
}

export function contextLines(project: Project | null): string[] {
  const now = new Date();
  const week = '日一二三四五六'[now.getDay()];
  const lines = [`时间：${now.toLocaleString('zh-CN', { hour12: false })}（周${week}）`];
  if (!project) return lines;
  const cmd = devCommand(project);
  const ds = devServer(project.id).state;
  if (!cmd) lines.push('预览：静态网页，由 Crew 直接提供，保存文件后自动刷新。');
  else if (ds.status === 'running') lines.push(`开发服务器：运行中 ${ds.url}（命令 ${ds.command}）`);
  else if (ds.status === 'installing' || ds.status === 'starting') lines.push(`开发服务器：${ds.status === 'installing' ? '正在安装依赖' : '正在启动'}（${cmd}）`);
  else lines.push(`开发服务器：未运行（需要 ${cmd}，可以用 dev_server 工具启动）${ds.error ? `，上次错误：${ds.error}` : ''}`);
  const page = previewPages.get(project.id);
  if (page) lines.push(`用户正在预览的页面：${page}`);
  const conf = configOf(project);
  const denied = settings.get().denyRules || [];
  if (denied.length) lines.push(`禁止的操作（系统会直接拒绝，不要尝试，也不要换写法绕过）：${denied.join('、')}`);
  const sb = settings.get().sandbox;
  if (sb.enabled && sandboxStatus().available) {
    const domains = [...ALWAYS_ALLOWED, ...sb.allowedDomains, ...(conf.allowedDomains || [])];
    lines.push(`你运行的命令在沙盒里：只能访问本机和这些域名：${domains.join('、')}。连不上别的主机是设计如此，不要找办法绕过；需要别的域名就直接告诉用户，让用户在设置里添加。`);
  }
  if (conf.commitGuide) lines.push(`这个项目的提交信息要求：${conf.commitGuide}`);
  if (conf.noAttribution) lines.push('这个项目的提交和 PR 里不要加任何 AI 署名（Co-Authored-By、Generated with 之类）。');
  return lines;
}

export function imageBlocks(list: ChatMessage[]) {
  const out: { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }[] = [];
  for (const m of list) {
    for (const a of m.attachments || []) {
      if (a.kind !== 'image' || !IMAGE_MIMES.has(a.mime)) continue;
      const img = readUpload(a.url);
      if (img) out.push({ type: 'image', source: { type: 'base64', media_type: img.mime as 'image/png', data: img.data } });
      if (out.length >= 8) return out;
    }
  }
  return out;
}
