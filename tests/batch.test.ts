// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumeBatch, type BatchItem } from '../src/content/batch';
import { InsufficientResumeError } from '../src/core/ocr';
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.body.innerHTML = '<div id="list"></div><a id="open">在线简历</a><section id="modal"></section>'; });
afterEach(() => vi.useRealTimers());
function setup(options: { missingJob?: boolean; imageStopsClick?: boolean; textResume?: boolean; sparseText?: boolean; staleKey?: boolean; wrongJob?: boolean } = {}) {
  let current: BatchItem | undefined;
  const items = ['甲同学', '乙同学'].map(name => { const element = document.createElement('article'); element.className = 'geek-card'; element.textContent = name; element.scrollIntoView = () => {}; document.querySelector('#list')!.append(element); const item = { element, name, key: name, job: options.missingJob ? '' : '实习生', hasResume: false }; element.onclick = () => { current = { ...item, name: name + '.', job: options.wrongJob ? '别的岗位' : '实习生', key: options.staleKey ? name + ':已读' : name }; }; if(options.imageStopsClick) { const img = document.createElement('img'); img.onclick = e => e.stopPropagation(); element.prepend(img); } return item; });
  (document.querySelector('#open') as HTMLElement).onclick = () => {
    const modal = document.querySelector('#modal')!; modal.innerHTML = '<button class="close">关闭</button><iframe></iframe>';
    const frame = modal.querySelector('iframe')!; frame.contentDocument!.body.innerHTML = options.textResume ? '<h2>工作经历</h2><p>' + '完成项目设计、开发和测试。'.repeat(8) + '</p><h2>教育经历</h2><p>测试大学，计算机，本科。</p>' : '<canvas></canvas>';
    if (options.sparseText) frame.contentDocument!.body.textContent = current!.name + '\n自学能力强，团队协作优秀\n期望职位 深圳 Python 行业不限\n教育经历 测试大学 通信工程 本科 2023—2027';
    Object.defineProperty(frame, 'src', { value: 'https://www.zhipin.com/web/frame/c-resume/' });
    (modal.querySelector('button') as HTMLElement).onclick = () => { modal.innerHTML = ''; };
  };
  const read = vi.fn(async () => { items.find(i => i.element === current?.element)!.hasResume = true; });
  const batch = new ResumeBatch({ items: () => items, current: () => current, read, changed: () => {} }); return { batch, read, items };
}
describe('逐份打开简历的可停止流程', () => {
  it('聊天事件绑定在条目内部时，通过姓名点击进入，不点击独立头像入口', async () => {
    const { batch, read, items } = setup();
    for (const item of items) {
      const element = item.element as HTMLElement, select = element.onclick!; element.onclick = null;
      element.innerHTML = '<div class="chat-info"><span class="geek-name">' + item.name + '</span></div>';
      element.querySelector<HTMLElement>('.chat-info')!.onclick = event => select.call(element, event);
    }
    batch.start(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(2);
  });
  it.each([{ missingJob: true }, { imageStopsClick: true }, { textResume: true }, { staleKey: true }])('兼容列表岗位缺失、头像拦截、纯文本简历与已读指纹变化：%j', async options => {
    const { batch, read } = setup(options); batch.start(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(2); expect(batch.completed).toBe(2);
  });
  it('岗位冲突时停止，并说明是聊天核对失败；手动重读可清除旧提示', async () => {
    const { batch, read } = setup({ wrongJob: true }); batch.start(); await vi.runAllTimersAsync();
    expect(read).not.toHaveBeenCalled(); expect(batch.message).toContain('聊天或核对岗位'); expect(document.querySelector('iframe')).toBeNull();
    batch.clearMessage(); expect(batch.message).toBe('');
  });
  it('依次打开两人并读取，读完一人后再打开下一人', async () => { const { batch, read } = setup(); batch.start(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(2); expect(batch.completed).toBe(2); expect(batch.running).toBe(false); });
  it('停止后不再自动点击在线简历或读取下一人', async () => { const { batch, read } = setup(); batch.start(); await vi.advanceTimersByTimeAsync(400); batch.stop(); await vi.runAllTimersAsync(); expect(read).not.toHaveBeenCalled(); expect(batch.running).toBe(false); });
  it('暂停超过页面超时仍可继续，不在暂停期间打开简历', async () => { const { batch, read } = setup(); batch.start(); await vi.advanceTimersByTimeAsync(400); batch.pause(); await vi.advanceTimersByTimeAsync(20000); expect(read).not.toHaveBeenCalled(); expect(document.querySelector('iframe')).toBeNull(); batch.pause(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(2); });
  it('已读到底但内容不足时，关闭简历并继续下一位，跳过者不算已读成功', async () => {
    const { batch, read, items } = setup(); read.mockRejectedValueOnce(new InsufficientResumeError(133));
    batch.start(); await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(2); expect(batch.completed).toBe(1); expect(batch.skipped).toBe(1);
    expect(items[0].hasResume).toBe(false); expect(items[1].hasResume).toBe(true); expect(document.querySelector('iframe')).toBeNull();
    expect(batch.message).toContain('跳过 1 份');
    batch.start(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(2);
  });
  it('新一轮读取略过已保存为内容不足的候选人', async () => {
    const { batch, read, items } = setup(); Object.assign(items[0], { skipped: true });
    batch.start(); await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(1); expect(items[0].hasResume).toBe(false); expect(items[1].hasResume).toBe(true);
  });
  it('纯文字的简短简历也进入完整读取判断，然后按内容不足跳过', async () => {
    const { batch, read } = setup({ sparseText: true }); read.mockRejectedValue(new InsufficientResumeError(133));
    batch.start(); await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(2); expect(batch.skipped).toBe(2); expect(batch.completed).toBe(0); expect(document.querySelector('iframe')).toBeNull();
  });
  it.each(['简历图片尚未加载完整', '简历文字识别清晰度不足', '候选人发生变化'])('其他读取问题继续明确停止，不把“%s”误当内容不足', async message => {
    const { batch, read } = setup(); read.mockRejectedValueOnce(new Error(message));
    batch.start(); await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(1); expect(batch.skipped).toBe(0); expect(batch.completed).toBe(0); expect(batch.message).toBe(message);
  });
});
