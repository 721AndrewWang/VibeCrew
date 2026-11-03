// Where secrets are taken out of what Crew writes (ADR 104). A registry with no imports, so the
// logger and the stores can call it without import cycles; hardening/secrets.ts installs the real
// redactors when the server starts. Until then they return text unchanged.

type Redact = (text: string) => string;

let all: Redact = (t) => t;
let ui: Redact = (t) => t;

/** Installs the redactors: `everywhere` for logs and files, `forUi` for what the UI receives. */
export function setRedactors(everywhere: Redact, forUi: Redact) {
  all = everywhere;
  ui = forUi;
}

/** Text without any secret Crew holds: for logs, the audit log, Triggers and stored messages. */
export function redact(text: string): string {
  return all(text);
}

/** Text for the UI: the same, except what the UI must show (the phone-access link's token). */
export function redactForUi(text: string): string {
  return ui(text);
}

/** Every string inside a value, redacted; the value's shape is kept. */
export function redactDeep<T>(value: T, fn: Redact = redact): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, fn)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, fn);
    return out as T;
  }
  return value;
}
