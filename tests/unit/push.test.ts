import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = { barkUrl: 'https://api.day.app/KEY123', afterMinutes: 10 };
vi.mock('../../server/store', () => ({ settings: { get: () => ({ push }) } }));

const { approvalPushText, barkUrlOk, remindLater } = await import('../../server/push');

describe('barkUrlOk', () => {
  it('takes the Bark app URL or a self-hosted one with the same shape', () => {
    expect(barkUrlOk('https://api.day.app/KEY123')).toBe(true);
    expect(barkUrlOk('https://api.day.app/KEY123/')).toBe(true);
    expect(barkUrlOk('https://bark.example.com/abc')).toBe(true);
  });
  it('refuses http, credentials, extra path parts and junk', () => {
    for (const u of ['http://api.day.app/KEY', 'https://u:p@api.day.app/KEY', 'https://api.day.app/KEY/title/body', 'https://api.day.app/', 'api.day.app/KEY', '']) {
      expect(barkUrlOk(u), u).toBe(false);
    }
  });
});

describe('the approval push', () => {
  it('names who waits, where, and the action, nothing more', () => {
    const t = approvalPushText('Forge', 'apellespell 小队', '运行命令：清理测试数据', 10);
    expect(t.title).toBe('Forge 在等你确认');
    expect(t.body).toBe('「apellespell 小队」里已经等了 10 分钟：运行命令：清理测试数据');
  });
});

describe('remindLater', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pushes once the delay passes with the request still open', async () => {
    remindLater('Forge', 'apellespell 小队', '运行命令');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.day.app/KEY123');
    expect(JSON.parse(String(init.body))).toMatchObject({ title: 'Forge 在等你确认', group: 'Crew' });
  });

  it('does not push once the request is answered', async () => {
    const cancel = remindLater('Forge', 'g', '运行命令');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    cancel();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing without a Bark address', async () => {
    push.barkUrl = '';
    remindLater('Forge', 'g', '运行命令');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    push.barkUrl = 'https://api.day.app/KEY123';
  });
});
