import type { Candidate, CandidateInput, ChatProfile, Job, Settings, Stage, State, Task } from './types';
import type { Persistence } from './storage';
import { appKey, hash, hasCompleteEndpoint, normalize, safeAvatarUrl } from './utils';
import { candidateJobName, resolveJob } from './jobs';
import { educationFilter } from './education';
import { ApiError, scoreCandidate } from './scorer';
import { hasResumeBody } from './materials';
import { activeCandidates, candidateForKey, deduplicateCandidates } from './identity';
export type Scorer = typeof scoreCandidate;
export class Engine {
  state!: State;
  private chain: Promise<unknown> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private pumping = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private db: Persistence, public settings: Settings, private scorer: Scorer = scoreCandidate, private changed = () => {}) {}
  async init() {
    this.state = await this.db.load();
    await this.change(s => {
      s.effectiveConcurrency = Math.min(s.effectiveConcurrency, this.settings.concurrency);
      for (const t of Object.values(s.tasks)) if (t.state === 'running') {
        // 重启后的在途请求可能已经计费，暂停为显式待重试，防止静默重复付费。
        t.state = 'error'; t.error = '后台曾中断，请求是否计费未知；请手动重试';
      }
      this.expire(s);
      for (const t of Object.values(s.tasks)) if (t.stage === 'quick' && t.state !== 'done') {
        t.state = 'cancelled'; t.error = '聊天或列表摘要不作为简历筛选依据，请打开在线简历';
      }
      // 更新解析规则后可从本地原文补回关联；保留所有记录和收藏，等待用户继续分析。
      if (Object.values(s.candidates).some(c => !c.jobId && resolveJob(c, s.jobs, this.settings).job)) s.paused = true;
      this.mergeDuplicates(s);
    });
    await this.reprepare();
  }
  async change<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    const operation = this.chain.then(async () => {
      const draft = structuredClone(this.state); const result = await fn(draft);
      await this.db.save(draft); this.state = draft; this.changed(); return result;
    });
    this.chain = operation.catch(() => {}); return operation;
  }
  private expire(s: State) {
    const cutoff = Date.now() - this.settings.retentionDays * 86400000;
    const expired = Object.keys(s.candidates).filter(key => (candidateForKey(s, key)?.updatedAt || 0) < cutoff);
    for (const key of expired) {
      delete s.candidates[key];
      for (const [id, t] of Object.entries(s.tasks)) if (t.candidateKey === key) { this.controllers.get(id)?.abort(); delete s.tasks[id]; }
    }
  }
  private mergeDuplicates(s: State) {
    if (!deduplicateCandidates(s)) return;
    const keep = new Set(currentTasks(s, this.settings).map(t => t.key));
    const merged = new Set(Object.values(s.candidates).filter(c => c.duplicateOf).map(c => candidateForKey(s, c.key)?.key));
    for (const task of Object.values(s.tasks)) if (merged.has(candidateForKey(s, task.candidateKey)?.key) && !keep.has(task.key) && ['waiting', 'running'].includes(task.state)) {
      task.error = task.state === 'running' ? '重复记录已合并，请求已停止；上游是否计费未知' : '重复记录已合并，不重复提交相同简历';
      task.state = 'cancelled'; this.controllers.get(task.key)?.abort();
    }
  }
  async cleanup() { await this.change(s => this.expire(s)); }
  async ingest(inputs: CandidateInput[]) {
    if (!this.settings.scanEnabled) return;
    await this.change(async s => {
      for (const input of inputs) {
        if (input.stage === 'deep' && !hasResumeBody(input.rawText)) continue;
        const originalKey = appKey(input), previous = candidateForKey(s, originalKey), key = previous?.key || originalKey, now = Date.now();
        const textHash = await hash(input.rawText);
        const c: Candidate = previous ?? { ...input, key, resolution: '', quickText: '', deepText: '', quickHash: '', deepHash: '', analyses: [], status: '未收藏', createdAt: now, updatedAt: now };
        // 列表重新出现时保留详情中的明确资料，材料按阶段独立管理。
        const avatarUrl = safeAvatarUrl(input.avatarUrl) || safeAvatarUrl(c.avatarUrl) || undefined;
        if (!c.deepText || input.stage === 'deep') Object.assign(c, input, { id: c.id, identity: c.identity, bossJobId: c.bossJobId, bossJobName: c.bossJobName });
        c.avatarUrl = avatarUrl;
        if (input.stage === 'quick' && !c.deepText && c.chatProfile) { c.school = c.chatProfile.school; c.degree = c.chatProfile.degree; }
        c.priority = input.priority; c.updatedAt = now;
        if (input.stage === 'quick') { c.quickText = input.rawText; c.quickHash = textHash; }
        else { c.deepText = input.rawText; c.deepHash = textHash; delete c.resumeReadStatus; }
        s.candidates[key] = c;
      }
      this.mergeDuplicates(s);
      for (const key of new Set(inputs.map(input => candidateForKey(s, appKey(input))?.key))) {
        const c = key && s.candidates[key]; if (c) await this.prepare(s, c, 'deep');
      }
    });
    void this.pump();
  }
  async enrichChatProfile(input: CandidateInput, profile: ChatProfile) {
    if (!this.settings.scanEnabled) return;
    await this.change(s => {
      const c = candidateForKey(s, appKey(input));
      const name = (v: string) => normalize(v).replace(/[.·。]+$/, '');
      if (!c || name(c.name) !== name(profile.name)
        || normalize(candidateJobName(c, s.jobs)) !== normalize(profile.jobName)) return;
      c.chatProfile = profile; c.updatedAt = Date.now();
      if (!c.deepText) { c.school = profile.school; c.degree = profile.degree; }
      const job = s.jobs.find(j => j.id === c.jobId);
      c.education = job ? educationFilter(c, job, s.schools) : undefined;
      // 补资料只更新本地规则，不改写已评分材料或重新调用模型。
    });
  }
  async noteResumeRead(input: CandidateInput, status: Candidate['resumeReadStatus']) {
    if (!this.settings.scanEnabled) return;
    await this.change(s => {
      const c = candidateForKey(s, appKey(input));
      if (c && c.name === input.name && !c.deepText && (c.resumeReadStatus !== 'insufficient' || status === 'insufficient')) c.resumeReadStatus = status;
    });
  }
  private async prepare(s: State, c: Candidate, stage: Stage, force = false) {
    const result = resolveJob(c, s.jobs, this.settings);
    c.jobId = result.job?.id; c.resolution = result.reason;
    c.education = result.job ? educationFilter(c, result.job, s.schools) : undefined;
    const job = result.job;
    if (stage === 'quick') return;
    const text = c.deepText;
    if (!hasResumeBody(text)) return;
    if (!job || !text || (stage === 'deep' && !this.settings.autoDeep && !force)) return;
    if (job.educationAction === 'skip' && c.education?.status === 'fail') return;
    const model = this.settings.deepModel || this.settings.quickModel;
    const textHash = c.deepHash;
    const key = await hash(JSON.stringify([c.key, job.id, job.version, textHash, stage, model, this.settings.endpoint]));
    if (s.tasks[key]) { s.tasks[key].endpoint = this.settings.endpoint; return; }
    if (currentTasks(s, this.settings).some(t => candidateForKey(s, t.candidateKey)?.key === c.key)) return;
    if (c.analyses.some(a => a.key === key)) return;
    // 同阶段材料更新后取消旧任务，避免把过时结果写回当前卡片。
    for (const old of Object.values(s.tasks)) if (candidateForKey(s, old.candidateKey)?.key === c.key && old.stage === stage && ['waiting', 'running'].includes(old.state)) {
      old.state = 'cancelled'; this.controllers.get(old.key)?.abort();
    }
    s.tasks[key] = { key, candidateKey: c.key, job: structuredClone(job), stage, text, textHash, model, endpoint: this.settings.endpoint, state: 'waiting', priority: c.priority, attempts: 0, readyAt: 0, createdAt: Date.now() };
  }
  async reprepare() {
    await this.change(async s => {
      await restoreTaskEndpoints(s, this.settings);
      for (const t of Object.values(s.tasks)) if (['waiting', 'running'].includes(t.state)) {
        const c = candidateForKey(s, t.candidateKey);
        const job = c && resolveJob(c, s.jobs, this.settings).job;
        const education = job && educationFilter(c, job, s.schools);
        if (t.stage === 'quick' || !hasResumeBody(t.text) || !job || job.id !== t.job.id || job.version !== t.job.version || (education?.status === 'fail' && job.educationAction === 'skip')) {
          t.state = 'cancelled'; this.controllers.get(t.key)?.abort();
        }
      }
      // 撤销的任务保留；同一缓存键仅允许通过“重试/恢复已取消”重新进入队列。
      for (const c of activeCandidates(s)) {
        await this.prepare(s, c, 'quick'); if (c.deepText) await this.prepare(s, c, 'deep');
      }
    });
    void this.pump();
  }
  async saveJob(job: Job) {
    if (!job.name.trim() || !job.jd.trim()) throw new Error('请填写岗位名称和完整 JD');
    await this.change(s => {
      const previous = s.jobs.find(j => j.id === job.id);
      const scoringChanged = previous && (previous.jd !== job.jd || previous.notes !== job.notes || previous.name !== job.name);
      const next = { ...job, version: previous ? previous.version + (scoringChanged ? 1 : 0) : 1 };
      s.jobs = [...s.jobs.filter(j => j.id !== job.id), next];
    });
    await this.reprepare();
  }
  async pause(value: boolean) { await this.change(s => { s.paused = value; }); if (!value) void this.pump(); }
  async cancel() {
    await this.change(s => { s.paused = true; for (const t of Object.values(s.tasks)) if (['waiting', 'running'].includes(t.state)) t.state = 'cancelled'; });
    this.controllers.forEach(c => c.abort());
  }
  async retry(key?: string) {
    await this.change(async s => { for (const t of currentTasks(s, this.settings)) if ((!key || candidateForKey(s, t.candidateKey)?.key === candidateForKey(s, key)?.key) && ['error', 'cancelled'].includes(t.state)) {
      if (t.stage === 'quick' || !hasResumeBody(t.text)) continue;
      const c = candidateForKey(s, t.candidateKey), job = s.jobs.find(j => j.id === c?.jobId);
      if (!c || !job || t.job.id !== job.id || t.job.version !== job.version || t.textHash !== c.deepHash) continue;
      if (c.education?.status === 'fail' && job.educationAction === 'skip') continue;
      const model = this.settings.deepModel || this.settings.quickModel;
      const currentKey = await hash(JSON.stringify([t.candidateKey, job.id, job.version, t.textHash, t.stage, model, this.settings.endpoint]));
      if (t.key !== currentKey) continue;
      t.state = 'waiting'; t.attempts = 0; t.readyAt = 0; delete t.error;
    } });
    void this.pump();
  }
  async deep(key: string) { await this.change(async s => { const c = candidateForKey(s, key); if (!c?.deepText) throw new Error('请先手动打开此人的 BOSS 完整简历'); await this.prepare(s, c, 'deep', true); }); void this.pump(); }
  async saveCandidate(key: string, status?: Candidate['status']) {
    await this.change(s => { const c = candidateForKey(s, key); if (!c) throw new Error('候选人已过期或不存在'); c.savedAt ||= Date.now(); c.status = status ?? '已收藏'; });
  }
  async deleteCandidate(key: string) {
    await this.change(s => { const canonical = candidateForKey(s, key)?.key; if (!canonical) return; const group = Object.keys(s.candidates).filter(k => candidateForKey(s, k)?.key === canonical); for (const k of group) delete s.candidates[k]; for (const [id, t] of Object.entries(s.tasks)) if (group.includes(t.candidateKey)) { this.controllers.get(id)?.abort(); delete s.tasks[id]; } });
  }
  async prioritize(keys: string[]) {
    await this.change(s => { const canonical = keys.map(k => candidateForKey(s, k)?.key); for (const t of Object.values(s.tasks)) if (t.state === 'waiting') t.priority = canonical.includes(candidateForKey(s, t.candidateKey)?.key) ? 2 : 0; }); void this.pump();
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      if (this.state.paused || !this.settings.consent || !this.settings.apiKey || !hasCompleteEndpoint(this.settings.endpoint)) return;
      const picked: Task[] = [];
      await this.change(s => {
        const capacity = Math.min(this.settings.concurrency, s.effectiveConcurrency) - Object.values(s.tasks).filter(t => t.state === 'running').length;
        const waiting = currentTasks(s, this.settings).filter(t => t.stage === 'deep' && hasResumeBody(t.text) && t.state === 'waiting' && t.readyAt <= Date.now() && t.model && !this.controllers.has(t.key)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
        for (const t of waiting.slice(0, Math.max(0, capacity))) { t.state = 'running'; t.attempts++; picked.push(structuredClone(t)); }
      });
      for (const task of picked) void this.run(task);
      clearTimeout(this.timer);
      const next = currentTasks(this.state, this.settings).filter(t => t.state === 'waiting' && t.readyAt > Date.now()).sort((a, b) => a.readyAt - b.readyAt)[0];
      if (next) this.timer = setTimeout(() => void this.pump(), Math.min(2147483647, Math.max(100, next.readyAt - Date.now())));
    } finally { this.pumping = false; }
  }
  private async run(task: Task) {
    const controller = new AbortController(); this.controllers.set(task.key, controller);
    const timeout = setTimeout(() => controller.abort('timeout'), 120000);
    try {
      const c = candidateForKey(this.state, task.candidateKey); if (!c) return;
      const result = await this.scorer(task, c, { ...this.settings }, controller.signal);
      await this.change(s => {
        const live = s.tasks[task.key], candidate = candidateForKey(s, task.candidateKey);
        if (!live || live.state !== 'running' || !candidate) return;
        live.state = 'done';
        candidate.analyses.push({ key: task.key, stage: task.stage, jobId: task.job.id, jobName: task.job.name, jobVersion: task.job.version, jd: task.job.jd, textHash: task.textHash, model: task.model, ...result, createdAt: Date.now() });
        candidate.analyses = candidate.analyses.slice(-20);
        if (Object.values(s.tasks).filter(t => t.state === 'done').length % 10 === 0) s.effectiveConcurrency = Math.min(this.settings.concurrency, s.effectiveConcurrency + 1);
      });
    } catch (error) {
      await this.change(s => {
        const t = s.tasks[task.key]; if (!t || t.state !== 'running') return;
        const api = controller.signal.aborted ? new ApiError(`${controller.signal.reason === 'timeout' ? '模型请求超过 2 分钟未完成' : '请求已中断'}；上游是否计费未知，请手动重试`)
          : error instanceof ApiError ? error : new ApiError('请求或响应解析失败');
        if (api.limited) s.effectiveConcurrency = Math.max(1, Math.floor(s.effectiveConcurrency / 2));
        t.error = api.message + (api.requestId ? `；请求标识：${api.requestId.slice(0, 200)}` : '');
        t.state = api.retryable && t.attempts < 3 ? 'waiting' : 'error';
        t.readyAt = Date.now() + Math.max(api.retryAfter, 1500 * 2 ** (t.attempts - 1) + Math.random() * 500);
        if (api.limited) for (const pending of Object.values(s.tasks)) if (pending.state === 'waiting') pending.readyAt = Math.max(pending.readyAt, t.readyAt);
      });
    } finally { clearTimeout(timeout); this.controllers.delete(task.key); void this.pump(); }
  }
}
export function latestAnalysis(c: Candidate, jobs: Job[]) {
  const job = jobs.find(j => j.id === c.jobId);
  return c.analyses.filter(a => a.stage === 'deep' && hasResumeBody(c.deepText) && a.jobId === job?.id && a.jobVersion === job.version && a.textHash === c.deepHash).sort((a, b) => b.createdAt - a.createdAt)[0];
}
export function currentTasks(state: State, settings: Settings): Task[] {
  const model = settings.deepModel || settings.quickModel;
  const tasks = Object.values(state.tasks).filter(task => {
    const c = candidateForKey(state, task.candidateKey), job = c && state.jobs.find(j => j.id === c.jobId);
    return !!c && !!job && task.stage === 'deep' && task.job.id === job.id && task.job.version === job.version
      && task.textHash === c.deepHash && task.model === model && task.endpoint === settings.endpoint;
  });
  const rank = { done: 0, running: 1, error: 2, waiting: 3, cancelled: 4 };
  const unique = new Map<string, Task>();
  for (const task of tasks.sort((a, b) => rank[a.state] - rank[b.state] || a.createdAt - b.createdAt)) {
    const key = candidateForKey(state, task.candidateKey)!.key;
    if (!unique.has(key)) unique.set(key, task);
  }
  return [...unique.values()];
}
// 旧后台未写入接口字段；只用完整缓存键确认归属，不把其他接口的历史任务算进来。
export async function restoreTaskEndpoints(state: State, settings: Settings) {
  for (const task of Object.values(state.tasks)) if (task.endpoint === undefined && task.stage === 'deep') {
    const key = await hash(JSON.stringify([task.candidateKey, task.job.id, task.job.version, task.textHash, task.stage, task.model, settings.endpoint]));
    if (key === task.key) task.endpoint = settings.endpoint;
  }
}
export function candidateQueueStatus(c: Candidate, state: State, settings: Settings, task?: Task): { label: string; reason: string } {
  if (!c.deepText && c.resumeReadStatus === 'insufficient') return { label: '已跳过 · 内容不足', reason: '简历已读取到底，正文不足以分析，已跳过；可在 BOSS 页面手动重读' };
  const job = state.jobs.find(j => j.id === c.jobId);
  if (!job) return { label: '待关联岗位', reason: c.resolution };
  if (!hasResumeBody(c.deepText)) return c.deepText || c.resumeReadStatus
    ? { label: '简历正文待识别', reason: c.resumeReadStatus === 'image' ? '在线简历以图片显示，需要文字识别后才能分析' : '已检测到在线简历，正文或身份尚未核对完成' }
    : { label: '待打开在线简历', reason: '未读取在线简历，聊天内容不参与评分' };
  if (c.education?.status === 'fail' && job.educationAction === 'skip') return { label: '学历策略跳过', reason: '未通过该岗位的学历院校条件，按岗位设置跳过分析' };
  if (task?.state === 'running') return { label: '分析中', reason: '正在使用在线简历进行岗位匹配' };
  if (task?.state === 'error') return { label: '待重试', reason: task.error || '模型请求失败，请在详情查看错误记录' };
  if (task?.state === 'cancelled') return { label: '已取消', reason: '此任务已取消，可在详情中手动恢复' };
  if (task?.state === 'waiting') {
    const reason = state.paused ? '已加入队列，点击“继续分析”后处理'
      : !settings.consent || !(settings.apiKey || (settings as Settings & { hasKey?: boolean }).hasKey) || !hasCompleteEndpoint(settings.endpoint) || !task.model
        ? '已加入队列，请在模型与设置中补全接口、模型、Key 和授权'
        : task.error || '已加入队列，等待模型处理';
    return { label: state.paused ? '已排队 · 已暂停' : '等待分析', reason };
  }
  if (task?.state === 'done') return { label: '已完成', reason: '当前简历分析任务已完成' };
  return { label: '未加入队列', reason: settings.autoDeep ? '当前模型没有此人的分析任务，可在详情点击“分析在线简历”加入队列' : '自动加入分析队列已关闭，可在详情点击“分析在线简历”' };
}
