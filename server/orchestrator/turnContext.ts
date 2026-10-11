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
  const lines = [`Time: ${now.toLocaleString('en-US', { hour12: false })} (${now.toLocaleDateString('en-US', { weekday: 'long' })})`];
  if (!project) return lines;
  const cmd = devCommand(project);
  const ds = devServer(project.id).state;
  if (!cmd) lines.push('Preview: static site served directly by Crew; it refreshes automatically when files are saved.');
  else if (ds.status === 'running') lines.push(`Dev server: running at ${ds.url} (command: ${ds.command})`);
  else if (ds.status === 'installing' || ds.status === 'starting') lines.push(`Dev server: ${ds.status === 'installing' ? 'installing dependencies' : 'starting'} (${cmd})`);
  else lines.push(`Dev server: not running (needs ${cmd}; start it with the dev_server tool)${ds.error ? `. Last error: ${ds.error}` : ''}`);
  const page = previewPages.get(project.id);
  if (page) lines.push(`Page the user is previewing: ${page}`);
  const conf = configOf(project);
  const denied = settings.get().denyRules || [];
  if (denied.length) lines.push(`Blocked actions (the system refuses them outright; don't try them or work around them with a different command): ${denied.join(', ')}`);
  const sb = settings.get().sandbox;
  if (sb.enabled && sandboxStatus().available) {
    const domains = [...ALWAYS_ALLOWED, ...sb.allowedDomains, ...(conf.allowedDomains || [])];
    lines.push(
      `Your commands run in a sandbox: they can only reach this machine and these domains: ${domains.join(', ')}. Not being able to reach other hosts is by design, so don't look for a way around it; if you need another domain, tell the user and let them add it in Settings. To reach a service already running on this machine from a command (the preview, the dev server, APIs on localhost), prefix the command with env -u no_proxy -u NO_PROXY, or it won't connect; to look at pages, prefer Crew's browser tools.`,
    );
  }
  if (conf.commitGuide) lines.push(`Commit message rules for this project: ${conf.commitGuide}`);
  if (conf.noAttribution) lines.push("Don't add any AI attribution (Co-Authored-By, Generated with, and the like) to this project's commits and PRs.");
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
