# ADR 009: A local model gateway with routing groups, failover, spend windows and masking

Status: accepted (milestone 9 of the Super-agent architecture)

## Context

Crew has one global model connection (Settings → Model connection): the user's Claude Code login, an Anthropic API key, or one Anthropic-compatible provider. `claudeAuth.modelEnv()` turns it into the environment of every Claude Code process Crew starts (chat turns, the Router, Workers, one-shot calls), so:

- every session talks to one endpoint with one key; when that key runs out of quota or the provider has an outage, every bot stops at once, and Claude Code retries the same endpoint until the turn fails;
- the two-layer design (ADR 002) wants a light model for the Router and the strongest one for Workers. That works within one provider's model list, not across providers or accounts;
- the only spend control is a bot's `monthlyBudgetUsd`, checked before a turn from the cost Claude Code reports. A burst of parallel Workers can spend a week's money in an afternoon, and nothing can say "this role may use $5 per 5 hours";
- nobody records which provider actually answered a call, how many tokens it took, or how long it took: Claude Code's cost figures assume Claude prices;
- the provider key sits in every agent's environment, so any command an agent runs can read it;
- prompts leave the machine as they are, secrets the user pasted included.

yetone/magpie solves the same problem for coding agents with a local gateway: one list of `provider/model`, routing groups that fail over when a quota runs out (the agent never sees the error; a refused try counts as "handed on", not a failure), spend/token windows per key answered with 429 + Retry-After before any provider is asked, a per-call usage log attributed to whoever answered, and optional local masking of secrets. This milestone builds that inside the Crew server.

## Decision

Add a **model gateway** (`server/gateway/`): a small HTTP server inside the Crew process that speaks the Anthropic Messages API only (`POST /v1/messages`, `POST /v1/messages/count_tokens`). It does no protocol translation: every provider must already have an Anthropic-compatible endpoint, as today's provider connection requires.

It is behind `settings.gateway.enabled`, off by default. Off, `modelEnv()` and `botModel()` return exactly what they return today, nothing listens, and no file is created. On, every Claude Code session Crew starts gets the gateway as its endpoint:

```
ANTHROPIC_BASE_URL   = http://127.0.0.1:<port>/s/<role>/<botId>
ANTHROPIC_AUTH_TOKEN = <scope token>   (HMAC of the scope with a per-process secret)
ANTHROPIC_API_KEY    = ''              (so Claude Code sends the Bearer token)
ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL, CLAUDE_CODE_SUBAGENT_MODEL = <the role's target>
ANTHROPIC_DEFAULT_HAIKU_MODEL = <fastTarget, else the role's target>
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 1
```

and its `model` option is the role's target, so Claude Code sends the address in the request body.

- **Binds 127.0.0.1 only**, whatever `lanEnabled` says, on `gateway.port` (0 = a free port picked at start; sessions are recreated on restart anyway).
- **The scope is in the URL path, the credential is per scope.** `/s/router/<leadId>`, `/s/worker/<botId>`, `/s/bot/<botId>`, `/s/oneshot/_`, and later `/s/watchdog/_` and `/s/speculative/<botId>`. The token is `HMAC(secret, "role/botId")`; the gateway refuses a request whose token does not match its path. An agent can read its own token from its environment (commands inherit it), but it cannot make one for another scope, so it cannot spend under another role's window. Provider keys never enter an agent's environment any more.
- **Keys stay in `~/.crew/settings.json`** (`gatewayTokens`, by provider id, like `providerToken`), never in `PublicSettings`, never in the usage log, and are sent only to their own provider.

### Addresses, providers and groups

A **provider** is one endpoint with one key: `{ id, name, baseUrl, auth: 'bearer' | 'x-api-key', models, price? }`. Several accounts at one provider are several providers (`deepseek`, `deepseek-2`). A model is addressed as **`provider/model`** (split at the first `/`, so `openrouter/openai/gpt-5` is provider `openrouter`, model `openai/gpt-5`). A trailing `[1m]` is dropped before the request leaves, as Claude Code does. The model `*` means "the model the client asked for", for a passthrough member such as `anthropic/*`.

A **routing group** is a name (no `/`) and an ordered list of members, each a `provider/model`. A **target** is a group name or a `provider/model`.

### Which target a request goes to

Resolved twice with the same pure function (`gateway/config.ts` `routeFor`): when the session is created (to set its model and env), and per request (in case Claude Code sends something else, e.g. a Claude model name for a background call):

1. the gateway's **role override** for the scope's role (`gateway.roles.router | worker | watchdog | speculative | oneshot`), when set;
2. else the model the session or request asked for, when it is an address (a group, or a known `provider/model`). This is how **each bot** picks: its own model field and the chat's model switch, whose pickers list the gateway's groups and models while the gateway is on. The Router's and Workers' own model settings (`superAgent.router.model` / `workerModel`) work the same way;
3. else `gateway.defaultTarget`;
4. else the request is refused (400, "no route").

So the paper's split is two settings: Router → a light group, Workers → the strongest group.

### Failover

For each member in order (`gateway/proxy.ts`):

- forward the request (body re-serialized with that member's model; client headers kept except auth, host, length and encoding; the provider's own auth header added);
- **hand on** to the next member when the provider refuses before answering: no connection, HTTP 429, any 5xx (529 included), a 400/402/403 whose error text says quota, balance, credit or billing, or a stream whose first event is an `error` event of type `overloaded_error`, `rate_limit_error` or `api_error`. The status and headers are only sent to Claude Code once a member's response passed these checks, so failover is transparent, **streaming included**: the first SSE event is held back until it is known not to be an error;
- any other answer (2xx, or an error that is the request's fault, e.g. 400 invalid request, 401) is final and goes back as it came;
- if every member handed on, the last refusal goes back (status, body, `retry-after`), so Claude Code's own retry logic sees what the last provider said.

A try is recorded as `answered`, `handed-on`, `failed` (final error) or `skipped` (an unknown provider, a `*` member without a model to pass through). Once a stream is under way it is not retried: an error after the first event goes to Claude Code as it is.

### Spend windows

`gateway.windows`: `{ id, role: GatewayRole | '*', botId?, hours, maxUsd, maxTokens }` (0 = no limit on that measure). A window covers the calls of its role (and bot, when set) in the last `hours` hours, rolling. Before any provider is asked, every window covering the request's scope is checked against the usage log; a spent window answers **429** with `Retry-After` (seconds until enough of its oldest calls leave the window), `x-should-retry: false` (so the Anthropic SDK inside Claude Code fails the turn with the message rather than sleeping for hours), and a `rate_limit_error` naming the window. The call is logged as `limited`. Typical windows are 5 hours and 168 hours (a week). They sit on top of each bot's `monthlyBudgetUsd`, which is unchanged.

### Usage log

One record per call (`gateway/calls.jsonl` under `CREW_HOME`, created on the first call; at most 20,000 records / 35 days, through the existing `JsonlLog`):

```ts
interface GatewayCall {
  id: string; at: number;
  role: GatewayRole; botId?: string;
  requested: string;            // the model Claude Code asked for
  target: string;               // the group or address it resolved to
  provider?: string; model?: string;   // who actually answered
  outcome: 'ok' | 'error' | 'limited';
  status: number;
  tries: GatewayTry[];          // { member, outcome: 'answered'|'handed-on'|'failed'|'skipped', status?, detail?, ms }
  tokens?: TurnTokens;          // from the answer's usage (message_start + message_delta when streaming)
  costUsd: number;              // estimated: tokens × the provider's price, else a built-in Claude price table, else 0
  latencyMs: number;            // to the end of the answer
  stream: boolean;
  masked?: number;              // how many values were masked
  window?: string;              // the window that refused it
}
```

Prices are per million tokens; cache reads count 0.1× input, cache writes 1.25× input. `GET /api/gateway` returns the running state, the recent calls and per-provider and per-scope totals; the Settings page shows them.

### Privacy masking

`gateway.masking`, off by default. When on, before a request leaves (`gateway/mask.ts`, pure):

- in `system`, text blocks, `tool_result` contents and `tool_use` inputs (not tool definitions, images, documents, or thinking blocks, whose signatures must stay valid), it replaces **emails**, **keys** (common token shapes: `sk-…`, `sk-ant-…`, GitHub `ghp_`/`github_pat_`…, AWS `AKIA…`, Slack `xox…`, Google `AIza…`, JWTs, PEM private keys, `Bearer …`) and **passwords** (the value after `password=`, `secret:`, `api_key=`, `token:` and similar) with placeholders `CREW_MASKED_<KIND>_<8 hex>`;
- the placeholder is an HMAC of the value with a key derived from the settings token, so the same secret gets the same placeholder in every call and Claude Code's resent history stays byte-identical (prompt caching keeps working);
- the reply is restored: in a JSON answer's text and `tool_use` input strings; in a stream, per content block, through a restorer that holds back a tail that could be the start of a placeholder and flushes it at the block's end (`text_delta` restored as text, `input_json_delta` restored JSON-escaped). Thinking is not restored, so its signature stays valid when it is sent back.

So a tool call the model makes with a placeholder runs with the real value, and the user sees the real value, but the provider never does.

## Data model

Shared types (`shared/types.ts`):

```ts
type GatewayRole = 'bot' | 'worker' | 'router' | 'watchdog' | 'speculative' | 'oneshot';

interface GatewayProvider { id: string; name: string; baseUrl: string; auth: 'bearer' | 'x-api-key'; models: string[]; price?: { input: number; output: number } }
interface GatewayGroup { id: string; members: string[] }
interface SpendWindow { id: string; role: GatewayRole | '*'; botId?: string; hours: number; maxUsd: number; maxTokens: number }

interface GatewaySettings {     // settings.gateway
  enabled: boolean;             // default false
  port: number;                 // 0 = any free port
  providers: GatewayProvider[];
  groups: GatewayGroup[];
  defaultTarget: string;        // where a request with no address goes
  fastTarget: string;           // Claude Code's haiku tier (background calls); '' = the role's target
  roles: Partial<Record<Exclude<GatewayRole, 'bot'>, string>>;
  windows: SpendWindow[];
  masking: boolean;             // default false
}
```

`Settings` gains `gateway` and `gatewayTokens: Record<providerId, string>`; `PublicSettings.gateway` is `GatewaySettings` with `hasToken` per provider. Both get defaults when missing, so no migration is needed. `AuthStatus.method` may be `'gateway'`.

## How it fits the existing modules

- `server/gateway/` (new): `config.ts` (pure: defaults, normalization, addresses, `routeFor`, `membersOf`), `windows.ts` (pure: which windows cover a scope, whether one is spent, Retry-After), `pricing.ts` (pure: cost estimate), `mask.ts` (pure: mask, restore, streaming restorer), `sse.ts` (pure: an incremental SSE parser), `upstream.ts` (one HTTP(S) request to a provider, honouring `HTTPS_PROXY`/`NO_PROXY` with a CONNECT tunnel, since Node's own HTTP does not), `proxy.ts` (the request handler: auth, windows, failover, streaming, masking, usage; it takes its settings and log as arguments, so tests drive it against fake upstreams), `index.ts` (the listener's lifecycle, the usage log, `gatewayEnv(scope)`, the test call, the summary).
- `claudeAuth.ts`: `modelEnv(s, scope)` and `botModel(model, scope)` return the gateway's env and target when it is on; `checkAuth` reports `method: 'gateway'`, ready when a default target or role route resolves to a provider with a key.
- `orchestrator/turnContext.ts`: `agentEnv(scope)`; the call sites pass their scope: chat turns `bot`, `layers/workers.ts` `worker`, `layers/router.ts` `router`, `oneShot.ts` `oneshot`. Later milestones (Watchdog, speculative Workers) pass theirs.
- `store.ts`: the two settings keys; `DATA.gatewayCalls`.
- `api.ts`/`schemas.ts`: `PATCH /api/settings` accepts `gateway` and `gatewayTokens`; turning the gateway on starts it before the sessions are refreshed, any gateway change refreshes every session (`invalidateAllSessions`, `invalidateRouters`); `GET /api/gateway`, `POST /api/gateway/test` (a tiny prompt through the real listener, reporting who answered and the tries), `POST /api/gateway/import-connection` (adds today's provider connection or API key as a gateway provider, key included, without sending it to the UI).
- `index.ts`: starts the gateway before anything that can start a session; stops it on shutdown.
- UI: Settings → Model gateway (switch; providers with key, auth header, models and prices; groups; routes: default, fast, per role; spend windows; masking; the usage log with tries, totals and a test button). The bot editor's model picker, the chat's model switch and the Router's model pickers list the gateway's groups and `provider/model` addresses while it is on.

## Deliberately left out

- **Protocol translation** (OpenAI, Gemini wire formats). Members must speak the Anthropic Messages API, as provider connections already must.
- **The Claude Code login as a member.** Crew cannot use the user's Claude subscription on its own; an Anthropic API key can be a provider (`https://api.anthropic.com`, `x-api-key`).
- **Retrying a stream that broke mid-way**: once the first event went out, the answer belongs to that member; Claude Code retries the call itself.
- **Health tracking / circuit breaking** (skip a member that failed a minute ago): each call starts from the first member. A quota answer is fast, so the cost is one quick refused request per call.
- **Token counting through every member**: `count_tokens` goes through the same failover but is not logged or windowed.
- **Masking by the user's own patterns** and masking inside images or documents.
- **Exact cost**: costs are estimates from public or user-entered prices; the bots' monthly budget still uses Claude Code's figure.
- **Watchdog and speculative roles' callers**: their milestones are built elsewhere; the scopes, routes and windows for them exist and take effect when those sessions pass their scope.

## Risks

- **A gateway bug stops every bot.** It is off by default, the handler is small and tested against fake upstreams, and turning it off restores the old path at the next turn.
- **Failover across models changes behaviour mid-task** and loses the prompt cache (caches are per model), and a thinking block signed by one provider may be refused by another. Groups are the user's choice; a group of accounts of one model avoids both.
- **A quota error the patterns do not recognise** is passed back as final instead of handed on. The patterns are conservative on purpose: handing on a real request error would send the same bad request to every member.
- **Masking false positives/negatives.** Patterns miss secrets of unusual shapes and may mask a harmless value that looks like a key; the model then sees a placeholder, and the value is restored in its reply. It is off by default and documented as best effort; it is not a security boundary (the sandbox is).
- **A local process can reach 127.0.0.1.** It cannot use the gateway without a scope token; an agent can use its own token, which only lets it do what its session already can.
- **Long Retry-After values.** `x-should-retry: false` makes the turn fail with the window's message instead of sleeping; the Router or the user sees why.
