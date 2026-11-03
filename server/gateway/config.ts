// The model gateway's settings (settings.gateway, ADR 009): defaults, cleaning up what is stored,
// and the pure routing rules: what an address is, which target a scope's request goes to, and the
// members a target expands to.

import type { GatewayGroup, GatewayProvider, GatewayRole, GatewaySettings, SpendWindow } from '../../shared/types';
import { bounded } from '../normalize';

export const GATEWAY_ROLES: GatewayRole[] = ['bot', 'worker', 'router', 'watchdog', 'speculative', 'oneshot'];
/** Roles whose route the gateway can override; bots pick through their own model field. */
export const ROUTED_ROLES = ['router', 'worker', 'watchdog', 'speculative', 'oneshot'] as const;

export const DEFAULT_GATEWAY: GatewaySettings = {
  enabled: false,
  port: 0,
  providers: [],
  groups: [],
  defaultTarget: '',
  fastTarget: '',
  roles: {},
  windows: [],
  masking: false,
};

export const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Who a call is for, as carried in the gateway URL (/s/<role>/<botId>). */
export interface Scope {
  role: GatewayRole;
  botId?: string;
}

export const scopeKey = (s: Scope) => (s.botId ? `${s.role}:${s.botId}` : s.role);

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown, min: number, max: number, fallback: number) => bounded(v, min, max, fallback, { step: 0 });
const list = (v: unknown, max: number) =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map((x) => str(x))
            .filter(Boolean)
            .slice(0, max),
        ),
      ]
    : [];

function provider(raw: unknown): GatewayProvider | null {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<GatewayProvider>;
  const id = str(p.id, 40);
  const baseUrl = str(p.baseUrl, 500).replace(/\/+$/, '');
  if (!PROVIDER_ID.test(id) || !/^https?:\/\//i.test(baseUrl)) return null;
  const out: GatewayProvider = { id, name: str(p.name, 100) || id, baseUrl, auth: p.auth === 'x-api-key' ? 'x-api-key' : 'bearer', models: list(p.models, 50) };
  if (p.price && typeof p.price === 'object') {
    const input = num(p.price.input, 0, 10_000, 0);
    const output = num(p.price.output, 0, 10_000, 0);
    if (input || output) out.price = { input, output };
  }
  return out;
}

function group(raw: unknown): GatewayGroup | null {
  const g = (raw && typeof raw === 'object' ? raw : {}) as Partial<GatewayGroup>;
  const id = str(g.id, 40);
  if (!GROUP_ID.test(id)) return null;
  return { id, members: list(g.members, 20).filter((m) => m.includes('/')) };
}

function window(raw: unknown, i: number): SpendWindow | null {
  const w = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpendWindow>;
  const role = w.role === '*' || GATEWAY_ROLES.includes(w.role as GatewayRole) ? (w.role as SpendWindow['role']) : null;
  if (!role) return null;
  const out: SpendWindow = {
    id: str(w.id, 60) || `w${i + 1}`,
    role,
    hours: num(w.hours, 0.1, 24 * 62, 5),
    maxUsd: num(w.maxUsd, 0, 1_000_000, 0),
    maxTokens: Math.round(num(w.maxTokens, 0, 1e12, 0)),
  };
  const bot = str(w.botId, 60);
  if (bot) out.botId = bot;
  return out;
}

const uniqueBy = <T extends { id: string }>(items: (T | null)[]) => {
  const seen = new Set<string>();
  return items.filter((x): x is T => !!x && !seen.has(x.id) && !!seen.add(x.id));
};

/** Fills in what a stored (or older, or partial) value lacks, and drops what does not parse. */
export function normalizeGateway(raw: unknown): GatewaySettings {
  const g = (raw && typeof raw === 'object' ? raw : {}) as Partial<GatewaySettings>;
  const roles: GatewaySettings['roles'] = {};
  for (const r of ROUTED_ROLES) {
    const v = str((g.roles as Record<string, unknown> | undefined)?.[r]);
    if (v) roles[r] = v;
  }
  return {
    enabled: g.enabled === true,
    port: Math.round(num(g.port, 0, 65535, 0)),
    providers: uniqueBy((Array.isArray(g.providers) ? g.providers : []).slice(0, 50).map(provider)),
    groups: uniqueBy((Array.isArray(g.groups) ? g.groups : []).slice(0, 50).map(group)),
    defaultTarget: str(g.defaultTarget),
    fastTarget: str(g.fastTarget),
    roles,
    windows: uniqueBy((Array.isArray(g.windows) ? g.windows : []).slice(0, 50).map(window)),
    masking: g.masking === true,
  };
}

/** "[1m]" only tells Claude Code about a 1M context window; it is not part of the model name. */
export const bareModel = (m: string) => m.replace(/\[1m\]$/i, '');

/** provider/model split at the first '/', so a model may contain '/' itself (OpenRouter). */
export function splitAddress(address: string): { provider: string; model: string } | null {
  const i = address.indexOf('/');
  if (i <= 0 || i === address.length - 1) return null;
  return { provider: address.slice(0, i), model: bareModel(address.slice(i + 1)) };
}

/** A group name or a provider/model of a configured provider. */
export function isAddress(gw: GatewaySettings, target: string | undefined): target is string {
  if (!target) return false;
  const t = bareModel(target);
  if (gw.groups.some((g) => g.id === t)) return true;
  const a = splitAddress(t);
  return !!a && gw.providers.some((p) => p.id === a.provider);
}

/** The scope's override, if the gateway has one for its role. */
export function roleRoute(gw: GatewaySettings, scope: Scope): string | undefined {
  if (scope.role === 'bot') return undefined;
  return gw.roles[scope.role] || undefined;
}

/**
 * Which target a scope's request goes to: the role's override, else what was asked for when it is
 * an address, else the default. undefined: no route.
 */
export function routeFor(gw: GatewaySettings, scope: Scope, requested: string | undefined): string | undefined {
  const override = roleRoute(gw, scope);
  if (isAddress(gw, override)) return bareModel(override);
  if (isAddress(gw, requested)) return bareModel(requested);
  if (isAddress(gw, gw.defaultTarget)) return bareModel(gw.defaultTarget);
  return undefined;
}

/**
 * The members a target expands to, in order: a group's members, or the address itself. A member
 * whose model is '*' takes the model the client asked for, when that is not an address itself.
 */
export function membersOf(gw: GatewaySettings, target: string, requested?: string): string[] {
  const g = gw.groups.find((x) => x.id === target);
  const raw = g ? g.members : [target];
  const passthrough = requested && !isAddress(gw, requested) ? bareModel(requested) : '';
  return raw.map((m) => {
    const a = splitAddress(m);
    return a?.model === '*' ? (passthrough ? `${a.provider}/${passthrough}` : m) : m;
  });
}
