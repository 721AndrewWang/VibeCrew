// The text each Super-agent role sends besides its conversation, built with Crew's real code, for
// the cost profile (scripts/cost.ts, ADR 108). Imports the store: import it only once CREW_HOME
// points at a throwaway folder.

import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { crewServer } from '../server/agents/crewTools';
import { buildSystemAppend } from '../server/agents/prompts';
import type { CostInputs, StaticRole, StaticText } from '../server/bench/cost';
import { CHAT_TITLE, LEAD } from '../server/bench/prompts';
import type { RunResult } from '../server/bench/sim';
import { routerSystemPrompt } from '../server/layers/prompts';
import { routerMcpServer, routerTools } from '../server/layers/tools';
import { recallText } from '../server/recall';
import { estimateTokens } from '../server/recall/spill';
import { bots, chats, threads, triggerLog, triggerPayloadFile, workers } from '../server/store';
import { slowPrompt } from '../server/triggers/slowPath';
import { watchdogSystemPrompt } from '../server/watchdog/prompts';
import { type WatchdogEffects, watchdogMcpServer, watchdogTools } from '../server/watchdog/tools';
import { DEFAULT_POLICIES, DEFAULT_WATCHDOG } from '../shared/defaults';
import type { Bot, Chat, Project, Thread, Trigger, Worker } from '../shared/types';

const NOW = Date.now();

const BOT: Bot = {
  id: 'b_chief',
  name: LEAD,
  emoji: '',
  color: '',
  title: 'Tech lead',
  description: 'Lead the team: understand what the user wants, plan it, have it built, and keep the user posted.',
  model: '',
  effort: '' as Bot['effort'],
  permission: 'auto',
  allowRules: [],
  askRules: [],
  mcpServers: {},
  plugins: [],
  loadUserSettings: false,
  projectId: null,
  createdAt: NOW,
  updatedAt: NOW,
} as Bot;

const CHAT = {
  id: 'c_bench',
  kind: 'group',
  title: CHAT_TITLE,
  botIds: [BOT.id],
  leadBotId: BOT.id,
  projectId: 'p_site',
  createdAt: NOW,
  updatedAt: NOW,
  unread: 0,
  sessions: {},
  cursors: {},
  seq: 0,
  maxHops: 8,
} as Chat;

/** A Worker's own workspace: the project as buildSystemAppend sees it. */
const WORKSPACE = {
  id: 'p_ws',
  name: 'site',
  path: '/home/user/projects/site/.crew/worktrees/wk_1',
  createdAt: NOW,
  updatedAt: NOW,
  framework: 'Vite + React',
  workspace: { workerId: 'wk_1', branch: 'crew/wk_1', baseBranch: 'crew/bench', parentId: 'p_site' },
} as unknown as Project;

type McpConfig = { instance: unknown; name: string };

/** The tool definitions of an in-process MCP server, as Claude Code hands them to the model. */
async function toolsJson(server: McpConfig): Promise<string> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cost', version: '1.0.0' });
  await (server.instance as { connect(t: unknown): Promise<void> }).connect(a);
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return JSON.stringify(tools.map((t) => ({ name: `mcp__${server.name}__${t.name}`, description: t.description, input_schema: t.inputSchema })));
}

const noop = () => '';

function workerText(o: { subscriptions?: boolean; recall?: boolean; speculative?: boolean }): Promise<StaticText> {
  const system = buildSystemAppend({
    bot: BOT,
    chat: CHAT,
    project: WORKSPACE,
    team: [BOT],
    skills: [],
    worker: { lead: LEAD, subscriptions: o.subscriptions, speculative: o.speculative ? { checkCommand: 'npm test' } : undefined },
    recall: o.recall,
  });
  const server = crewServer({
    botId: BOT.id,
    botName: BOT.name,
    chatId: CHAT.id,
    projectId: () => WORKSPACE.id,
    currentPage: () => undefined,
    worker: true,
    workerId: 'wk_1',
    actKey: 'wk_1',
    threads: o.subscriptions ? { unsubscribe: noop, handBack: noop } : undefined,
    recall: o.recall,
    speculative: o.speculative ? { result: noop } : undefined,
  }) as unknown as McpConfig;
  return toolsJson(server).then((tools) => ({ system, tools }));
}

async function routerText(recall: boolean): Promise<StaticText> {
  const system = routerSystemPrompt({
    lead: LEAD,
    leadTitle: BOT.title,
    chat: CHAT_TITLE,
    role: BOT.description,
    team: [{ name: `${LEAD} (you)`, title: BOT.title, profile: '' }],
    maxWorkers: 4,
    subscriptions: true,
    recall,
  });
  const tools = await toolsJson(
    routerMcpServer(
      routerTools(() => null),
      { subscriptions: true, recall },
    ) as unknown as McpConfig,
  );
  return { system, tools };
}

async function watchdogText(): Promise<StaticText> {
  const system = watchdogSystemPrompt({ maxActions: DEFAULT_WATCHDOG.maxActionsPerTick, stuckMinutes: DEFAULT_WATCHDOG.stuckMinutes });
  const tools = await toolsJson(watchdogMcpServer(watchdogTools(() => null, {} as WatchdogEffects)) as unknown as McpConfig);
  return { system, tools };
}

export async function buildInputs(claudeCodeTokens: number): Promise<CostInputs> {
  const statics: Record<StaticRole, StaticText> = {
    router: await routerText(false),
    'router-recall': await routerText(true),
    worker: await workerText({}),
    'worker-direct': await workerText({ subscriptions: true }),
    'worker-recall': await workerText({ subscriptions: true, recall: true }),
    speculative: await workerText({ speculative: true }),
    watchdog: await watchdogText(),
    // The slow path: its one-line system prompt and the fixed part of every prompt (the default policies, the rules).
    filter: { system: `You are an event filter. Reply only with the requested JSON.\n${slowPrompt([], DEFAULT_POLICIES)}`, tools: '' },
  };
  return {
    statics,
    claudeCodeTokens,
    watchdog: { everyMinutes: DEFAULT_WATCHDOG.everyMinutes, stuckMinutes: DEFAULT_WATCHDOG.stuckMinutes, maxActionsPerTick: DEFAULT_WATCHDOG.maxActionsPerTick },
  };
}

/**
 * Real recall results for the objects of a run with the chain of recall on: its Workers, the
 * workspace thread and the CI triggers on it, stored in the throwaway store and read back through
 * recall as the Router would. Mean tokens per kind.
 */
export function recallResults(run: RunResult | undefined): Record<string, number> {
  if (!run?.timeline?.length) return {};
  bots.set(BOT);
  chats.set(CHAT);
  const thread: Thread = { id: 'th_ws', key: 'workspace:p_site', kind: 'workspace', title: `Workspace: ${CHAT_TITLE}`, projectId: 'p_site', chatId: null, createdAt: NOW, lastAt: NOW, count: 0 };
  for (const w of run.timeline) {
    const rec: Worker = {
      id: w.id,
      chatId: CHAT.id,
      botId: BOT.id,
      title: w.title,
      task: w.task,
      status: w.status as Worker['status'],
      createdAt: NOW + w.createdAt,
      updatedAt: NOW + (w.endedAt ?? w.createdAt),
      projectId: null,
      turns: w.turns,
      costUsd: 0,
      related: [],
      threads: [thread.id],
      ...(w.report ? { report: { at: NOW + (w.endedAt ?? 0), status: w.status === 'done' ? 'done' : 'stopped', text: w.report } } : {}),
    } as Worker;
    workers.set(rec);
  }
  const failing = Object.entries(run.triggers).length ? run.timeline.slice(0, 6) : [];
  failing.forEach((w, i) => {
    const t: Trigger = {
      id: `tg_cost_${i + 1}`,
      at: NOW + w.createdAt + 60_000,
      source: 'preview-console',
      threadId: thread.id,
      projectId: 'p_site',
      chatId: CHAT.id,
      summary: `CI failed on crew/${w.title.slice(0, 3)}: 2 tests failing`,
      ref: { kind: 'payload' },
      related: [],
      explicit: false,
      fingerprint: `cost${i}`,
      filter: { verdict: 'act', stage: 'fast', rule: 'subscribed', reason: 'Sent straight to the Worker subscribed to this thread; no Router decision', direct: [w.id] },
    } as Trigger;
    fs.mkdirSync(path.dirname(triggerPayloadFile(t.id)), { recursive: true });
    fs.writeFileSync(triggerPayloadFile(t.id), JSON.stringify({ text: `${t.summary}\n${'FAIL src/checkout.test.ts > totals > applies the discount\n  expected 90 to be 81\n'.repeat(6)}` }));
    triggerLog.append(t);
  });
  thread.count = failing.length;
  threads.set(thread);
  const mean = (texts: string[]) => (texts.length ? Math.round(texts.reduce((s, t) => s + estimateTokens(t), 0) / texts.length) : 0);
  const read = (id: string) => {
    const r = recallText(id, { chatId: CHAT.id });
    return 'error' in r ? '' : r.text;
  };
  return {
    worker: mean(run.timeline.map((w) => read(w.id)).filter(Boolean)),
    thread: mean([read(thread.id)].filter(Boolean)),
    trigger: mean(failing.map((_, i) => read(`tg_cost_${i + 1}`)).filter(Boolean)),
  };
}
