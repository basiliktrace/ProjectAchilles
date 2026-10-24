import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendSlackAlert, sendSlackText } from '../slack.service.js';

afterEach(() => vi.unstubAllGlobals());

describe('sendSlackText', () => {
  it('POSTs { text }', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', f);
    await sendSlackText('https://hooks.example/x', 'hello');
    expect(f).toHaveBeenCalledWith('https://hooks.example/x', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    }));
  });
  it('bounds the request with a timeout signal', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', f);
    await sendSlackText('https://hooks.example/x', 'hello');
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('sendSlackAlert also passes a timeout signal', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', f);
    await sendSlackAlert('https://hooks.example/x', {
      breaches: [],
      triggerTest: 't',
      triggerAgent: 'h',
      dashboardUrl: 'http://u',
    });
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('throws with status and body on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' }));
    await expect(sendSlackText('https://h', 't')).rejects.toThrow('Slack webhook failed with status 400: bad');
  });
});
