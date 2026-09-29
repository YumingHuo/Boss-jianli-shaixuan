// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureResumeParts, prepareResumeParts, readOnlineResume } from '../src/content/online-resume';
let frame: HTMLIFrameElement;
let draws: unknown[][];
beforeEach(() => {
  document.body.innerHTML = '<iframe></iframe>'; frame = document.querySelector('iframe')!;
  Object.defineProperty(frame, 'src', { value: 'https://www.zhipin.com/web/frame/c-resume/' });
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 10000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 10000 });
  frame.getBoundingClientRect = () => rect(0, 1000, frame.clientHeight);
  Object.defineProperty((frame.contentWindow as unknown as { Range: typeof Range }).Range.prototype, 'getClientRects', { configurable: true, value: function(this: Range) { return [this.startContainer.parentElement?.getBoundingClientRect().height ? this.startContainer.parentElement.getBoundingClientRect() : rect(0, 600, 20)]; } });
  draws = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...args: unknown[]) => draws.push(args) }) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { const last = draws.at(-1)!; return `data:image/png;base64,${(last[0] as Element).id}:${last[2]}:${last[4]}`; });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function picture(id: string, width: number, height: number, displayWidth = width) {
  const canvas = frame.contentDocument!.createElement('canvas'); canvas.id = id; canvas.width = width; canvas.height = height;
  canvas.getBoundingClientRect = () => rect(0, displayWidth, height * displayWidth / width);
  frame.contentDocument!.body.append(canvas); return canvas;
}
function rect(top: number, width: number, height: number): DOMRect { return { top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() {} }; }
function scrolling(height: () => number, changed: (top: number) => void = () => {}) {
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
  const container = frame.contentDocument!.createElement('div'); container.style.overflowY = 'auto';
  Object.defineProperty(container, 'clientHeight', { value: 200 });
  Object.defineProperty(container, 'scrollHeight', { get: height });
  let top = 0;
  Object.defineProperty(container, 'scrollTop', { get: () => top, set: value => { top = Math.max(0, Math.min(value, height() - 200)); changed(top); } });
  container.getBoundingClientRect = () => rect(0, 600, 200);
  frame.contentDocument!.body.append(container); return container;
}
describe('完整读取同一份在线简历的图片与文字', () => {
  it('按页面顺序保留简介、工作经历和较短的教育图，不再只选最大图片', () => {
    const body = frame.contentDocument!.body;
    picture('头像', 800, 800, 60);
    picture('简介', 1000, 900);
    body.insertAdjacentHTML('beforeend', '<h2>工作经历</h2>'); picture('工作', 1000, 1800);
    body.insertAdjacentHTML('beforeend', '<h2>教育经历</h2>'); picture('教育', 1000, 120);
    const parts = captureResumeParts(document);
    expect(draws.map(d => (d[0] as Element).id)).toEqual(['简介', '工作', '教育']);
    expect(parts.map(p => 'text' in p ? p.text : '图片')).toEqual(['图片', '工作经历', '图片', '教育经历', '图片']);
  });
  it('排除隐藏容器中的旧简历，长图分段时覆盖到最底部', () => {
    const hidden = picture('旧简历', 1200, 900); hidden.outerHTML = '<div style="display:none">' + hidden.outerHTML + '</div>';
    picture('长图', 1000, 6500);
    captureResumeParts(document);
    expect(draws.map(d => [(d[0] as Element).id, d[2], d[4]])).toEqual([['长图', 0, 3000], ['长图', 2800, 3000], ['长图', 5600, 900]]);
  });
  it('教育图片还在加载时拒绝只返回已完成的简介', () => {
    picture('简介', 1000, 900);
    const img = frame.contentDocument!.createElement('img'); img.getBoundingClientRect = () => ({ width: 600, height: 120 }) as DOMRect;
    frame.contentDocument!.body.append(img);
    expect(() => captureResumeParts(document)).toThrow('尚未加载完整');
  });
  it('页面上有章节标题和简介，但经历在图片里时不提前当作完整文本评分', async () => {
    frame.contentDocument!.body.innerHTML = '<h2>工作经历</h2><p>' + '能够完成岗位相关工作。'.repeat(10) + '</p><h2>教育经历</h2>';
    picture('经历', 1000, 600);
    expect(await readOnlineResume(document)).toEqual({ status: 'image' });
  });
  it('展开正常查看全部按钮，等待图片稳定；候选人改变时立即停止', async () => {
    vi.useFakeTimers();
    picture('简介', 1000, 900);
    const button = frame.contentDocument!.createElement('button'); button.textContent = '查看全部';
    button.onclick = () => { picture('完整工作经历', 1000, 500); button.textContent = '收起'; };
    frame.contentDocument!.body.append(button);
    const check = vi.fn(); const work = prepareResumeParts(document, check);
    await vi.advanceTimersByTimeAsync(1200); expect((await work).segments.flat().filter(p => 'image' in p)).toHaveLength(2); expect(button.textContent).toBe('收起');
    const interrupted = prepareResumeParts(document, () => { throw new Error('候选人变化'); });
    await expect(interrupted).rejects.toThrow('候选人变化');
  });
  it('小窗口内滚动加载到真正底部，包括滚动后才增加的教育图片', async () => {
    vi.useFakeTimers();
    let height = 900, added = false;
    const scroller = scrolling(() => height, top => {
      if (top >= 500 && !added) {
        added = true; height = 1300;
        const education = picture('教育底部', 600, 300); scroller.append(education);
        education.getBoundingClientRect = () => rect(1000 - scroller.scrollTop, 600, 300);
      }
    });
    const content = picture('长简历', 600, 1000); scroller.append(content);
    content.getBoundingClientRect = () => rect(-scroller.scrollTop, 600, 1000);
    const progress = vi.fn(); const work = prepareResumeParts(document, () => {}, progress);
    await vi.advanceTimersByTimeAsync(25000); const result = await work;
    expect(scroller.scrollTop).toBe(1100); expect(result.segments.length).toBeGreaterThan(5);
    expect(result.segments.at(-1)!.some(p => 'image' in p && p.image.includes('教育底部'))).toBe(true);
    expect(progress.mock.calls.at(-1)![0]).toContain('已到简历底部'); expect(() => result.verify()).not.toThrow();
  });
  it('同一画布滚动时被替换，先前片段仍保留；再次变化时拒绝写入', async () => {
    vi.useFakeTimers();
    const scroller = scrolling(() => 800, top => { if (canvas) canvas.id = `正文位置${top}`; });
    const canvas = picture('正文位置0', 600, 200); scroller.append(canvas);
    const work = prepareResumeParts(document, () => {}); await vi.advanceTimersByTimeAsync(15000);
    const result = await work;
    expect(result.segments[0][0]).toMatchObject({ image: expect.stringContaining('正文位置0') });
    expect(result.segments.at(-1)![0]).toMatchObject({ image: expect.stringContaining('正文位置600') });
    canvas.id = '内容已替换'; expect(() => result.verify()).toThrow('发生变化');
  });
  it('滚动中切换候选人或关闭简历，立即停止且不返回半份正文', async () => {
    vi.useFakeTimers(); const scroller = scrolling(() => 800);
    const canvas = picture('正文', 600, 800); scroller.append(canvas); canvas.getBoundingClientRect = () => rect(-scroller.scrollTop, 600, 800);
    const work = prepareResumeParts(document, () => { if (scroller.scrollTop) throw new Error('候选人变化'); });
    const failed = expect(work).rejects.toThrow('候选人变化'); await vi.advanceTimersByTimeAsync(2000); await failed;
    const closed = prepareResumeParts(document, () => {}); frame.remove();
    const stopped = expect(closed).rejects.toThrow('简历发生变化'); await vi.advanceTimersByTimeAsync(1000); await stopped;
  });
  it('底部图片加载失败时明确停止，不因为前面已有章节就返回成功', async () => {
    vi.useFakeTimers(); const scroller = scrolling(() => 800);
    const canvas = picture('工作经历', 600, 600); scroller.append(canvas); canvas.getBoundingClientRect = () => rect(-scroller.scrollTop, 600, 600);
    const unloaded = frame.contentDocument!.createElement('img'); scroller.append(unloaded); unloaded.getBoundingClientRect = () => rect(600 - scroller.scrollTop, 600, 200);
    const work = prepareResumeParts(document, () => {}); const failed = expect(work).rejects.toThrow('当前简历片段的图片尚未加载完整');
    await vi.advanceTimersByTimeAsync(30000); await failed;
  });
  it('纯文字简历也必须滚动到底，不能在首屏章节出现后提前返回', async () => {
    vi.useFakeTimers(); const scroller = scrolling(() => 600);
    scroller.innerHTML = '<p>教育经历：' + '主修计算机科学，完成课程项目。'.repeat(12) + '</p>';
    const work = prepareResumeParts(document, () => {}); await vi.advanceTimersByTimeAsync(10000);
    const result = await work; expect(scroller.scrollTop).toBe(400); expect(result.segments).toHaveLength(4); expect(result.segments[0][0]).toHaveProperty('text');
  });
  it('滚动条位于简历外层弹窗时，按弹窗窗口采集到最后一段', async () => {
    vi.useFakeTimers();
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 350 });
    const modal = document.createElement('div'); modal.style.overflowY = 'auto'; frame.replaceWith(modal); modal.append(frame);
    Object.defineProperty(modal, 'clientHeight', { value: 200 }); Object.defineProperty(modal, 'scrollHeight', { value: 1000 });
    modal.getBoundingClientRect = () => rect(100, 600, 200);
    frame.getBoundingClientRect = () => rect(100 - modal.scrollTop, 600, 1000);
    picture('正文', 600, 1000);
    const work = prepareResumeParts(document, () => {}); await vi.advanceTimersByTimeAsync(15000);
    const result = await work; expect(modal.scrollTop).toBe(800); expect(result.segments.at(-1)![0]).toMatchObject({ image: expect.stringContaining(':800:200') });
  });
  it('正文中间存在空白区域时继续滚动，不把空白当成加载失败或底部', async () => {
    vi.useFakeTimers(); const scroller = scrolling(() => 1000);
    const first = picture('顶部正文', 600, 200), last = picture('底部正文', 600, 200); scroller.append(first, last);
    first.getBoundingClientRect = () => rect(-scroller.scrollTop, 600, 200);
    last.getBoundingClientRect = () => rect(800 - scroller.scrollTop, 600, 200);
    const work = prepareResumeParts(document, () => {}); await vi.advanceTimersByTimeAsync(15000);
    const result = await work; expect(result.segments.some(p => !p.length)).toBe(true); expect(scroller.scrollTop).toBe(800);
    expect(result.segments.at(-1)![0]).toMatchObject({ image: expect.stringContaining('底部正文') });
  });
  it('没有可滚动区域却仍有图片被裁切时，不宣称读取完整', async () => {
    vi.useFakeTimers(); Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 200 });
    picture('被裁切正文', 600, 1000);
    const work = prepareResumeParts(document, () => {}); const failed = expect(work).rejects.toThrow('未找到可滚动');
    await vi.advanceTimersByTimeAsync(2000); await failed;
  });
  it('纯文字正文被固定窗口截断且无法滚动时，也不宣称完整', async () => {
    vi.useFakeTimers(); Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 200 });
    const paragraph = frame.contentDocument!.createElement('p'); paragraph.textContent = '教育经历与项目正文。'.repeat(30);
    paragraph.getBoundingClientRect = () => rect(0, 600, 1000); frame.contentDocument!.body.append(paragraph);
    const work = prepareResumeParts(document, () => {}); const failed = expect(work).rejects.toThrow('简历文字仍被窗口裁切');
    await vi.advanceTimersByTimeAsync(2000); await failed;
  });
});
