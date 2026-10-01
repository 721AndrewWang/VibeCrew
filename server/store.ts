import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOGO, isLogoId, type LogoId } from '../shared/logos';
import type { AuthMode, Bot, Chat, ChatMessage, PermissionLevel, Project, ProviderSettings, PublicSettings, Routine, SandboxSettings } from '../shared/types';
import { DATA, DEFAULT_PROJECTS_ROOT } from './config';
import { SCHEMA_VERSION } from './migrations';
import { DEFAULT_ALLOWED } from './sandbox';

export function uid(prefix = ''): string {
  return prefix + crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file: string, data: unknown, mode?: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

const pendingFlushes = new Set<() => void>();

/** Writes every store that has unsaved changes. Called on shutdown. */
export function flushAll() {
  for (const f of [...pendingFlushes]) f();
}

/** A keyed collection persisted as one JSON file, saved with a short debounce. */
export class Collection<T extends { id: string }> {
  private items = new Map<string, T>();
  private timer: NodeJS.Timeout | null = null;
  private readonly flushFn = () => this.flush();

  constructor(private file: string) {
    for (const item of readJson<T[]>(file, [])) this.items.set(item.id, item);
  }

  all(): T[] {
    return [...this.items.values()];
  }

  get(id: string | null | undefined): T | undefined {
    return id ? this.items.get(id) : undefined;
  }

  has(id: string) {
    return this.items.has(id);
  }

  set(item: T): T {
    this.items.set(item.id, item);
    this.save();
    return item;
  }

  delete(id: string) {
    const ok = this.items.delete(id);
    if (ok) this.save();
    return ok;
  }

  /** Marks the collection dirty after an in-place mutation. */
  save() {
    if (this.timer) return;
    pendingFlushes.add(this.flushFn);
    this.timer = setTimeout(this.flushFn, 300);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    pendingFlushes.delete(this.flushFn);
    writeJsonAtomic(this.file, this.all());
  }
}

export interface Settings {
  /** Shape of the data folder; see migrations.ts. */
  schemaVersion: number;
  defaultModel: string;
  authMode: AuthMode;
  apiKey: string;
  baseUrl: string;
  /** Another provider's Anthropic-compatible endpoint (authMode 'provider'). */
  provider: ProviderSettings;
  /** Sent as ANTHROPIC_AUTH_TOKEN; never leaves the server. */
  providerToken: string;
  lanEnabled: boolean;
  port: number;
  projectsRoot: string;
  defaultPermission: PermissionLevel;
  maxHops: number;
  /** Also read by the desktop app (desktop/main.cjs) for its window, tray and Dock icons. */
  logo: LogoId;
  /** Refused for every bot, whatever its permission mode (PublicSettings.denyRules). */
  denyRules: string[];
  sandbox: SandboxSettings;
  /** Secret for LAN access and API calls. */
  token: string;
  /** Values for ${VAR} placeholders in plugin configs (e.g. GITHUB_TOKEN). */
  pluginSecrets: Record<string, string>;
  initialized: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  defaultModel: '',
  authMode: 'claude-code',
  apiKey: '',
  baseUrl: '',
  provider: { preset: '', baseUrl: '', model: '', fastModel: '' },
  providerToken: '',
  lanEnabled: false,
  port: 4321,
  projectsRoot: DEFAULT_PROJECTS_ROOT,
  defaultPermission: 'edits',
  maxHops: 8,
  logo: DEFAULT_LOGO,
  denyRules: [],
  sandbox: { enabled: true, allowedDomains: [...DEFAULT_ALLOWED] },
  token: '',
  pluginSecrets: {},
  initialized: false,
};

class SettingsStore {
  private data: Settings;

  constructor() {
    this.data = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(DATA.settings, {}) };
    if (!isLogoId(this.data.logo)) this.data.logo = DEFAULT_LOGO;
    if (!this.data.sandbox) this.data.sandbox = { ...DEFAULT_SETTINGS.sandbox, allowedDomains: [...DEFAULT_ALLOWED] };
    if (!this.data.token) {
      this.data.token = crypto.randomBytes(18).toString('base64url');
      this.persist();
    }
  }

  get(): Settings {
    return this.data;
  }

  update(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch };
    this.persist();
    return this.data;
  }

  public(): PublicSettings {
    const s = this.data;
    return {
      defaultModel: s.defaultModel,
      authMode: s.authMode,
      hasApiKey: !!s.apiKey,
      baseUrl: s.baseUrl,
      provider: s.provider,
      hasProviderToken: !!s.providerToken,
      lanEnabled: s.lanEnabled,
      port: s.port,
      projectsRoot: s.projectsRoot,
      defaultPermission: s.defaultPermission,
      maxHops: s.maxHops,
      logo: s.logo,
      denyRules: s.denyRules,
      sandbox: s.sandbox || { enabled: false, allowedDomains: [] },
    };
  }

  private persist() {
    writeJsonAtomic(DATA.settings, this.data, 0o600);
  }
}

/**
 * Chat messages, one append-only JSONL file per chat. Each line is a full snapshot of a
 * message; the last snapshot wins. Files are compacted when they carry many stale lines.
 */
class MessageStore {
  private cache = new Map<string, Map<string, ChatMessage>>();

  private file(chatId: string) {
    return path.join(DATA.messages, `${chatId}.jsonl`);
  }

  private load(chatId: string): Map<string, ChatMessage> {
    let map = this.cache.get(chatId);
    if (map) return map;
    map = new Map();
    let lines = 0;
    try {
      for (const line of fs.readFileSync(this.file(chatId), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        lines++;
        try {
          const rec = JSON.parse(line);
          if (rec.__deleted) map.delete(rec.__deleted);
          else map.set(rec.id, rec);
        } catch {
          /* skip a torn line */
        }
      }
    } catch {
      /* new chat */
    }
    // Turns interrupted by a restart can no longer finish; what they had written stays.
    const interrupted: ChatMessage[] = [];
    for (const m of map.values()) {
      if (m.status === 'streaming' || m.status === 'queued') {
        m.status = 'stopped';
        m.interrupted = true;
        for (const p of m.parts || []) {
          if (p.type === 'tool' && p.status === 'running') p.status = 'error';
          if (p.type === 'approval' && p.status === 'pending') p.status = 'expired';
        }
        interrupted.push(m);
      }
    }
    this.cache.set(chatId, map);
    for (const m of interrupted) this.put(m);
    if (lines > 50 && lines > map.size * 2) this.compact(chatId);
    return map;
  }

  sorted(chatId: string): ChatMessage[] {
    return [...this.load(chatId).values()].sort((a, b) => a.seq - b.seq);
  }

  list(chatId: string, opts: { beforeSeq?: number; limit?: number } = {}): ChatMessage[] {
    let all = this.sorted(chatId);
    if (opts.beforeSeq !== undefined) all = all.filter((m) => m.seq < opts.beforeSeq!);
    const limit = opts.limit ?? 80;
    return all.slice(Math.max(0, all.length - limit));
  }

  get(chatId: string, id: string): ChatMessage | undefined {
    return this.load(chatId).get(id);
  }

  /** Stores the message; writes a snapshot line unless persist is false (streaming updates). */
  put(msg: ChatMessage, persist = true) {
    this.load(msg.chatId).set(msg.id, msg);
    if (persist) fs.appendFileSync(this.file(msg.chatId), JSON.stringify(msg) + '\n');
  }

  delete(chatId: string, id: string) {
    this.load(chatId).delete(id);
    fs.appendFileSync(this.file(chatId), JSON.stringify({ __deleted: id }) + '\n');
  }

  deleteChat(chatId: string) {
    this.cache.delete(chatId);
    fs.rmSync(this.file(chatId), { force: true });
  }

  compact(chatId: string) {
    const lines = this.sorted(chatId)
      .map((m) => JSON.stringify(m))
      .join('\n');
    const tmp = this.file(chatId) + '.tmp';
    fs.writeFileSync(tmp, lines ? lines + '\n' : '');
    fs.renameSync(tmp, this.file(chatId));
  }
}

export const settings = new SettingsStore();
export const bots = new Collection<Bot>(DATA.bots);
export const chats = new Collection<Chat>(DATA.chats);
export const projects = new Collection<Project>(DATA.projects);
export const routines = new Collection<Routine>(DATA.routines);
export const messages = new MessageStore();
