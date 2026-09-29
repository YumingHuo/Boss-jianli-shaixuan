import type { CandidateInput, Degree, Stage } from '../core/types';
import { hash, normalize, safeAvatarUrl } from '../core/utils';
import { avatarIdentity } from '../core/identity';
import { chatHeaderAfterName, chatHeaderJob } from '../core/chat-header';
// 选择器集中管理。无可验证身份/材料时停止解析，不读取隐藏接口或框架内部数据。
export const CARD_SELECTOR = '[data-candidate-id], [data-geek-id], .geek-card, .candidate-card, .geek-item';
export const DETAIL_SELECTOR = '.resume-detail, .geek-resume, .resume-dialog, [data-resume-detail]';
const fingerprints = new WeakMap<Element, { id: string; scope: string; text: string; avatar: string }>();
export const selectors = {
  name: '[data-field="name"], .geek-name, .candidate-name, .name',
  job: '[data-field="job"], .job-name, .position-name, .expect-job',
  school: '[data-field="school"], .school-name, .school',
  degree: '[data-field="degree"], .degree, .education-degree',
  experience: '[data-field="experience"], .work-years',
  currentTitle: '[data-field="current-title"], .current-position',
  expectedTitle: '[data-field="expected-title"], .expect-position',
  skills: '[data-field="skill"], .skill-tag'
};
export function isDisplayed(node: Element): boolean {
  const style = getComputedStyle(node);
  return !node.closest('[hidden], [aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}
export function visibleText(root: Element): string {
  const pieces: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { const t = node.textContent?.trim(); if (t) pieces.push(t); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName) || element.hasAttribute('data-shicai') || !isDisplayed(element)) return;
    element.childNodes.forEach(walk);
  };
  walk(root); return pieces.join('\n').replace(/\n{3,}/g, '\n\n');
}
function field(root: Element, selector: string) {
  return Array.from(root.querySelectorAll(selector)).filter(isDisplayed).map(visibleText).find(Boolean) || '';
}
export function parseDegree(value: string): Degree | '' {
  if (/博士/.test(value)) return '博士'; if (/硕士|研究生/.test(value)) return /硕士/.test(value) ? '硕士' : '';
  if (/本科|学士/.test(value)) return '本科'; if (/大专|专科/.test(value)) return '专科';
  if (/高中|中专|初中/.test(value)) return '高中及以下'; return '';
}
export function stableIdentity(root: Element): string {
  const own = root.getAttribute('data-candidate-id') || root.getAttribute('data-geek-id');
  if (own) return own;
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!isDisplayed(a)) continue;
    try {
      const u = new URL(a.href); if (u.origin !== 'https://www.zhipin.com') continue;
      const id = u.searchParams.get('geekId') || u.searchParams.get('encryptGeekId') || u.pathname.match(/\/geek\/(?:new\/)?([^/]+)\.html/)?.[1];
      if (id) return id;
    } catch { /* 非 URL 的页面链接不作为身份依据。 */ }
  }
  return '';
}
export async function parseCandidate(root: Element, stage: Stage = 'quick', clicked?: CandidateInput): Promise<CandidateInput | null> {
  if (!isDisplayed(root)) return null;
  const rawText = visibleText(root).slice(0, stage === 'quick' ? 18000 : 60000);
  if (rawText.length < 12) return null;
  const stable = stableIdentity(root);
  const name = field(root, selectors.name).slice(0, 60) || '匿名候选人';
  const jobNode = root.querySelector('[data-job-id]');
  const bossJobId = root.getAttribute('data-job-id') || jobNode?.getAttribute('data-job-id') || '';
  const bossJobName = field(root, selectors.job).replace(/^(?:应聘|沟通|招聘|期望)岗位[：:\s]*/, '').trim();
  const school = field(root, selectors.school).replace(/^学校[：:\s]*/, '').trim();
  const degree = parseDegree(field(root, selectors.degree));
  // 详情无显式 ID 时，只沿用用户刚刚点击的同一姓名卡片；冲突时拒绝关联。
  const context = stage === 'deep' && clicked && (!stable || stable === clicked.id) && (name === clicked.name || (stable && name === '匿名候选人')) && (!bossJobId || bossJobId === clicked.bossJobId) && (!bossJobName || bossJobName === clicked.bossJobName) ? clicked : undefined;
  if (stage === 'deep' && !stable && !context) return null;
  const avatarUrl = [...root.querySelectorAll<HTMLImageElement>('img')].filter(img => isDisplayed(img) && !img.closest('[data-shicai]'))
    .map(img => safeAvatarUrl(img.currentSrc || img.src)).find(Boolean) || context?.avatarUrl;
  const jobScope = bossJobId || normalize(bossJobName || chatHeaderJob(rawText, name));
  const avatar = avatarIdentity(avatarUrl);
  const identityText = normalize(chatHeaderAfterName(rawText, name) || rawText);
  const scope = JSON.stringify([normalize(name), jobScope, school, degree]);
  const previous = fingerprints.get(root);
  // 同一条目头像晚到时补图片，保留这次页面会话中已经使用的键；节点复用发生冲突则重新识别。
  const retained = previous?.scope === scope && ((avatar && previous.avatar === avatar) || (!previous.avatar && previous.text === identityText)) ? previous.id : '';
  const id = stable || context?.id || retained || 'fp2:' + await hash(JSON.stringify(avatar && jobScope ? [normalize(name), jobScope, avatar] : [normalize(name), jobScope, school, degree, identityText]));
  if (!stable && !context) fingerprints.set(root, { id, scope, text: identityText, avatar });
  if (!stable && !context && name === '匿名候选人') return null;
  const rect = root.getBoundingClientRect();
  return { id, identity: stable || context?.identity === 'stable' ? 'stable' : 'fingerprint', name: name === '匿名候选人' && context ? context.name : name,
    avatarUrl,
    bossJobId: bossJobId || context?.bossJobId || '', bossJobName: bossJobName || context?.bossJobName || '',
    school: school || context?.school || '', degree: degree || context?.degree || '', experience: field(root, selectors.experience), currentTitle: field(root, selectors.currentTitle), expectedTitle: field(root, selectors.expectedTitle), skills: Array.from(root.querySelectorAll(selectors.skills)).filter(isDisplayed).map(visibleText), rawText, stage, sourceUrl: location.origin + location.pathname, priority: rect.bottom >= 0 && rect.top <= innerHeight ? 2 : 0 };
}
