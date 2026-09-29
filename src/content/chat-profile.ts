import type { CandidateInput, ChatProfile } from '../core/types';
import { knownChatHeaderJob } from '../core/chat-header';
import { appKey, normalize } from '../core/utils';
import { CARD_SELECTOR, DETAIL_SELECTOR, isDisplayed, parseDegree, stableIdentity, visibleText } from './parser';

const cleanName = (name: string) => normalize(name).replace(/[.·。]+$/, '');
const degreeLabel = /^(?:大专|专科|本科|硕士|博士)(?:在读|学历)?$/;

export function findChatProfileRoot(doc: Document): Element | undefined {
  for (const link of doc.querySelectorAll('a, button, [role="button"]')) {
    if (!isDisplayed(link) || visibleText(link).trim() !== '在线简历' || link.closest(DETAIL_SELECTOR)) continue;
    let root = link.parentElement;
    for (let depth = 0; root && root !== doc.body && depth < 7; depth++, root = root.parentElement) {
      if (!isDisplayed(root) || root.closest('[aria-busy="true"]')) break;
      // 只取右侧资料头部；祖先包含候选人列表时，不能把整页作为资料。
      if (root.matches(CARD_SELECTOR) || root.querySelector(CARD_SELECTOR)) break;
      const text = visibleText(root);
      if (/沟通职位\s*[：:]/.test(text) && /(?:期望|最近关注)\s*[：:]/.test(text)) return root;
    }
  }
}

export function readChatProfile(root: Element): ChatProfile | undefined {
  const raw = visibleText(root).trim();
  if (!raw || raw.length > 10000 || root.closest('[aria-busy="true"]')) return;
  const allLines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const end = allLines.findIndex(s => /^(?:期望|最近关注)\s*[：:]/.test(s));
  if (end < 0) return;
  const lines = allLines.slice(0, end + (/^(?:期望|最近关注)\s*[：:]\s*$/.test(allLines[end]) ? 2 : 1));
  const text = lines.join('\n');
  const resume = lines.indexOf('在线简历');
  const jobIndex = lines.findIndex(s => /^沟通职位\s*[：:]/.test(s));
  if (resume < 1 || jobIndex < 0) return;
  const nameEnd = lines.findIndex((s, i) => i > 0 && (/^(?:在线|刚刚活跃|今日活跃|今天活跃|\d+岁|\d+年|牛人分析器|在线简历)/.test(s) || degreeLabel.test(s)));
  const name = lines.slice(0, nameEnd > 0 ? nameEnd : 1).join('').replace(/[.·。]+$/, '').trim();
  const jobName = lines[jobIndex].replace(/^沟通职位\s*[：:]\s*/, '') || lines[jobIndex + 1] || '';
  if (!name || name.length > 60 || !jobName || /[…]|\.{3}|^(?:期望|在线简历)/.test(jobName)) return;
  // 学校、专业、学历必须来自同一条教育摘要，兼容中点拆成多个 DOM 节点。
  const rows: { node: Element; school: string; major: string; degree: ChatProfile['degree'] }[] = [];
  for (const node of root.querySelectorAll('*')) {
    const row = visibleText(node).replace(/\s+/g, ' ').trim();
    if (row.length > 180 || !text.replace(/\s+/g, ' ').includes(row)) continue;
    const parts = row.split(/\s*[·•]\s*/);
    if (parts.length !== 3 || !degreeLabel.test(parts[2])) continue;
    const school = parts[0].replace(/^\d{4}(?:[./]\d{1,2})?\s*[-–—~至]\s*\d{4}(?:[./]\d{1,2})?\s*/, '').trim();
    if (!school || school.length > 80 || /\d|[：:]/.test(school)) continue;
    rows.push({ node, school, major: parts[1], degree: parseDegree(parts[2]) });
  }
  const headerDegree = lines.slice(1, resume).find(s => degreeLabel.test(s));
  // 排除包含其他工作条目的外层列表，只保留最小教育行，避免同一条资料出现两个学校候选值。
  const degrees = [...new Map(rows.filter(row => !rows.some(other => other.node !== row.node && row.node.contains(other.node)))
    .map(({ node: _node, ...row }) => [JSON.stringify(row), row])).values()];
  const degree = headerDegree ? parseDegree(headerDegree) : degrees.length === 1 ? degrees[0].degree : '';
  const matches = degrees.filter(e => e.degree === degree);
  const education = matches.length === 1 ? matches[0] : undefined;
  return { name, jobName, degree, school: education?.school || '', major: education?.major || '', text };
}

export function matchChatProfile(root: Element, inputs: CandidateInput[]): { input: CandidateInput; profile: ChatProfile } | undefined {
  const profile = readChatProfile(root);
  if (!profile) return;
  const stable = stableIdentity(root);
  const matches = new Map(inputs.filter(c => c.stage === 'quick' && cleanName(c.name) === cleanName(profile.name)
    && normalize(c.bossJobName || knownChatHeaderJob(c.rawText, c.name, [profile.jobName])) === normalize(profile.jobName) && (!stable || c.id === stable)).map(c => [appKey(c), c]));
  if (matches.size === 1) return { input: [...matches.values()][0], profile };
}
