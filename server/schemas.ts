// What the API accepts, checked at the door. The shared types say what is stored; these say what
// a request may contain, and a request that does not fit gets a 400 naming the field, instead of
// reaching the entity code or the JSON files. Trimming, defaults and cross-checks (does the bot
// exist?) stay where they were.

import { z } from 'zod';
import { LOGIN_RE, MAX_AUTHORS, MAX_REPOS, REPO_RE } from './github/config';
import { HttpError } from './projects';

const PERMISSION = z.enum(['auto', 'edits', 'ask', 'review', 'plan']);
const FAMILY = z.enum(['triage', 'reproduce', 'draft-fix', 'review', 'release', 'repo-health']);
const MODE = z.enum(['chat', 'worker', 'speculative']);
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
  blindReview: z.boolean(),
  fullDuplex: z.boolean(),
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
    requireChallenge: z.boolean(),
    autoChallenge: z.object({ enabled: z.boolean(), paths: z.array(text(200)).max(50), minLines: z.number().int().min(0).max(100_000) }),
    skillFamilies: z.array(FAMILY).max(20),
    passEnv: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'should be variable names (letters, digits, _)')
          .max(200),
      )
      .max(50),
    github: z.object({
      enabled: z.boolean(),
      repos: z.array(z.string().regex(REPO_RE, 'should be owner/name')).max(MAX_REPOS),
      everyMinutes: z.number().int().min(1).max(1440),
      authors: z.array(z.string().regex(LOGIN_RE, 'should be GitHub logins')).max(MAX_AUTHORS),
      events: z.object({ issues: z.boolean(), comments: z.boolean(), reviewComments: z.boolean(), checks: z.boolean() }),
      candidates: z.boolean(),
    }),
  })
  .partial();

/** Poll a project's GitHub repositories now (ADR 102). */
export const GithubPoll = z.object({ projectId: id });

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
  z.object({ type: z.literal('daily'), time: z.string().regex(/^\d{1,2}:\d{2}$/, 'Time must be written as HH:MM'), days: z.array(z.number().int().min(0).max(6)).max(7).optional() }),
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
  family: FAMILY.nullable().optional(),
  modes: z.array(MODE).max(3).optional(),
  readOnly: z.boolean().optional(),
});

const sourceRule = z.object({ mode: z.enum(['explicit', 'candidate', 'ignore']), allow: z.array(text(300)).max(50) }).partial();

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
    routing: z.object({ mode: z.enum(['off', 'shadow']) }),
    rotateAtTokens: z.number().int().min(0).max(2_000_000),
    wrapUpAtTokens: z.number().int().min(0).max(2_000_000),
    push: z.object({ barkUrl: text(500).optional(), afterMinutes: z.number().int().min(1).max(240).optional() }),
    pluginSecrets: z.record(z.string(), z.unknown()),
    authMode: z.enum(['claude-code', 'api-key', 'provider']),
    apiKey: text(500),
    baseUrl: text(500),
    providerToken: text(500),
    provider: z.object({ preset: text(64).optional(), baseUrl: text(500).optional(), model: text(200).optional(), fastModel: text(200).optional() }),
    superAgent: z
      .object({
        enabled: z.boolean(),
        sources: z.object({ turn: sourceRule, 'outside-edit': sourceRule, 'preview-console': sourceRule }).partial(),
        projects: z.array(id).max(200),
        policies: text(10_000),
        maxCandidatesPerHour: z.number().int().min(0).max(1000),
        router: z.object({ enabled: z.boolean(), model: text(200), workerModel: text(200), maxWorkers: z.number().int().min(1).max(8), subscriptions: z.boolean() }).partial(),
        recall: z.object({ enabled: z.boolean(), inlineWords: z.number().int().min(20).max(200) }).partial(),
        watchdog: z
          .object({
            enabled: z.boolean(),
            model: text(200),
            everyMinutes: z.number().int().min(1).max(60),
            maxTicksPerHour: z.number().int().min(1).max(60),
            maxActionsPerTick: z.number().int().min(0).max(10),
            dailyBudgetUsd: z.number().min(0).max(100),
            stuckMinutes: z.number().int().min(5).max(240),
          })
          .partial(),
      })
      .partial(),
    // Shapes only; normalizeGateway drops what does not parse (bad ids, URLs, members).
    gateway: z
      .object({
        enabled: z.boolean(),
        port: z.number().int().min(0).max(65535),
        providers: z.array(z.looseObject({ id: text(40), baseUrl: text(500) })).max(50),
        groups: z.array(z.looseObject({ id: text(40), members: z.array(text(200)).max(20) })).max(50),
        defaultTarget: text(200),
        fastTarget: text(200),
        roles: z.record(z.string(), text(200)),
        windows: z.array(z.looseObject({ role: text(20) })).max(50),
        masking: z.boolean(),
      })
      .partial(),
    /** Provider id → key; '' removes it. */
    gatewayTokens: z.record(z.string(), z.string().max(2000)),
    safety: z.object({ guard: z.boolean(), stripCredentials: z.boolean(), audit: z.boolean() }).partial(),
  })
  .partial();

export const GatewayTestBody = z.object({ target: text(200) });

/** Console output the preview reported, forwarded by the UI while the Super-agent is on. */
export const PreviewConsole = z.object({
  projectId: id,
  chatId: id.nullable().optional(),
  page: text(2000).default('/'),
  entries: z
    .array(z.object({ level: z.enum(['error', 'warn', 'info', 'log']), text: text(20_000), ts: z.number(), source: text(2000).optional() }))
    .min(1)
    .max(100),
});

/** The user takes a Worker off one of its Threads (ADR 003). */
export const WorkerUnsubscribe = z.object({ threadId: id });

/** A draft of an external action: its kind and fields; Crew builds the exact command from them. */
export const DraftInput = z.object({
  kind: z.enum(['git-push', 'pr-open', 'pr-comment', 'issue-open', 'issue-comment', 'review-reply', 'message']),
  remote: text(200).optional(),
  branch: text(200).optional(),
  number: z.number().int().min(1).max(10_000_000).optional(),
  comment: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  title: text(300).optional(),
  body: text(60_000).optional(),
  base: text(200).optional(),
  head: text(200).optional(),
  repo: text(200).optional(),
  channel: text(200).optional(),
  why: text(1000).optional(),
});

/** A command for the guard's dry run (Settings → Safety). */
export const GuardCheck = z.object({ command: text(20_000), projectId: id.nullable().optional() });

export const ImprovementReject = z.object({ note: text(500).optional() });

export const SkillDraftRequest = z.object({ chatId: id, messageId: id });

/** A new value for a proposed change to a bot's setting; checked against that field's own schema. */
export const SettingEdit = z.object({ value: z.unknown() });

export const Upload = z.object({ mime: text(100), data: z.string().max(30_000_000), name: text(200).optional() });

/** Parses a request body with the schema; a mismatch is a 400 that names the field. */
export function body<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue.path.length ? issue.path.map(String).join('.') : 'request body';
  throw new HttpError(400, `${field}: ${explain(issue)}`);
}

function explain(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `should be ${TYPE_NAMES[issue.expected] || issue.expected}`;
    case 'invalid_value':
      return `must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'too_big':
      return issue.origin === 'string' ? `at most ${issue.maximum} characters` : `at most ${issue.maximum}`;
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array' ? "can't be empty" : `at least ${issue.minimum}`;
    case 'invalid_union':
      return 'invalid format';
    default:
      return issue.message;
  }
}

const TYPE_NAMES: Record<string, string> = { string: 'text', number: 'a number', boolean: 'true/false', array: 'a list', object: 'an object', int: 'an integer' };

/** A maintainer's message to the Watchdog. */
export const WatchdogMessage = z.object({ text: text(4000).min(1) });
