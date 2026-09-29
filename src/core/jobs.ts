import type { CandidateInput, Job, Settings } from './types';
import { normalize } from './utils';
import { knownChatHeaderJob } from './chat-header';
export function candidateJobName(c: Pick<CandidateInput, 'bossJobName' | 'rawText' | 'name' | 'observedJobName'>, jobs: Job[]): string {
  return c.bossJobName || c.observedJobName || knownChatHeaderJob(c.rawText, c.name, jobs.flatMap(j => [j.name, ...j.aliases]));
}
export function resolveJob(c: CandidateInput, jobs: Job[], settings: Pick<Settings, 'mode' | 'manualJobId'>): { job?: Job; reason: string } {
  const active = jobs.filter(j => j.enabled);
  if (settings.mode === 'manual') {
    const job = active.find(j => j.id === settings.manualJobId);
    return { job, reason: job ? '手动指定岗位' : '请选择有效的手动岗位' };
  }
  const ids = c.bossJobId ? active.filter(j => j.bossIds.includes(c.bossJobId)) : [];
  if (ids.length) return ids.length === 1 ? { job: ids[0], reason: '岗位 ID 绑定' } : { reason: '岗位 ID 绑定冲突，请修正' };
  const detectedName = candidateJobName(c, jobs);
  const name = normalize(detectedName);
  const matches = name ? active.filter(j => [j.name, ...j.aliases].some(a => normalize(a) === name)) : [];
  if (matches.length === 1) return { job: matches[0], reason: c.bossJobName ? '岗位名称或别名匹配' : '沟通列表标题匹配' };
  return { reason: matches.length > 1 ? '岗位别名冲突，请修正' : name ? `未配置该岗位：${detectedName}` : '未识别出应聘岗位，请核对页面' };
}
