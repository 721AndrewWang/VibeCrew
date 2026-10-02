// Diagnostic logging for the server: one timestamped line per event, tagged with where it came from.
// The desktop app captures stdout/stderr into ~/.crew/logs/server.log. CREW_LOG_LEVEL picks how much
// is written (debug, info, warn, error or silent; info by default).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof LEVELS, 'silent'>;

const threshold = LEVELS[(process.env.CREW_LOG_LEVEL as keyof typeof LEVELS) || 'info'] ?? LEVELS.info;

function format(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, scope: string, args: unknown[]) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${args.map(format).join(' ')}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** A logger whose lines are tagged with `scope`, e.g. `logger('workspace').warn('reset failed', e)`. */
export function logger(scope: string): Logger {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}
