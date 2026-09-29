import type { Candidate, CandidateInput, Job, State } from './types';
import { chatHeaderAfterName } from './chat-header';
import { candidateJobName, resolveJob } from './jobs';
import { normalize, safeAvatarUrl } from './utils';

export function avatarIdentity(value?: string): string {
  const safe = safeAvatarUrl(value); if (!safe) return '';
  const url = new URL(safe);
  // 仅比较页面已展示的个人上传图片地址，不识别人脸；公共默认头像不作为身份依据。
  if (!/\/(?:upload|avatar)\//i.test(url.pathname) || /(?:default|anonymous|placeholder|male|female|boy|girl|icon)/i.test(url.pathname)) return '';
  return url.origin + url.pathname.replace(/@.*$/, '');
}
export function chatMessage(c: Pick<CandidateInput, 'rawText' | 'name' | 'bossJobName' | 'observedJobName'>, jobs: Job[]): string {
  const tail = chatHeaderAfterName(c.rawText, c.name), job = normalize(candidateJobName(c, jobs));
  const text = tail ? normalize(tail) : '';
  return job && text.startsWith(job) ? text.slice(job.length) : '';
}
export function candidateForKey(state: State, key: string): Candidate | undefined {
  const visited = new Set<string>();
  let c = state.candidates[key] || state.candidates[state.candidateAliases?.[key] || ''];
  while (c?.duplicateOf) { if (visited.has(c.key)) return; visited.add(c.key); c = state.candidates[c.duplicateOf]; }
  return c;
}
export const activeCandidates = (state: State) => Object.values(state.candidates).filter(c => !c.duplicateOf);
export function candidateViewState(state: State): State {
  const duplicates = Object.values(state.candidates).filter(c => c.duplicateOf);
  return { ...state, duplicateCount: duplicates.length, candidateAliases: Object.fromEntries(duplicates.map(c => [c.key, candidateForKey(state, c.key)!.key])), candidates: Object.fromEntries(activeCandidates(state).map(c => [c.key, c])), tasks: Object.fromEntries(Object.entries(state.tasks).map(([key, t]) => [key, { ...t, candidateKey: candidateForKey(state, t.candidateKey)?.key || t.candidateKey }])) };
}
export function deduplicateCandidates(state: State): number {
  const candidates = activeCandidates(state), groups = new Map<string, Candidate[]>();
  const messages = new Map(candidates.map(c => [c.key, chatMessage({ ...c, rawText: c.quickText || c.rawText }, state.jobs)]));
  const avatars = new Map(candidates.map(c => [c.key, avatarIdentity(c.avatarUrl)]));
  const person = (c: Candidate) => normalize(c.name).replace(/[.·。]+$/, '');
  for (const c of candidates) {
    const job = resolveJob(c, state.jobs, { mode: 'auto', manualJobId: '' }).job?.id || normalize(candidateJobName(c, state.jobs)) || c.bossJobId;
    if (!job || !person(c) || c.name === '匿名候选人') continue;
    const group = JSON.stringify([person(c), job]); groups.set(group, [...(groups.get(group) || []), c]);
  }
  let merged = 0;
  for (const group of groups.values()) {
    const conflicts = (a: Candidate, b: Candidate) => (a.identity === 'stable' && b.identity === 'stable' && a.id !== b.id)
      || (!!a.bossJobId && !!b.bossJobId && a.bossJobId !== b.bossJobId)
      || (!!avatars.get(a.key) && !!avatars.get(b.key) && avatars.get(a.key) !== avatars.get(b.key))
      || (!!a.school && !!b.school && normalize(a.school) !== normalize(b.school))
      || (!!a.degree && !!b.degree && a.degree !== b.degree)
      || (!['未收藏', '已收藏'].includes(a.status) && !['未收藏', '已收藏'].includes(b.status) && a.status !== b.status);
    const matches = (a: Candidate, b: Candidate) => {
      if (conflicts(a, b)) return false;
      if (a.identity === 'stable' && b.identity === 'stable') return a.id === b.id;
      const avatar = avatars.get(a.key);
      if (avatar && avatar === avatars.get(b.key) && !candidates.some(c => person(c) !== person(a) && avatars.get(c.key) === avatar)) {
        const sameAvatar = group.filter(c => avatars.get(c.key) === avatar);
        return !sameAvatar.some(c => sameAvatar.some(other => conflicts(c, other)));
      }
      if (a.deepHash && a.deepHash === b.deepHash && a.deepText.length >= 100) {
        const sameResume = group.filter(c => c.deepHash === a.deepHash);
        return !sameResume.some(c => sameResume.some(other => conflicts(c, other)));
      }
      const message = messages.get(a.key) || '';
      // 旧版缺头像时，只使用足够长且完全一致的自述；通用招呼或存在身份冲突时不合并。
      if (message.length < 50 || message !== messages.get(b.key) || candidates.some(c => person(c) !== person(a) && messages.get(c.key) === message)) return false;
      const sameMessage = group.filter(c => messages.get(c.key) === message);
      return !sameMessage.some(c => sameMessage.some(other => conflicts(c, other)));
    };
    // 优先保留已有完整简历的记录键，避免更新时换键导致相同材料再次入队。
    const ordered = group.sort((a, b) => Number(!!b.deepText) - Number(!!a.deepText) || b.analyses.length - a.analyses.length || a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    for (let i = 0; i < ordered.length; i++) {
      const target = ordered[i]; if (target.duplicateOf) continue;
      for (const source of ordered.slice(i + 1)) {
        if (source.duplicateOf || !matches(target, source)) continue;
        // 原记录留在本地作为合并依据，不删除简历与任务历史。
        source.duplicateOf = target.key; merged++;
        if (source.identity === 'stable') { target.id = source.id; target.identity = 'stable'; }
        target.avatarUrl ||= source.avatarUrl; avatars.set(target.key, avatarIdentity(target.avatarUrl));
        target.school ||= source.school; target.degree ||= source.degree; target.chatProfile ||= source.chatProfile;
        target.experience ||= source.experience; target.skills = [...new Set([...target.skills, ...source.skills])];
        if (source.deepText && source.deepHash !== target.deepHash && source.updatedAt >= target.updatedAt) {
          target.deepText = source.deepText; target.deepHash = source.deepHash; target.rawText = source.deepText; target.stage = 'deep';
          target.resumeSource = source.resumeSource; target.ocrConfidence = source.ocrConfidence;
        }
        if (target.deepText) delete target.resumeReadStatus;
        else if (source.resumeReadStatus === 'insufficient') target.resumeReadStatus = 'insufficient';
        target.analyses = [...new Map([...source.analyses, ...target.analyses].map(a => [a.key, a])).values()];
        if (source.savedAt) { if (!target.savedAt || target.status === '未收藏' || target.status === '已收藏') target.status = source.status; target.savedAt = Math.min(target.savedAt || source.savedAt, source.savedAt); }
        target.createdAt = Math.min(target.createdAt, source.createdAt); target.updatedAt = Math.max(target.updatedAt, source.updatedAt);
      }
    }
  }
  if (merged) state.paused = true;
  return merged;
}
