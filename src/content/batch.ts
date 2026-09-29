import { CARD_SELECTOR, isDisplayed, selectors, visibleText } from './parser';
import { onlineResumeFrame } from './online-resume';
import { hasResumeBody } from '../core/materials';
import { InsufficientResumeError } from '../core/ocr';
import { normalize } from '../core/utils';
export interface BatchItem { key: string; element: Element; name: string; job: string; hasResume: boolean; skipped?: boolean }
type Driver = { items: () => BatchItem[]; current: () => BatchItem | undefined; read: () => Promise<void>; changed: () => void };
export class ResumeBatch {
  running = false; paused = false; completed = 0; skipped = 0; message = '';
  private generation = 0;
  private visited = new Set<string>();
  constructor(private driver: Driver) {}
  start() { if (this.running) return; this.running = true; this.paused = false; this.message = ''; void this.run(++this.generation); }
  pause() { this.paused = !this.paused; this.driver.changed(); }
  stop() { this.running = false; this.paused = false; this.generation++; this.message = '自动读取已停止'; this.driver.changed(); }
  clearMessage() { if (!this.running) this.message = ''; }
  private check(generation: number) {
    if (!this.running || generation !== this.generation) throw new Error('自动读取已停止');
    if (document.hidden) throw new Error('页面切到后台，自动读取已停止；回到 BOSS 后可继续');
    if ([...document.querySelectorAll('iframe, [role="dialog"]')].some(el => isDisplayed(el) && /captcha|verify|验证码|安全验证/i.test((el.getAttribute('src') || '') + (el.getAttribute('title') || '') + visibleText(el)))) throw new Error('遇到页面验证，自动读取已停止');
  }
  private async waitFor(test: () => boolean, generation: number, timeout = 15000, failure = '页面等待超时，自动读取已停止') {
    let elapsed = 0;
    while (true) {
      this.check(generation);
      if (!this.paused && test()) return;
      if (!this.paused && elapsed > timeout) throw new Error(failure);
      await new Promise(r => setTimeout(r, 300));
      if (!this.paused) elapsed += 300;
    }
  }
  private closeResume() {
    const frame = onlineResumeFrame(document); if (!frame) return;
    for (let root = frame.parentElement, depth = 0; root && depth < 6; root = root.parentElement, depth++) {
      if (root.querySelector(CARD_SELECTOR)) break;
      const close = [...root.querySelectorAll<HTMLElement>('[aria-label="关闭"], [title="关闭"], [class*="close"]')].find(el => isDisplayed(el) && !el.closest('[data-shicai]') && el.getBoundingClientRect().width < 100 && el.getBoundingClientRect().height < 100);
      if (close) { close.click(); return; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
  private identity(item: BatchItem) { return JSON.stringify([item.name, item.job]); }
  private isCurrent(item: BatchItem) {
    const current = this.driver.current();
    // current 已经过姓名、页面岗位和列表唯一性核对；列表岗位缺失时用同一记录键确认。
    return !!current && (current.key === item.key || current.element === item.element) && normalize(current.name).replace(/[.·。]+$/, '') === normalize(item.name).replace(/[.·。]+$/, '')
      && (!item.job || normalize(current.job) === normalize(item.job));
  }
  private async run(generation: number) {
    try {
      let idleLoads = 0;
      while (this.completed + this.skipped < 500) {
        await this.waitFor(() => true, generation);
        this.closeResume(); await this.waitFor(() => !onlineResumeFrame(document), generation, 5000, '上一份简历未关闭，自动读取已停止');
        const items = this.driver.items();
        const item = items.find(v => !v.hasResume && !v.skipped && !this.visited.has(this.identity(v)));
        if (!item) {
          if (++idleLoads > 3) break;
          let scroller = items.at(-1)?.element.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 30 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          if (!scroller) break;
          scroller.scrollTop = scroller.scrollHeight;
          await new Promise(r => setTimeout(r, 1600)); continue;
        }
        idleLoads = 0;
        this.message = `正在读取 ${item.name} · 已读 ${this.completed} 份 · 已跳过 ${this.skipped} 份`; this.driver.changed();
        item.element.scrollIntoView({ block: 'nearest' });
        const name = [...item.element.querySelectorAll<HTMLElement>(selectors.name)].find(isDisplayed);
        (name || item.element as HTMLElement).click();
        await this.waitFor(() => this.isCurrent(item), generation, 15000, `未能切换到 ${item.name} 的聊天或核对岗位，自动读取已停止`);
        await new Promise(r => setTimeout(r, 700)); await this.waitFor(() => true, generation);
        if (!this.isCurrent(item)) throw new Error('聊天对象发生变化，自动读取已停止');
        const link = [...document.querySelectorAll<HTMLElement>('a, button, [role="button"]')].find(el => isDisplayed(el) && visibleText(el).trim() === '在线简历');
        if (!link) throw new Error('未找到在线简历入口，自动读取已停止');
        link.click(); await this.waitFor(() => {
          const body = onlineResumeFrame(document)?.contentDocument?.body;
          const text = body ? visibleText(body) : '';
          return !!body && (!!body.querySelector('img, canvas') || hasResumeBody(text) || (text.length >= 40 && text.includes(item.name)));
        }, generation, 15000, '已点击在线简历，但简历正文未加载，自动读取已停止');
        await new Promise(r => setTimeout(r, 1200)); await this.waitFor(() => true, generation);
        if (!this.isCurrent(item)) throw new Error('聊天对象发生变化，自动读取已停止');
        try {
          await this.driver.read(); this.check(generation);
          this.completed++;
        } catch (error) {
          this.check(generation);
          if (!(error instanceof InsufficientResumeError)) throw error;
          if (!this.isCurrent(item)) throw new Error('聊天对象发生变化，自动读取已停止');
          this.skipped++; this.message = `已跳过 ${item.name}：简历内容不足，继续下一位`;
          this.closeResume(); await this.waitFor(() => !onlineResumeFrame(document), generation, 5000, '内容不足的简历未关闭，自动读取已停止');
        }
        this.visited.add(this.identity(item)); this.driver.changed();
      }
      this.message = `自动读取完成，本次已读 ${this.completed} 份简历${this.skipped ? `，跳过 ${this.skipped} 份（内容不足）` : ''}`;
    } catch (error) { this.message = error instanceof Error ? error.message : '自动读取失败，已停止'; }
    finally { if (generation === this.generation) { this.running = false; this.paused = false; this.driver.changed(); } }
  }
}
