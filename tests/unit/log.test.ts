import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function capture(level?: string) {
  if (level) vi.stubEnv('CREW_LOG_LEVEL', level);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
  const { logger } = await import('../../server/log');
  return { log: logger('test'), out, err };
}

describe('logger', () => {
  it('writes timestamped, tagged lines; warnings and errors to stderr', async () => {
    const { log, out, err } = await capture();
    log.info('started', { port: 1 });
    log.warn('careful');
    log.debug('hidden by default');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+Z INFO {2}\[test\] started {"port":1}\n$/);
    expect(err[0]).toContain('WARN  [test] careful');
  });

  it('prints the stack of an error', async () => {
    const { log, err } = await capture();
    log.error('boom', new Error('bad'));
    expect(err[0]).toMatch(/boom Error: bad\n\s+at /);
  });

  it('follows CREW_LOG_LEVEL', async () => {
    const { log, out, err } = await capture('error');
    log.info('no');
    log.warn('no');
    log.error('yes');
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
  });
});
