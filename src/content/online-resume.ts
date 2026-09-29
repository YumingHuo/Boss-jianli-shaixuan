import type { CandidateInput } from '../core/types';
import { hasResumeBody } from '../core/materials';
import { CARD_SELECTOR, isDisplayed, parseCandidate, visibleText } from './parser';

export type ResumeRead = { status: 'text' | 'image' | 'unavailable' | 'unmatched'; input?: CandidateInput };
export function onlineResumeFrame(doc: Document): HTMLIFrameElement | undefined {
  return [...doc.querySelectorAll<HTMLIFrameElement>('iframe')].find(frame => {
    if (!isDisplayed(frame)) return false;
    try { const u = new URL(frame.src, doc.location.href); return u.origin === 'https://www.zhipin.com' && u.pathname === '/web/frame/c-resume/'; } catch { return false; }
  });
}
export type ResumePart = { text: string } | { image: string };
type Viewport = { top: number; bottom: number };
export type ResumeCapture = { segments: ResumePart[][]; verify: () => void };
function isResumePicture(el: Element) {
  const rect = el.getBoundingClientRect();
  return rect.width >= 120 && rect.height >= 8;
}
export function captureResumeParts(doc: Document, viewport?: Viewport): ResumePart[] {
  const body = onlineResumeFrame(doc)?.contentDocument?.body;
  if (!body) throw new Error('在线简历尚未加载');
  const parts: ResumePart[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text && viewport) {
        const range = node.ownerDocument!.createRange(); range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        if (!rects.some(r => r.bottom > viewport.top && r.top < viewport.bottom)) return;
      }
      if (text) parts.push({ text }); return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (!isDisplayed(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName) || el.hasAttribute('data-shicai')) return;
    if (el.tagName === 'IMG' || el.tagName === 'CANVAS') {
      // 根据页面显示尺寸排除头像和图标，保留较矮的教育行及章节图片。
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || (viewport && (Math.max(rect.bottom, rect.top + 1) <= viewport.top || rect.top >= viewport.bottom))) return;
      const source = el as HTMLImageElement | HTMLCanvasElement;
      const width = el.tagName === 'IMG' ? (source as HTMLImageElement).naturalWidth : (source as HTMLCanvasElement).width;
      const height = el.tagName === 'IMG' ? (source as HTMLImageElement).naturalHeight : (source as HTMLCanvasElement).height;
      if (!width || !height || (el.tagName === 'IMG' && !(source as HTMLImageElement).complete)) throw new Error('简历图片尚未加载完整');
      if (!isResumePicture(el)) return;
      if (width > 6000 || width * height > 100000000) throw new Error('简历图片过大，暂时无法完整识别');
      // 按文档顺序读取全部片段；长图分块，避免整张缩小后文字变糊。
      const start = viewport ? Math.max(0, Math.floor((viewport.top - rect.top) / rect.height * height)) : 0;
      const end = viewport ? Math.min(height, Math.ceil((viewport.bottom - rect.top) / rect.height * height)) : height;
      for (let y = start; y < end; y += 2800) {
        const canvas = doc.createElement('canvas'); canvas.width = width; canvas.height = Math.min(3000, end - y);
        canvas.getContext('2d')!.drawImage(source, 0, y, width, canvas.height, 0, 0, width, canvas.height);
        try { parts.push({ image: canvas.toDataURL('image/png') }); } catch { throw new Error('页面不允许读取这张图片，已停止；请使用正常的原始简历下载入口'); }
        if (y + canvas.height >= end) break;
      }
      return;
    }
    el.childNodes.forEach(walk);
  };
  walk(body);
  if (!parts.length && (!viewport || (!body.textContent?.trim() && !body.querySelector('canvas, img')))) throw new Error('简历正文尚未加载完整');
  return parts;
}

// 只选择简历正文的滚动容器，外层查找在沟通列表之前停止。
function resumeScroller(frame: HTMLIFrameElement): HTMLElement | undefined {
  const inner = frame.contentDocument!;
  const roots = [inner.scrollingElement, ...inner.body.querySelectorAll<HTMLElement>('*')].filter((el): el is HTMLElement => !!el);
  for (let el = frame.parentElement, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
    if (el.querySelector(CARD_SELECTOR)) break;
    roots.push(el);
  }
  return roots.filter(el => {
    if (!isDisplayed(el) || el.clientHeight < 50 || el.scrollHeight <= el.clientHeight + 2) return false;
    const style = el.ownerDocument.defaultView!.getComputedStyle(el);
    return (el === inner.scrollingElement || /auto|scroll/.test(style.overflowY))
      && (el.contains(frame) || el.querySelector('img, canvas') || visibleText(el).length >= 100);
  }).sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
}
function resumeViewport(frame: HTMLIFrameElement, scroller?: HTMLElement): Viewport {
  const outer = frame.getBoundingClientRect();
  const windowHeight = frame.ownerDocument.defaultView!.innerHeight;
  const scale = frame.offsetHeight ? outer.height / frame.offsetHeight : 1;
  const origin = outer.top + frame.clientTop * scale;
  let top = Math.max(0, -origin / scale), bottom = Math.min(frame.clientHeight, (windowHeight - origin) / scale);
  for (let parent = frame.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
    if (parent.querySelector(CARD_SELECTOR)) break;
    if (!/auto|scroll|hidden|clip/.test(parent.ownerDocument.defaultView!.getComputedStyle(parent).overflowY)) continue;
    const rect = parent.getBoundingClientRect();
    top = Math.max(top, (rect.top + parent.clientTop - origin) / scale);
    bottom = Math.min(bottom, (rect.top + parent.clientTop + parent.clientHeight - origin) / scale);
  }
  if (scroller && scroller !== frame.contentDocument!.scrollingElement) {
    const rect = scroller.getBoundingClientRect();
    const outside = scroller.ownerDocument === frame.ownerDocument;
    const offset = outside ? origin : 0;
    const ratio = outside ? scale : 1;
    top = Math.max(top, (rect.top + scroller.clientTop - offset) / ratio);
    bottom = Math.min(bottom, (rect.top + scroller.clientTop + scroller.clientHeight - offset) / ratio);
  }
  if (bottom - top < 50) throw new Error('简历窗口可见区域过小，请将简历窗口移回页面内再读取');
  return { top, bottom };
}
export async function prepareResumeParts(doc: Document, check: () => void, progress: (message: string) => void = () => {}): Promise<ResumeCapture> {
  const frame = onlineResumeFrame(doc);
  const inner = frame?.contentDocument;
  const verify = () => { check(); if (!frame || onlineResumeFrame(doc) !== frame || frame.contentDocument !== inner) throw new Error('简历发生变化，已停止读取'); };
  verify();
  const body = frame!.contentDocument?.body;
  if (!body) throw new Error('在线简历尚未加载');
  const expanded = new WeakSet<Element>();
  const expand = () => {
    for (const button of body.querySelectorAll<HTMLElement>('a, button, [role="button"]')) {
      if (!expanded.has(button) && isDisplayed(button) && /^(?:查看全部|展开全部)$/.test(visibleText(button).trim())) { verify(); expanded.add(button); button.click(); }
    }
  };
  const settle = async (scroller?: HTMLElement) => {
    let previous = '', stable = 0;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 400)); verify(); expand();
      try {
        const parts = captureResumeParts(doc, resumeViewport(frame!, scroller));
        const signature = JSON.stringify([scroller?.scrollTop, scroller?.scrollHeight, parts]);
        if (signature === previous) stable++; else stable = 0;
        if (stable >= 2) return parts;
        previous = signature;
      } catch (error) { if (!(error instanceof Error) || !error.message.includes('尚未加载')) throw error; previous = ''; stable = 0; }
    }
    throw new Error('当前简历片段的图片尚未加载完整，已停止读取；请等待加载完成后重读');
  };
  expand();
  let scroller = resumeScroller(frame!);
  const move = (top: number) => {
    if (!scroller) return;
    const previous = scroller.style.getPropertyValue('scroll-behavior'), priority = scroller.style.getPropertyPriority('scroll-behavior');
    scroller.style.setProperty('scroll-behavior', 'auto', 'important');
    scroller.scrollTop = top;
    if (previous) scroller.style.setProperty('scroll-behavior', previous, priority); else scroller.style.removeProperty('scroll-behavior');
  };
  move(0);
  const segments: ResumePart[][] = [];
  let capturedBytes = 0;
  for (let step = 0; step < 100; step++) {
    verify(); progress(`正在加载简历第 ${step + 1} 段，自动核对底部…`);
    const parts = await settle(scroller);
    // 首屏加载后才出现滚动条时，仍从顶部开始覆盖。
    const loadedScroller = resumeScroller(frame!);
    if (loadedScroller && loadedScroller !== scroller) {
      if (segments.length) throw new Error('简历滚动区域发生变化，已停止读取，请重新读取');
      scroller = loadedScroller; move(0); continue;
    }
    segments.push(parts);
    capturedBytes += parts.reduce((sum, p) => sum + ('image' in p ? p.image.length : p.text.length), 0);
    if (capturedBytes > 160000000) throw new Error('简历图片超过本次本机读取容量，尚未完整读取，暂不分析');
    const viewport = resumeViewport(frame!, scroller);
    const atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) {
      // 内容被固定容器裁切、却没有可用滚动条时，不能把当前窗口当作完整简历。
      if (!scroller && [...body.querySelectorAll('img, canvas')].some(el => isDisplayed(el) && isResumePicture(el) && (el.getBoundingClientRect().bottom > viewport.bottom + 2 || el.getBoundingClientRect().top < viewport.top - 2))) throw new Error('简历正文仍有部分被窗口遮挡，未找到可滚动的正文区域，暂不分析');
      if (!scroller) {
        const texts = inner!.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let node = texts.nextNode(); node; node = texts.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = inner!.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some(r => r.bottom > viewport.bottom + 2 || r.top < viewport.top - 2)) throw new Error('简历文字仍被窗口裁切，未找到可滚动的正文区域，暂不分析');
        }
      }
      const finalPosition = scroller?.scrollTop, finalHeight = scroller?.scrollHeight;
      const finalParts = JSON.stringify(parts);
      progress(`已到简历底部，共读取 ${segments.length} 段，准备识别正文…`);
      return { segments, verify: () => {
        verify();
        if (scroller?.scrollTop !== finalPosition || scroller?.scrollHeight !== finalHeight
          || JSON.stringify(captureResumeParts(doc, resumeViewport(frame!, scroller))) !== finalParts) throw new Error('识别期间简历内容或滚动位置发生变化，结果未写入；请重新读取');
      } };
    }
    const before = scroller!.scrollTop;
    // 保留约三成重叠，避免行文字或章节在两段之间被截断。
    move(Math.min(scroller!.scrollHeight - scroller!.clientHeight, before + Math.max(30, Math.floor((viewport.bottom - viewport.top) * 0.7))));
    if (scroller!.scrollTop <= before + 1) throw new Error('简历尚未到达底部，但页面未能继续滚动，已停止读取');
  }
  throw new Error('简历超过本次读取长度，尚未核对到底部，暂不分析');
}
export async function readOnlineResume(doc: Document, context?: CandidateInput): Promise<ResumeRead | undefined> {
  for (const frame of doc.querySelectorAll<HTMLIFrameElement>('iframe')) {
    if (!isDisplayed(frame)) continue;
    let url: URL;
    try { url = new URL(frame.src, doc.location.href); } catch { continue; }
    if (url.origin !== 'https://www.zhipin.com' || url.pathname !== '/web/frame/c-resume/') continue;
    try {
      // 只读取用户当前展开的同源简历文档，不请求页面接口或隐藏数据。
      const body = frame.contentDocument?.body;
      if (!body) return { status: 'unavailable' };
      // 有正文图片时，页面标题不代表经历已经读全，交给混合正文读取流程。
      if ([...body.querySelectorAll('canvas, img')].some(el => isDisplayed(el) && isResumePicture(el))) return { status: 'image' };
      const text = visibleText(body);
      if (!hasResumeBody(text)) return { status: body.querySelector('canvas, img') ? 'image' : 'unavailable' };
      if (!context) return { status: 'unmatched' };
      const firstLines = text.split('\n').slice(0, 12).map(s => s.trim().replace(/[.·。]+$/, ''));
      if (!firstLines.includes(context.name)) return { status: 'unmatched' };
      const parsed = await parseCandidate(body, 'deep', context);
      if (parsed && parsed.id !== context.id) return { status: 'unmatched' };
      return { status: 'text', input: { ...context, ...parsed, id: context.id, identity: context.identity, bossJobId: context.bossJobId, bossJobName: context.bossJobName, name: context.name, rawText: text.slice(0, 60000), stage: 'deep' } };
    } catch { return { status: 'unavailable' }; }
  }
}
