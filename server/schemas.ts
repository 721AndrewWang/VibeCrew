// What the API accepts, checked at the door. The shared types say what is stored; these say what
// a request may contain, and a request that does not fit gets a 400 naming the field, instead of
// reaching the entity code or the JSON files. Trimming, defaults and cross-checks (does the bot
// exist?) stay where they were.

import { z } from 'zod';
import { HttpError } from './projects';

const PERMISSION = z.enum(['auto', 'edits', 'ask', 'review', 'plan']);
const EFFORT = z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']);
const id = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);
const rules = z.array(text(300)).max(100);
const stringMap = z.record(z.string(), z.string());

const mcpServer = z.object({
  type: z.enum(['stdio', 'http', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
  url: z.string().optional(),
  headers: stringMap.optional(),
});

const botFields = {
  name: text(40),
  emoji: text(16),
  color: text(32),
  title: text(200),
  description: text(20_000),
  model: text(200),
  effort: EFFORT,
  permission: PERMISSION,
  allowRules: rules,
  askRules: rules,
  mcpServers: z.record(z.string(), mcpServer),
  plugins: z.array(text(64)).max(100),
  loadUserSettings: z.boolean(),
  projectId: id.nullable(),
  editScope: z.array(text(300)).max(50),
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
  freshSession: z.boolean(),
};

export const BotCreate = z.object({ ...botFields, template: text(64) }).partial();
export const BotPatch = z.object(botFields).partial();

export const GroupCreate = z.object({
  title: text(200).optional(),
  botIds: z.array(id).min(1).max(50),
  leadBotId: id.nullable().optional(),
  projectId: id.nullable().optional(),
});

export const ChatPatch = z
  .object({
    title: text(200),
    botIds: z.array(id).min(1).max(50),
    leadBotId: id.nullable(),
    projectId: id.nullable(),
    pinned: z.boolean(),
    maxHops: z.number().int().min(0).max(30),
    // The composer's switches; null goes back to each bot's own setting.
    permission: PERMISSION.nullable(),
    model: text(200).nullable(),
    effort: EFFORT.nullable(),
  })
  .partial();

export const MessageSend = z.object({
  text: text(200_000).default(''),
  attachments: z
    .array(z.looseObject({ kind: z.string(), name: z.string().optional() }))
    .max(20)
    .optional(),
});

export const Approval = z.object({ decision: z.enum(['allow', 'always', 'deny']), message: text(2000).optional() });

export const ProjectPatch = z
  .object({
    name: text(200),
    devCommand: text(2000),
    staticRoot: text(500),
    setupCommand: text(2000),
    commitGuide: text(2000),
    noAttribution: z.boolean(),
    askRules: z.array(text(300)).max(50),
    allowedDomains: z.array(text(300)).max(100),
  })
  .partial();

export const ProjectOpen = z.object({
  mode: z.enum(['open', 'create']).default('create'),
  path: text(1000).optional(),
  name: text(200).optional(),
  template: text(64).optional(),
  parentDir: text(1000).optional(),
  folder: text(200).optional(),
});

export const Trigger = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('interval'),
    minutes: z
      .number()
      .min(1)
      .max(60 * 24 * 365),
  }),
  z.object({ type: z.literal('daily'), time: z.string().regex(/^\d{1,2}:\d{2}$/, '时间要写成 HH:MM'), days: z.array(z.number().int().min(0).max(6)).max(7).optional() }),
  z.object({ type: z.literal('cron'), expr: text(100) }),
  z.object({ type: z.literal('file_change'), debounceSec: z.number().min(0).max(3600) }),
  z.object({ type: z.literal('git_commit') }),
  z.object({ type: z.literal('manual') }),
]);

export const RoutineSave = z.object({
  id: id.optional(),
  name: text(200).default(''),
  enabled: z.boolean().optional(),
  botId: id,
  chatId: id.nullable().optional(),
  prompt: text(20_000),
  trigger: Trigger,
});

export const SkillSave = z.object({
  name: text(40),
  title: text(200).optional(),
  description: text(2000).optional(),
  icon: text(16).optional(),
  argsHint: text(200).optional(),
  body: text(100_000).optional(),
  previousName: text(40).optional(),
});

// Connection fields (authMode, apiKey, provider…) are read by connectionPatch; anything else here
// is checked, and unknown keys are ignored as before.
export const SettingsPatch = z
  .looseObject({
    defaultModel: text(200),
    lanEnabled: z.boolean(),
    projectsRoot: text(1000),
    defaultPermission: PERMISSION,
    maxHops: z.number().min(0).max(30),
    logo: text(32),
    denyRules: z.array(z.unknown()).max(200),
    sandbox: z.object({ enabled: z.boolean().optional(), allowedDomains: z.array(text(300)).max(200).optional() }),
    pluginSecrets: z.record(z.string(), z.unknown()),
    authMode: z.enum(['claude-code', 'api-key', 'provider']),
    apiKey: text(500),
    baseUrl: text(500),
    providerToken: text(500),
    provider: z.object({ preset: text(64).optional(), baseUrl: text(500).optional(), model: text(200).optional(), fastModel: text(200).optional() }),
  })
  .partial();

export const Upload = z.object({ mime: text(100), data: z.string().max(30_000_000), name: text(200).optional() });

/** Parses a request body with the schema; a mismatch is a 400 that names the field. */
export function body<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue.path.length ? issue.path.map(String).join('.') : '请求内容';
  throw new HttpError(400, `${field}：${explain(issue)}`);
}

function explain(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `应为 ${TYPE_NAMES[issue.expected] || issue.expected}`;
    case 'invalid_value':
      return `只能是 ${issue.values.map((v) => JSON.stringify(v)).join('、')} 之一`;
    case 'too_big':
      return issue.origin === 'string' ? `最多 ${issue.maximum} 个字符` : `最多 ${issue.maximum}`;
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array' ? '不能为空' : `至少 ${issue.minimum}`;
    case 'invalid_union':
      return '格式不对';
    default:
      return issue.message;
  }
}

const TYPE_NAMES: Record<string, string> = { string: '文字', number: '数字', boolean: '是/否', array: '列表', object: '对象', int: '整数' };
