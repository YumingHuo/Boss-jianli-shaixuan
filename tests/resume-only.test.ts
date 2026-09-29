import { describe, expect, it, vi } from 'vitest';
import { candidateQueueStatus, Engine, latestAnalysis, type Scorer } from '../src/core/engine';
import { defaultSettings, newJob, newState, type CandidateInput, type ChatProfile, type State } from '../src/core/types';
import { appKey, hash } from '../src/core/utils';
import { hasResumeBody } from '../src/core/materials';

const job = { ...newJob(), name: 'AI Agent 工程实习生', jd: '开发端侧智能体', minDegree: '本科' as const };
const greeting = '您好，我有信心能够胜任这个职位，希望能和您进一步沟通。';
const input = (id = 'p1'): CandidateInput => ({ id, identity: 'stable', name: '测试同学', bossJobId: '', bossJobName: job.name, degree: '', school: '', experience: '', currentTitle: '', expectedTitle: '', skills: [], rawText: `昨天\n测试同学\n${job.name}\n${greeting}`, stage: 'quick', sourceUrl: 'https://www.zhipin.com/web/chat/index', priority: 0 });
const resume = `测试同学\n个人优势\n熟悉 Python 和常见数据库，能够基于业务要求完成 Agent 工具调用与会话管理。\n教育经历\n测试大学，计算机专业，本科，2023—2027。\n项目经历\n完成企业知识库检索应用，负责文档切分、索引和重排，使用测试集评估检索质量并记录优化结果。`;
const settings = { ...defaultSettings, scanEnabled: true, consent: true, apiKey: 'test-only', endpoint: 'https://example.com/v1/chat/completions', quickModel: 'model', concurrency: 10 };
class MemoryDB { value: State = { ...newState(), jobs: [job] }; async load() { return structuredClone(this.value); } async save(s: State) { this.value = structuredClone(s); } }
const result = { score: { score: 80, recommendation: '推荐' as const, reason: '依据简历项目', strengths: [], concerns: [], gaps: [], fitAnalysis: '项目符合岗位要求', interviewQuestions: ['如何评估召回效果？'] }, requestId: 'test', usage: {} };
describe('在线简历作为唯一评分材料', () => {
  it('160 条招呼只发现和关联岗位，继续、重试和重建队列均不请求模型', async () => {
    const scorer = vi.fn(); const e = new Engine(new MemoryDB(), settings, scorer); await e.init();
    await e.ingest(Array.from({ length: 160 }, (_, i) => input(`p${i}`))); await e.pause(false); await e.retry(); await e.reprepare();
    expect(Object.keys(e.state.candidates)).toHaveLength(160); expect(Object.keys(e.state.tasks)).toHaveLength(0); expect(scorer).not.toHaveBeenCalled();
  });
  it('误标成详情的招呼仍不能评分；真正简历任务只含简历正文', async () => {
    const scorer = vi.fn(); const e = new Engine(new MemoryDB(), settings, scorer); await e.init(); await e.ingest([input()]);
    await e.ingest([{ ...input(), stage: 'deep' }]); expect(Object.values(e.state.tasks)).toHaveLength(0);
    await e.ingest([{ ...input(), stage: 'deep', rawText: resume }]);
    const task = Object.values(e.state.tasks)[0]; expect(task.text).toBe(resume); expect(task.text).not.toContain(greeting); expect(task.stage).toBe('deep');
  });
  it('重启取消旧摘要队列，旧分数不用于推荐，但保留原始历史和收藏', async () => {
    const db = new MemoryDB(); const scorer = vi.fn(); const e = new Engine(db, settings, scorer); await e.init(); await e.ingest([input()]); await e.saveCandidate(appKey(input()));
    await e.change(s => { const c = s.candidates[appKey(input())]; c.analyses.push({ key: 'old', stage: 'quick', jobId: job.id, jobName: job.name, jobVersion: job.version, jd: job.jd, textHash: c.quickHash, model: 'model', ...result, createdAt: Date.now() });
      s.tasks.old = { key: 'old', candidateKey: c.key, job, stage: 'quick', model: 'model', text: c.quickText, textHash: c.quickHash, state: 'waiting', priority: 0, attempts: 0, readyAt: 0, createdAt: Date.now() }; s.paused = false; });
    const restored = new Engine(db, settings, scorer); await restored.init(); await restored.retry();
    const c = restored.state.candidates[appKey(input())]; expect(restored.state.tasks.old.state).toBe('cancelled'); expect(c.savedAt).toBeTruthy(); expect(c.analyses).toHaveLength(1); expect(latestAnalysis(c, [job])).toBeUndefined(); expect(scorer).not.toHaveBeenCalled();
  });
  it('聊天资料补齐学校学历并保留指纹和收藏，后续列表不会清空资料', async () => {
    const scorer = vi.fn(); const e = new Engine(new MemoryDB(), settings, scorer); await e.init(); const card = { ...input(), id: 'fp:existing', identity: 'fingerprint' as const };
    await e.ingest([card]); await e.saveCandidate(appKey(card));
    const profile: ChatProfile = { name: card.name, jobName: job.name, school: '新余学院', degree: '本科', major: '计算机科学与技术', text: '页面教育摘要' };
    await e.enrichChatProfile(card, profile); await e.ingest([card]);
    const c = e.state.candidates[appKey(card)]; expect(c.school).toBe('新余学院'); expect(c.degree).toBe('本科'); expect(c.education?.status).toBe('pass'); expect(c.savedAt).toBeTruthy(); expect(c.quickHash).toBe(await hash(card.rawText)); expect(c.deepText).toBe(''); expect(Object.keys(e.state.candidates)).toHaveLength(1); expect(scorer).not.toHaveBeenCalled();
    await e.enrichChatProfile(card, { ...profile, name: '其他同学', school: '其他学校' }); expect(e.state.candidates[c.key].school).toBe('新余学院');
    await e.noteResumeRead(card, 'image'); expect(e.state.candidates[c.key].resumeReadStatus).toBe('image');
    await e.ingest([{ ...card, stage: 'deep', rawText: resume }]); expect(e.state.candidates[c.key].resumeReadStatus).toBeUndefined();
  });
  it('同时运行 10 份简历，第 11 份继续等待，完成后补位', async () => {
    const releases: (() => void)[] = []; const scorer: Scorer = async () => { await new Promise<void>(r => releases.push(r)); return result; };
    const e = new Engine(new MemoryDB(), settings, scorer); await e.init(); await e.ingest(Array.from({ length: 11 }, (_, i) => ({ ...input(`p${i}`), stage: 'deep' as const, rawText: resume }))); await e.pause(false);
    await vi.waitFor(() => expect(releases).toHaveLength(10)); expect(Object.values(e.state.tasks).filter(t => t.state === 'waiting')).toHaveLength(1);
    releases.shift()!(); await vi.waitFor(() => expect(Object.values(e.state.tasks).filter(t => t.state === 'done')).toHaveLength(1)); await vi.waitFor(() => expect(releases).toHaveLength(10));
    await e.cancel(); releases.forEach(r => r());
  });
  it('聊天头部、只有章节标题或图片提示均不构成简历正文', () => {
    expect(hasResumeBody(input().rawText)).toBe(false); expect(hasResumeBody('教育经历\n项目经历')).toBe(false); expect(hasResumeBody(resume)).toBe(true);
  });
  it('聊天列表未带岗位字段时，正文入库仍保持原键和已核对岗位', async () => {
    const e = new Engine(new MemoryDB(), settings, vi.fn()); await e.init(); const card = { ...input(), bossJobName: '' }; await e.ingest([card]);
    await e.ingest([{ ...card, observedJobName: job.name, stage: 'deep', rawText: resume }]);
    expect(Object.keys(e.state.candidates)).toEqual([appKey(card)]); expect(e.state.candidates[appKey(card)].jobId).toBe(job.id); expect(Object.values(e.state.tasks)).toHaveLength(1);
  });
  it('内容不足状态跨刷新保留，不入模型队列、不改收藏和跟进；手动读到有效正文后恢复', async () => {
    const db = new MemoryDB(), scorer = vi.fn(), e = new Engine(db, settings, scorer), card = input();
    await e.init(); await e.ingest([card]); await e.saveCandidate(appKey(card), '待初试');
    await e.noteResumeRead(card, 'insufficient'); await e.noteResumeRead(card, 'image'); await e.ingest([card]);
    await e.pause(false); await e.retry(); await e.reprepare();
    const restored = new Engine(db, settings, scorer); await restored.init();
    const c = restored.state.candidates[appKey(card)];
    expect(c.resumeReadStatus).toBe('insufficient'); expect(c.deepText).toBe(''); expect(c.status).toBe('待初试'); expect(c.savedAt).toBeTruthy();
    expect(candidateQueueStatus(c, restored.state, settings).label).toBe('已跳过 · 内容不足');
    expect(Object.keys(restored.state.tasks)).toHaveLength(0); expect(scorer).not.toHaveBeenCalled();
    await restored.pause(true); await restored.ingest([{ ...card, stage: 'deep', rawText: resume }]);
    expect(restored.state.candidates[c.key].resumeReadStatus).toBeUndefined(); expect(Object.values(restored.state.tasks)).toHaveLength(1);
  });
});
