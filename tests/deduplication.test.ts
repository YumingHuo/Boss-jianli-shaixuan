import { describe, expect, it, vi } from 'vitest';
import { activeCandidates, candidateForKey, candidateViewState, deduplicateCandidates } from '../src/core/identity';
import { Engine, currentTasks, latestAnalysis } from '../src/core/engine';
import { defaultSettings, newJob, newState, type Candidate, type CandidateInput, type State, type Task } from '../src/core/types';
import { appKey, hash } from '../src/core/utils';
const job = { ...newJob(), id:'job1', name:'实习生', jd:'完成软件开发和测试工作' };
const message = '我是计算机专业学生，有两段软件开发实习经历，负责后端接口设计和实现，使用数据库与缓存完成了知识库检索项目，也参与了系统测试与部署，希望能进一步沟通。';
const resume = '测试同学\n个人优势\n具有实际软件开发经历，能够说明业务需求和实现过程。\n教育经历\n测试大学计算机专业，本科在读，完成数据库和软件工程课程。\n项目经历\n开发知识库检索系统，负责资料切分、向量检索和接口实现，通过测试集检查检索结果，参与项目部署和维护。';
const settings = { ...defaultSettings, scanEnabled:true, consent:true, apiKey:'synthetic', endpoint:'https://example.com/v1/chat/completions', quickModel:'qwen3.8-max' };
function candidate(id:string, overrides:Partial<Candidate> = {}):Candidate {
  const input:CandidateInput={id,identity:'fingerprint',name:'测试同学',bossJobId:'',bossJobName:'实习生',school:'',degree:'',experience:'',currentTitle:'',expectedTitle:'',skills:[],stage:'quick',priority:0,sourceUrl:'https://www.zhipin.com/web/chat/index',rawText:`2\n昨天\n测试同学\n实习生\n${message}`};
  return {...input,key:appKey(input),resolution:'岗位名称或别名匹配',jobId:job.id,quickText:input.rawText,deepText:'',quickHash:id,deepHash:'',analyses:[],status:'未收藏',createdAt:1,updatedAt:Date.now(),...overrides};
}
function stateOf(...candidates:Candidate[]):State { return {...newState(),paused:false,jobs:[job],candidates:Object.fromEntries(candidates.map(c=>[c.key,c]))}; }
describe('重复候选人合并与任务归属',()=>{
  it('跳过原因合并到同一候选人，有完整正文时不保留旧跳过状态', () => {
    const state = stateOf(candidate('a'), candidate('b', { resumeReadStatus: 'insufficient' }));
    expect(deduplicateCandidates(state)).toBe(1); expect(activeCandidates(state)[0].resumeReadStatus).toBe('insufficient');
    const complete = stateOf(candidate('a', { deepText: resume, deepHash: 'complete' }), candidate('b', { resumeReadStatus: 'insufficient' }));
    expect(deduplicateCandidates(complete)).toBe(1); expect(activeCandidates(complete)[0].resumeReadStatus).toBeUndefined();
  });
  it('合并旧版因未读数变化产生的长自述记录，保留原始记录、学校和收藏',()=>{
    const a=candidate('fp:old'), b=candidate('fp:new',{createdAt:2,quickText:`09:30\n测试同学\n实习生\n${message}`,school:'测试大学',degree:'本科',savedAt:10,status:'待初试'});
    const state=stateOf(a,b); expect(deduplicateCandidates(state)).toBe(1); expect(activeCandidates(state)).toHaveLength(1);
    expect(Object.keys(state.candidates)).toHaveLength(2); expect(candidateForKey(state,b.key)).toMatchObject({key:a.key,school:'测试大学',degree:'本科',savedAt:10,status:'待初试'}); expect(state.paused).toBe(true);
    const view=candidateViewState(state); expect(Object.keys(view.candidates)).toHaveLength(1); expect(candidateForKey(view,b.key)?.key).toBe(a.key); expect(view.duplicateCount).toBe(1);
    expect(deduplicateCandidates(state)).toBe(0);
  });
  it('同一个人的上传头像地址只改变尺寸参数、消息已更新时仍能合并',()=>{
    const a=candidate('a',{avatarUrl:'https://img.bosszhipin.com/upload/avatar/person.jpg?size=small'});
    const b=candidate('b',{avatarUrl:'https://img.bosszhipin.com/upload/avatar/person.jpg?size=large',quickText:'昨天\n测试同学\n实习生\n新的消息'});
    expect(deduplicateCandidates(stateOf(a,b))).toBe(1);
  });
  it('同名不同人、不同岗位、公共头像和通用招呼不强行合并',()=>{
    expect(deduplicateCandidates(stateOf(candidate('a',{identity:'stable'}),candidate('b',{identity:'stable'})))).toBe(0);
    expect(deduplicateCandidates(stateOf(candidate('a',{avatarUrl:'https://img.bosszhipin.com/upload/avatar/a.jpg'}),candidate('b',{avatarUrl:'https://img.bosszhipin.com/upload/avatar/b.jpg'})))).toBe(0);
    expect(deduplicateCandidates(stateOf(candidate('a'),candidate('b',{bossJobName:'财务助理'})))).toBe(0);
    expect(deduplicateCandidates(stateOf(candidate('a',{school:'甲大学'}),candidate('b',{school:'乙大学'})))).toBe(0);
    const template={avatarUrl:'https://img.bosszhipin.com/upload/avatar/default.jpg',quickText:'昨天\n测试同学\n实习生\n您好，希望进一步沟通'};
    expect(deduplicateCandidates(stateOf(candidate('a',template),candidate('b',template)))).toBe(0);
    const shared='https://img.bosszhipin.com/upload/avatar/shared.jpg';
    expect(deduplicateCandidates(stateOf(candidate('a',{...template,avatarUrl:shared}),candidate('b',{...template,avatarUrl:shared}),candidate('c',{name:'另一同学',avatarUrl:shared})))).toBe(0);
  });
  it('缺头像的旧记录不能把两个明确不同的人间接合并',()=>{
    const state=stateOf(candidate('unknown'),candidate('a',{identity:'stable'}),candidate('b',{identity:'stable'}));
    expect(deduplicateCandidates(state)).toBe(0); expect(activeCandidates(state)).toHaveLength(3);
  });
  it('同一人的不同简历版本采用最近读取的正文，旧记录仍保留',()=>{
    const a=candidate('a',{avatarUrl:'https://img.bosszhipin.com/upload/avatar/a.jpg',deepText:resume,deepHash:'old',updatedAt:2});
    const b=candidate('b',{avatarUrl:a.avatarUrl,deepText:resume+'\n更新经历',deepHash:'new',updatedAt:3});
    const state=stateOf(a,b); deduplicateCandidates(state); expect(activeCandidates(state)[0].deepHash).toBe('new'); expect(state.candidates[b.key].deepText).toContain('更新经历');
  });
  it('旧任务在被合并的记录上时也保留错误，不重发；手动重试只执行一次并写回主记录',async()=>{
    const textHash=await hash(resume), a=candidate('old-a',{deepText:resume,deepHash:textHash}), b=candidate('old-b',{deepText:resume,deepHash:textHash});
    const state=stateOf(a,b), taskKey=await hash(JSON.stringify([b.key,job.id,job.version,textHash,'deep',settings.quickModel,settings.endpoint]));
    const task:Task={key:taskKey,candidateKey:b.key,job,stage:'deep',model:settings.quickModel,text:resume,textHash,state:'error',priority:0,attempts:1,readyAt:0,createdAt:1,error:'旧请求超时',endpoint:settings.endpoint};
    state.tasks[taskKey]=task;
    let saved=state; const db={load:async()=>structuredClone(saved),save:async(s:State)=>{saved=structuredClone(s);}};
    const scorer=vi.fn(async()=>({score:{score:85,recommendation:'推荐' as const,reason:'项目相关',strengths:[],concerns:[],gaps:[],fitAnalysis:'符合岗位',interviewQuestions:[]},requestId:'synthetic',usage:null}));
    const e=new Engine(db,settings,scorer); await e.init();
    expect(currentTasks(e.state,settings)).toHaveLength(1); expect(Object.keys(e.state.tasks)).toHaveLength(1); expect(scorer).not.toHaveBeenCalled();
    await e.ingest([{...b,stage:'quick'}]); await e.saveCandidate(b.key); expect(activeCandidates(e.state)).toHaveLength(1); expect(candidateForKey(e.state,b.key)?.savedAt).toBeTruthy(); expect(Object.keys(e.state.tasks)).toHaveLength(1);
    await e.retry(a.key); await e.pause(false); await vi.waitFor(()=>expect(currentTasks(e.state,settings)[0].state).toBe('done'));
    expect(scorer).toHaveBeenCalledTimes(1); expect(latestAnalysis(candidateForKey(e.state,b.key)!,e.state.jobs)?.score.score).toBe(85);
    await e.reprepare(); expect(Object.keys(e.state.tasks)).toHaveLength(1);
  });
  it('合并过的旧页面继续补学校、读取正文和收藏时仍更新同一人；到期一起清理',async()=>{
    let saved=stateOf(candidate('a'),candidate('b'));
    const db={load:async()=>structuredClone(saved),save:async(s:State)=>{saved=structuredClone(s);}};
    const e=new Engine(db,settings,vi.fn()); await e.init(); const old=candidate('b');
    await e.enrichChatProfile(old,{name:old.name,jobName:'实习生',school:'测试大学',degree:'本科',major:'计算机',text:'聊天资料'});
    await e.ingest([{...old,stage:'deep',rawText:resume}]);
    expect(activeCandidates(e.state)).toHaveLength(1); expect(candidateForKey(e.state,old.key)?.deepText).toBe(resume);
    await e.change(s=>{candidateForKey(s,old.key)!.updatedAt=1;}); await e.cleanup();
    expect(Object.keys(e.state.candidates)).toHaveLength(0); expect(Object.keys(e.state.tasks)).toHaveLength(0);
  });
  it('两条重复记录都已有排队任务时只保留一项可执行任务，恢复后不会重复收费',async()=>{
    const textHash=await hash(resume), a=candidate('a',{deepText:resume,deepHash:textHash}), b=candidate('b',{deepText:resume,deepHash:textHash});
    let saved=stateOf(a,b);
    for(const c of [a,b]) {
      const key=await hash(JSON.stringify([c.key,job.id,job.version,textHash,'deep',settings.quickModel,settings.endpoint]));
      saved.tasks[key]={key,candidateKey:c.key,job,stage:'deep',model:settings.quickModel,text:resume,textHash,state:'waiting',priority:0,attempts:0,readyAt:0,createdAt:1,endpoint:settings.endpoint};
    }
    const scorer=vi.fn(async()=>({score:{score:85,recommendation:'推荐' as const,reason:'项目相关',strengths:[],concerns:[],gaps:[],fitAnalysis:'符合岗位',interviewQuestions:[]},requestId:'synthetic',usage:null}));
    const e=new Engine({load:async()=>structuredClone(saved),save:async(s:State)=>{saved=structuredClone(s);}},settings,scorer); await e.init();
    expect(e.state.paused).toBe(true); expect(Object.values(e.state.tasks).filter(t=>t.state==='waiting')).toHaveLength(1); expect(Object.values(e.state.tasks).filter(t=>t.state==='cancelled')).toHaveLength(1);
    await e.retry(); await e.pause(false); await vi.waitFor(()=>expect(currentTasks(e.state,settings)[0].state).toBe('done')); expect(scorer).toHaveBeenCalledTimes(1);
  });
});
