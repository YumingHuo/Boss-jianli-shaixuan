import { describe, expect, it, vi } from 'vitest';
import { newJob, defaultSettings, newState, type CandidateInput, type Settings, type State } from '../src/core/types';
import { resolveJob } from '../src/core/jobs';
import { educationFilter } from '../src/core/education';
import { Engine, latestAnalysis, currentTasks, restoreTaskEndpoints, candidateQueueStatus, type Scorer } from '../src/core/engine';
import { ApiError, parseScore, redact } from '../src/core/scorer';
import { appKey } from '../src/core/utils';
import { builtinSchools } from '../src/data/schools';
const job = { ...newJob(), id: 'agent', name: 'AI Agent 实习生', aliases: ['AI智能体开发实习生'], bossIds: ['j1'], jd: '开发 RAG 和 Agent，熟悉 Python。' };
const settings: Settings = { ...defaultSettings, scanEnabled: true, consent: true, endpoint: 'https://example.com/v1/chat/completions', apiKey: 'test-only', quickModel: 'quick', deepModel: 'deep', concurrency: 3 };
const input = (id='p1', overrides: Partial<CandidateInput> = {}): CandidateInput => ({ id, identity: 'stable', name: '张同学', bossJobId: 'j1', bossJobName: 'AI智能体开发实习生', degree: '硕士', school: '华中科技大学', experience: '应届', currentTitle: '', expectedTitle: '', skills: ['Python'], rawText: `${id}
个人优势
熟悉 Python，完成实际 RAG 项目，参与检索评估和应用部署，能够说明技术选型与效果。
教育经历
华中科技大学，计算机技术，硕士。
项目经历
基于知识库开发检索增强应用，负责文本切分、向量索引、召回与重排，通过测试集衡量效果。`, sourceUrl: 'https://www.zhipin.com/web/boss/recommend', stage: 'deep', priority: 0, ...overrides });
const validScore = { score: 92, recommendation: '强烈推荐' as const, reason: '有实际项目证据', strengths: ['RAG 项目'], concerns: ['评估细节待确认'], gaps: [], fitAnalysis: '', interviewQuestions: [] };
class MemoryDB { value: State = { ...newState(), jobs: [job] }; async load() { return structuredClone(this.value); } async save(s: State) { this.value = structuredClone(s); } }
const result = { score: validScore, requestId: 'test-request', usage: { total_tokens: 100 } };
const immediate: Scorer = async () => result;
async function setup(scorer: Scorer = immediate, overrides: Partial<Settings> = {}) { const db = new MemoryDB();const e = new Engine(db, { ...settings,...overrides }, scorer);await e.init();return {e,db}; }
async function settled(e: Engine, count=1) { await vi.waitFor(()=>expect(Object.values(e.state.tasks).filter(t=>t.state==='done')).toHaveLength(count)); }
describe('岗位识别',()=>{
  it('优先 ID，别名完整匹配，禁止错误套用',()=>{
    expect(resolveJob(input('p',{bossJobName:'其他岗位'}),[job],settings).job?.id).toBe(job.id);
    expect(resolveJob(input('p',{bossJobId:''}),[job],settings).job?.id).toBe(job.id);
    expect(resolveJob(input('p',{bossJobId:'',bossJobName:'AI'}),[job],settings).job).toBeUndefined();
    expect(resolveJob(input('p',{bossJobId:'',bossJobName:'商务拓展经理'}),[job],settings).reason).toContain('未配置该岗位');
  });
  it('冲突不选第一个，手动模式使用明确岗位',()=>{
    expect(resolveJob(input(),[job,{...job,id:'another'}],settings).reason).toContain('冲突');
    expect(resolveJob(input(),[job],{mode:'manual',manualJobId:'missing'}).job).toBeUndefined();
    expect(resolveJob(input('p',{bossJobId:'',bossJobName:''}),[job],{mode:'manual',manualJobId:'agent'}).job?.id).toBe('agent');
  });
});
describe('学历院校独立筛选',()=>{
  it('985 硕士通过，未知学校待核实，别名不模糊匹配',()=>{
    const j={...job,minDegree:'硕士' as const,schoolRequirement:'211' as const};
    expect(educationFilter(input(),j,[]).status).toBe('pass');
    expect(educationFilter(input('p',{school:'未知学校'}),j,[]).status).toBe('unknown');
    expect(educationFilter(input('p',{school:'华中科技大学独立学院'}),j,[]).status).toBe('unknown');
    expect(educationFilter(input('p',{degree:'本科'}),j,[]).status).toBe('fail');
  });
  it('院校优先不构成硬门槛，企业分组使用自定义记录',()=>{
    expect(educationFilter(input('p',{school:'未知'}),{...job,schoolRequirement:'985',schoolPreferred:true},[]).status).toBe('pass');
    expect(educationFilter(input(),{...job,schoolRequirement:'企业分组',schoolGroup:'A档'},[{name:'华中科技大学',aliases:[],tags:['985','211'],groups:['A档'],source:'公司核实'}]).status).toBe('pass');
  });
  it('985 基础记录保持 39 所且不存在重复学校名',()=>{
    expect(builtinSchools.filter(s=>s.tags.includes('985'))).toHaveLength(39);
    expect(new Set(builtinSchools.map(s=>s.name)).size).toBe(builtinSchools.length);
  });
});
describe('结构化模型输出和发送边界',()=>{
  it('拒绝伪造字段、越界分数和缺失深度结果',()=>{
    expect(parseScore(JSON.stringify(validScore)).score).toBe(92);
    expect(()=>parseScore('{"score":101}')).toThrow();
    expect(()=>parseScore(JSON.stringify({...validScore,score:'92'}))).toThrow();
    expect(()=>parseScore(JSON.stringify({...validScore,strengths:'优秀'}))).toThrow();
    expect(()=>parseScore(JSON.stringify({...validScore,fitAnalysis:undefined}),true)).toThrow();
  });
  it('移除直接联系信息和姓名，保留专业经历',()=>{
    const out=redact('张同学\n手机 13800138000\nzhang@example.com\n性别：男\nPython RAG 项目','张同学');
    expect(out).not.toContain('13800138000');expect(out).not.toContain('zhang@example.com');expect(out).not.toContain('张同学');expect(out).not.toContain('男');expect(out).toContain('Python RAG');
  });
});
describe('持久化并发队列',()=>{
  it('等待 90 秒的响应可完成，超过 2 分钟才标记超时且不自动重试', async () => {
    vi.useFakeTimers();
    try {
      let received: AbortSignal | undefined;
      const slow=vi.fn<Scorer>((_t,_c,_s,signal)=>new Promise((resolve,reject)=>{
        received=signal;
        const timer=setTimeout(()=>resolve(result),90000);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});
      }));
      const {e}=await setup(slow); await e.ingest([input()]); await e.pause(false);
      await vi.advanceTimersByTimeAsync(30000); expect(received?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60000); expect(Object.values(e.state.tasks)[0].state).toBe('done');
      const hanging=vi.fn<Scorer>((_t,_c,_s,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new ApiError('响应读取中断',true)),{once:true})));
      const other=await setup(hanging); await other.e.ingest([input()]); await other.e.pause(false);
      await vi.advanceTimersByTimeAsync(119000); expect(Object.values(other.e.state.tasks)[0].state).toBe('running');
      await vi.advanceTimersByTimeAsync(1000); expect(Object.values(other.e.state.tasks)[0]).toMatchObject({state:'error',attempts:1});
      expect(Object.values(other.e.state.tasks)[0].error).toContain('超过 2 分钟');
      await vi.advanceTimersByTimeAsync(120000); expect(hanging).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('新工作台读取旧后台数据时恢复当前错误统计，关闭自动入队也不会隐藏错误', async () => {
    const scorer=vi.fn(immediate), {e}=await setup(scorer); await e.ingest([input()]);
    const snapshot=structuredClone(e.state), task=Object.values(snapshot.tasks)[0];
    delete task.endpoint; task.state='error'; task.error='HTTP 400：模型参数不支持';
    const manual={...e.settings,autoDeep:false};
    expect(currentTasks(snapshot,manual)).toHaveLength(0);
    await restoreTaskEndpoints(snapshot,manual);
    expect(currentTasks(snapshot,manual)).toHaveLength(1);
    expect(candidateQueueStatus(Object.values(snapshot.candidates)[0],snapshot,manual,task)).toEqual({label:'待重试',reason:task.error});
    expect(scorer).not.toHaveBeenCalled();
  });
  it('旧任务属于其他接口时不冒充当前任务，也不凭空显示等待分析', async () => {
    const {e}=await setup(); await e.ingest([input()]);
    const snapshot=structuredClone(e.state), task=Object.values(snapshot.tasks)[0]; delete task.endpoint;
    const other={...e.settings,endpoint:'https://other.example/v1/chat/completions'};
    await restoreTaskEndpoints(snapshot,other);
    expect(task.endpoint).toBeUndefined(); expect(currentTasks(snapshot,other)).toHaveLength(0);
    expect(candidateQueueStatus(Object.values(snapshot.candidates)[0],snapshot,other).label).toBe('未加入队列');
  });
  it('关闭自动入队时显示实际原因，手动加入后才显示排队并执行一次', async () => {
    const scorer=vi.fn(immediate), {e}=await setup(scorer,{autoDeep:false}); await e.ingest([input()]);
    const c=Object.values(e.state.candidates)[0];
    expect(candidateQueueStatus(c,e.state,e.settings).reason).toContain('自动加入分析队列已关闭');
    expect(currentTasks(e.state,e.settings)).toHaveLength(0);
    await e.deep(c.key); const task=currentTasks(e.state,e.settings)[0];
    expect(candidateQueueStatus(c,e.state,e.settings,task).label).toBe('已排队 · 已暂停');
    await e.pause(false); await settled(e); expect(scorer).toHaveBeenCalledTimes(1);
  });
  it('头像晚于正文出现时补到同一记录，之后缺图不清空，也不触发额外评分', async () => {
    const scorer=vi.fn(immediate); const {e}=await setup(scorer); await e.ingest([input()]);
    await e.ingest([input('p1',{stage:'quick',rawText:'昨天 张同学 您好，希望沟通',avatarUrl:'https://img.bosszhipin.com/avatar/test.jpg'})]);
    await e.ingest([input('p1',{stage:'quick',rawText:'昨天 张同学 您好，希望沟通'})]);
    expect(Object.keys(e.state.candidates)).toHaveLength(1); expect(e.state.candidates[appKey(input())].avatarUrl).toContain('test.jpg');
    expect(Object.keys(e.state.tasks)).toHaveLength(1); expect(scorer).not.toHaveBeenCalled();
  });
  it('换模型或接口后，旧异常保留在历史，不混入当前异常统计', async () => {
    const {e}=await setup(); await e.ingest([input()]);
    await e.change(s=>{Object.values(s.tasks)[0].state='error';});
    expect(currentTasks(e.state,e.settings).filter(t=>t.state==='error')).toHaveLength(1);
    e.settings={...e.settings,deepModel:'new-model'}; await e.reprepare();
    expect(currentTasks(e.state,e.settings)).toHaveLength(1); expect(currentTasks(e.state,e.settings)[0].state).toBe('waiting');
    await e.change(s=>{currentTasks(s,e.settings)[0].state='error';});
    e.settings={...e.settings,endpoint:'https://other.example/v1/chat/completions'}; await e.reprepare();
    expect(currentTasks(e.state,e.settings)).toHaveLength(1); expect(currentTasks(e.state,e.settings)[0].state).toBe('waiting');
    expect(Object.values(e.state.tasks).filter(t=>t.state==='error')).toHaveLength(2);
  });
  it('旧任务缺少接口字段时，按已核对的缓存键补齐，保留真实的当前错误', async () => {
    const {e,db}=await setup(); await e.ingest([input()]);
    await e.change(s=>{const t=Object.values(s.tasks)[0]; delete t.endpoint; t.state='error';});
    const restored=new Engine(db,settings,immediate); await restored.init();
    expect(currentTasks(restored.state,settings)).toHaveLength(1); expect(currentTasks(restored.state,settings)[0].state).toBe('error');
  });
  it('同时领取多个任务，完成一个立刻补位',async()=>{
    const releases:(()=>void)[]=[];let inFlight=0,max=0;
    const scorer:Scorer=async()=>{inFlight++;max=Math.max(max,inFlight);await new Promise<void>(r=>releases.push(r));inFlight--;return result;};
    const {e}=await setup(scorer);await e.ingest(Array.from({length:7},(_,i)=>input(`p${i}`)));await e.pause(false);
    await vi.waitFor(()=>expect(releases.length).toBe(3));expect(max).toBe(3);
    releases.shift()!();await vi.waitFor(()=>expect(Object.values(e.state.tasks).filter(t=>t.state==='done')).toHaveLength(1));await vi.waitFor(()=>expect(releases.length).toBe(3));
    while(Object.values(e.state.tasks).some(t=>t.state==='waiting'||t.state==='running')){releases.splice(0).forEach(r=>r());await new Promise(r=>setTimeout(r,5));}
    expect(max).toBe(3);expect(Object.values(e.state.tasks).filter(t=>t.state==='done')).toHaveLength(7);
  });
  it('视口内候选人优先；暂停时不领取后续任务',async()=>{
    const calls:string[]=[];let release!:()=>void;
    const {e}=await setup(async t=>{calls.push(t.candidateKey);await new Promise<void>(r=>release=r);return result;},{concurrency:1});
    await e.ingest([input('p1'),input('p2',{priority:2})]);await e.pause(false);await vi.waitFor(()=>expect(calls).toHaveLength(1));expect(calls[0]).toBe(appKey(input('p2')));await e.pause(true);release();await settled(e);expect(calls).toHaveLength(1);
  });
  it('去重并缓存；JD 变更失效，旧结果仍留作历史',async()=>{
    const scorer=vi.fn(immediate);const {e}=await setup(scorer);await e.ingest([input(),input()]);await e.pause(false);await settled(e);await e.ingest([input()]);expect(scorer).toHaveBeenCalledTimes(1);expect(Object.keys(e.state.candidates)).toHaveLength(1);
    await e.pause(true);await e.saveJob({...job,jd:'新 JD，要求 Agent 评估'});const c=Object.values(e.state.candidates)[0];expect(c.analyses).toHaveLength(1);expect(latestAnalysis(c,e.state.jobs)).toBeUndefined();await e.pause(false);await settled(e,2);expect(scorer).toHaveBeenCalledTimes(2);
  });
  it('同人不同岗位分别保存，不混用分数',async()=>{
    const {e}=await setup();await e.saveJob({...job,id:'finance',name:'财务会计',aliases:[],bossIds:['j2'],jd:'财务核算'});await e.ingest([input(),input('p1',{bossJobId:'j2',bossJobName:'财务会计'})]);await e.pause(false);await settled(e,2);expect(Object.keys(e.state.candidates)).toHaveLength(2);expect(new Set(Object.values(e.state.candidates).map(c=>latestAnalysis(c,e.state.jobs)?.jobId)).size).toBe(2);
  });
  it('学历跳过阻止简历分析，其他策略不改写 AI 分数',async()=>{
    const {e}=await setup();await e.saveJob({...job,minDegree:'博士',educationAction:'skip'});await e.ingest([input()]);expect(Object.keys(e.state.tasks)).toHaveLength(0);await e.saveJob({...job,minDegree:'博士',educationAction:'continue'});await e.pause(false);await settled(e);const c=Object.values(e.state.candidates)[0];expect(c.education?.status).toBe('fail');expect(latestAnalysis(c,e.state.jobs)?.score.score).toBe(92);
  });
  it('详情与列表分阶段缓存，晚到列表不能覆盖详情',async()=>{
    const {e}=await setup();await e.ingest([input()]);await e.pause(false);await settled(e);await e.ingest([input('p1',{stage:'deep',rawText:input().rawText+'\n补充项目：独立部署模型服务。'})]);await settled(e,2);await e.ingest([input('p1',{stage:'quick',degree:'',school:'',rawText:'昨天 张同学 您好，希望能进一步沟通'})]);const c=Object.values(e.state.candidates)[0];expect(c.deepText).toContain('补充项目');expect(latestAnalysis(c,e.state.jobs)?.stage).toBe('deep');
  });
  it('取消后迟到响应不能写入候选人',async()=>{
    let release!:()=>void;const {e}=await setup(async()=>{await new Promise<void>(r=>release=r);return result;});await e.ingest([input()]);await e.pause(false);await vi.waitFor(()=>expect(release).toBeDefined());await e.cancel();release();await new Promise(r=>setTimeout(r,20));expect(Object.values(e.state.candidates)[0].analyses).toHaveLength(0);expect(Object.values(e.state.tasks)[0].state).toBe('cancelled');
  });
  it('429 尊重 Retry-After 并降低并发，重试状态已落盘',async()=>{
    const {e,db}=await setup(async()=>{throw new ApiError('限流',true,60000,true);});await e.ingest([input()]);await e.pause(false);await vi.waitFor(()=>expect(Object.values(e.state.tasks)[0].attempts).toBe(1));await vi.waitFor(()=>expect(Object.values(e.state.tasks)[0].state).toBe('waiting'));const t=Object.values(db.value.tasks)[0];expect(t.readyAt).toBeGreaterThan(Date.now()+55000);expect(e.state.effectiveConcurrency).toBe(1);await e.pause(true);
  });
  it('重启恢复等待任务，在途请求标注不确定计费',async()=>{
    const {e,db}=await setup();await e.ingest([input('p1'),input('p2')]);await e.change(s=>{Object.values(s.tasks)[0].state='running';});const restored=new Engine(db,settings,immediate);await restored.init();expect(Object.values(restored.state.tasks).map(t=>t.state)).toEqual(['error','waiting']);expect(Object.values(restored.state.tasks)[0].error).toContain('计费未知');
  });
  it('修改其他岗位不能取消当前有效任务',async()=>{
    const {e}=await setup();await e.ingest([input()]);await e.saveJob({...job,id:'unrelated',name:'新岗位',bossIds:[],aliases:[]});expect(Object.values(e.state.tasks)[0].state).toBe('waiting');
  });
  it('未授权或没有 Key 时不会请求模型',async()=>{
    const scorer=vi.fn(immediate);const {e}=await setup(scorer,{consent:false});await e.ingest([input()]);await e.pause(false);expect(scorer).not.toHaveBeenCalled();
  });
  it('清理过期候选人同时清理材料和任务，包括已收藏记录',async()=>{
    const {e}=await setup();await e.ingest([input()]);const key=appKey(input());await e.saveCandidate(key);await e.change(s=>{s.candidates[key].updatedAt=0;});await e.cleanup();expect(e.state.candidates).toEqual({});expect(e.state.tasks).toEqual({});
  });
});
