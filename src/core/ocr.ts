import { hasResumeBody } from './materials';
export class InsufficientResumeError extends Error {
  constructor(characters: number) { super(`简历内容不足，已跳过（已读到简历底部，识别 ${characters} 字）；可手动重读`); }
}
export function cleanOcrText(text: string): string {
  return text.replace(/(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g, '').replace(/[ \t]+\n/g, '\n').trim();
}
// 只消除相邻片段的重叠，不对整份简历做全局去重，保留不同经历中的相同文字。
export function mergeResumeText(parts: string[]): string {
  const compact = (text: string) => [...text.matchAll(/\S/gu)];
  const overlap = (before: string, after: string) => {
    const left = compact(before).slice(-6000), right = compact(after).slice(0, 6000);
    const sequence = [...right.map(m => m[0]), '\0', ...left.map(m => m[0])];
    const prefix = new Array<number>(sequence.length).fill(0);
    for (let i = 1; i < sequence.length; i++) {
      let j = prefix[i - 1];
      while (j && sequence[i] !== sequence[j]) j = prefix[j - 1];
      if (sequence[i] === sequence[j]) j++;
      prefix[i] = j;
    }
    const length = prefix.at(-1) || 0;
    return { length, end: length ? right[length - 1].index! + right[length - 1][0].length : 0 };
  };
  return parts.reduce((result, part) => {
    const next = cleanOcrText(part); if (!next) return result; if (!result) return next;
    const before = [result], after = [next];
    // 分段边缘的一行可能只剩半个字；仅在其余重叠正文吻合时用另一段的完整行替代。
    const lastLine = result.lastIndexOf('\n'), firstLine = next.indexOf('\n');
    if (lastLine >= 0 && result.length - lastLine <= 120) before.push(result.slice(0, lastLine));
    if (firstLine >= 0 && firstLine <= 120) after.push(next.slice(firstLine + 1));
    let best = { length: 0, end: 0, left: result, right: next };
    for (const left of before) for (const right of after) {
      const match = overlap(left, right);
      if (match.length >= 24 && match.length > best.length) best = { ...match, left, right };
    }
    return best.length ? best.left + best.right.slice(best.end) : result + '\n' + next;
  }, '');
}
export function validateOcrResume(text: string, name: string, confidence: number, identityConfirmed = false, complete = false): string {
  const cleaned = cleanOcrText(text);
  if (confidence < 55) throw new Error('简历文字识别清晰度不足，请核对原图');
  if (!identityConfirmed && !cleaned.split('\n').slice(0, 8).join('').replace(/\s/g, '').includes(name.replace(/\s/g, ''))) throw new Error('尚未记录这份简历的打开来源，请关闭后重新打开一次在线简历，即可按页面姓名核对');
  if (!hasResumeBody(cleaned)) {
    if (complete) throw new InsufficientResumeError(cleaned.length);
    throw new Error(`已识别 ${cleaned.length} 字，但尚未识别到足够的教育、项目或工作正文，请核对本机识别正文；暂不评分`);
  }
  if (cleaned.length > 60000) throw new Error('简历正文超过 6 万字，暂时无法完整分析，未截断提交');
  return cleaned;
}
