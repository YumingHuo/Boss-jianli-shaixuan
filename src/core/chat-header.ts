import { normalize } from './utils';

// 沟通列表原文保留了“未读数 / 时间 / 姓名 / 沟通岗位 / 消息”的展示顺序。
// 只读取姓名紧邻的标题，不在整段自我介绍中搜索岗位。
export function chatHeaderAfterName(rawText: string, name: string): string | undefined {
  if (!name || name === '匿名候选人') return;
  const text = rawText.normalize('NFKC');
  const normalizedName = name.normalize('NFKC');
  const index = text.indexOf(normalizedName);
  if (index < 0 || index > 80) return;
  const prefix = text.slice(0, index).replace(/\s+/g, '');
  if (!/^(?:\d+)?(?:今天|昨天|前天|刚刚|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}:\d{2}|(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)$/.test(prefix)) return;
  return text.slice(index + normalizedName.length).trimStart();
}

export function chatHeaderJob(rawText: string, name: string): string {
  const tail = chatHeaderAfterName(rawText, name);
  if (!tail || !tail.includes('\n')) return '';
  const title = tail.split('\n')[0].trim();
  if (!title || title.length > 100 || /[。！？!?]|^(?:您好|你好|面试官|我|可以|请问|希望|对你的简历|\[)/.test(title)) return '';
  return title;
}

export function knownChatHeaderJob(rawText: string, name: string, names: string[]): string {
  const tail = chatHeaderAfterName(rawText, name);
  if (!tail) return '';
  const line = chatHeaderJob(rawText, name);
  if (line) return line;
  // 某些页面将标题和消息压成一行。仅允许已配置的完整标题位于头部并有空白边界。
  const matches = names.filter(Boolean).flatMap(title => {
    const escaped = title.normalize('NFKC').trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    const match = new RegExp(`^${escaped}(?=\\s|$)`, 'i').exec(tail);
    return match ? [{ title, length: match[0].length }] : [];
  }).sort((a,b) => normalize(b.title).length - normalize(a.title).length);
  const best = matches[0];
  if (!best) return '';
  // 短岗位名之后紧接方向括号、实习生等后缀时，不能截断为另一岗位。
  const suffix = tail.slice(best.length).trimStart();
  if (/^(?:[（(]|实习生|助理|工程师|负责人|经理|方向)/.test(suffix)) return '';
  return best.title;
}
