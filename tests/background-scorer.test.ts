import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreInBackground } from '../src/background/scorer';
import { scoreCandidate } from '../src/core/scorer';
import { defaultSettings, newJob, type Candidate, type Task } from '../src/core/types';
vi.mock('../src/core/scorer', () => ({ scoreCandidate: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('长请求期间的后台存活', () => {
  it.each(['完成', '失败', '取消'])('%s 后清除所有存活计时器', async end => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => ({})); vi.stubGlobal('chrome', { runtime: { getPlatformInfo: pulse } });
    let finish!: () => void;
    vi.mocked(scoreCandidate).mockImplementation(() => new Promise((resolve, reject) => { finish = () => end === '完成' ? resolve({ score: {} } as never) : reject(new Error('请求已结束')); }));
    const controller = new AbortController();
    const work = scoreInBackground({ job: newJob() } as Task, {} as Candidate, defaultSettings, controller.signal).catch(() => {});
    await vi.advanceTimersByTimeAsync(90000); expect(pulse).toHaveBeenCalledTimes(4);
    if (end === '取消') { controller.abort(); await vi.advanceTimersByTimeAsync(60000); expect(pulse).toHaveBeenCalledTimes(4); }
    finish(); await work; await vi.advanceTimersByTimeAsync(60000);
    expect(pulse).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });
});
