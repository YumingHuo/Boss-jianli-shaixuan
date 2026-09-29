import { describe, expect, it, vi } from 'vitest';
import { knownChatHeaderJob } from '../src/core/chat-header';
import { resolveJob } from '../src/core/jobs';
import { Engine } from '../src/core/engine';
import { appKey, normalizeChatEndpoint, hasCompleteEndpoint } from '../src/core/utils';
import { defaultSettings, newJob, newState, type CandidateInput, type State } from '../src/core/types';
const title='AI Agent 工程实习生 （端侧智能体方向）';
const job={...newJob(),name:title,jd:'开发端侧 Agent'};
const settings={...defaultSettings,scanEnabled:true,consent:true,apiKey:'test-only',endpoint:'https://example.com/v1/chat/completions',quickModel:'quick'};
const input=(text:string):CandidateInput=>({id:'test-candidate',identity:'stable',name:'测试同学',bossJobId:'',bossJobName:'',degree:'',school:'',experience:'',currentTitle:'',expectedTitle:'',skills:[],stage:'quick',priority:0,sourceUrl:'https://www.zhipin.com/web/chat/index',rawText:text});
class MemoryDB { value:State={...newState(),jobs:[job]}; async load(){return structuredClone(this.value);}async save(s:State){this.value=structuredClone(s);} }
describe('沟通页岗位漏读回归',()=>{
  it('从姓名后相邻标题恢复岗位，支持用户提供的单行文本',()=>{
    const text=`1 昨天 测试同学 ${title} 面试官，您好，我是计算机专业在读学生，希望沟通`;
    const r=resolveJob(input(text),[job],settings);expect(r.job?.id).toBe(job.id);expect(r.reason).toBe('沟通列表标题匹配');
  });
  it('从已存储的多行 DOM 文本恢复岗位，忽略全半角和空白差异',()=>{
    const text='1\n昨天\n测试同学\nAI Agent 工程实习生 (端侧智能体方向)\n您好，我熟悉 Python。';
    expect(resolveJob(input(text),[job],settings).job?.id).toBe(job.id);
  });
  it('识别明确的未配置标题，不把消息提及的已配置岗位套进去',()=>{
    const text=`2\n09:30\n测试同学\n商务拓展经理\n我也了解 ${title}`;
    const r=resolveJob(input(text),[job],settings);expect(r.job).toBeUndefined();expect(r.reason).toContain('商务拓展经理');
    expect(resolveJob(input(`昨天 测试同学 您好，我想应聘 ${title}`),[job],settings).job).toBeUndefined();
  });
  it('自我介绍包含姓名和岗位，但不是列表头部时不能恢复',()=>{
    expect(knownChatHeaderJob(`个人优势：我是测试同学 ${title} 很适合我`,'测试同学',[title])).toBe('');
    expect(knownChatHeaderJob(`昨天\n测试同学\n您好，我想应聘 ${title}`,'测试同学',[title])).toBe('');
  });
  it('不将长岗位标题截断为另一个岗位',()=>{
    const shorter={...job,name:'AI Agent 工程实习生'};
    expect(resolveJob(input(`昨天 测试同学 ${title} 您好`),[shorter],settings).job).toBeUndefined();
    expect(resolveJob(input('昨天 测试同学 产品经理 实习生 您好'),[{...job,name:'产品经理'}],settings).job).toBeUndefined();
  });
  it('新增岗位后重读已有材料；重启补关联保留身份、160条记录与收藏',async()=>{
    const db=new MemoryDB();db.value.jobs=[];const scorer=vi.fn();const first=new Engine(db,settings,scorer);await first.init();
    const entries=Array.from({length:160},(_,i)=>({...input(`1\n昨天\n测试同学\n${title}\n我有 Python 项目经验`),id:`p${i}`}));
    await first.ingest(entries);const key=appKey(entries[0]);await first.saveCandidate(key);const savedAt=first.state.candidates[key].savedAt;
    await first.change(s=>{s.jobs=[job];s.paused=false;});
    const restored=new Engine(db,settings,scorer);await restored.init();
    expect(Object.keys(restored.state.candidates)).toHaveLength(160);expect(Object.values(restored.state.candidates).every(c=>c.jobId===job.id)).toBe(true);expect(Object.values(restored.state.tasks).filter(t=>t.state==='waiting')).toHaveLength(0);expect(restored.state.candidates[key].savedAt).toBe(savedAt);expect(restored.state.paused).toBe(true);expect(scorer).not.toHaveBeenCalled();
    await restored.ingest([entries[0]]);expect(Object.keys(restored.state.candidates)).toHaveLength(160);
  });
  it('已存在的显式岗位字段优先，不被原文覆盖',()=>{
    const c={...input(`昨天\n测试同学\n${title}\n您好`),bossJobName:'财务助理'};
    expect(resolveJob(c,[job],settings).job).toBeUndefined();
  });
});
describe('接口根地址修复',()=>{
  it('补全根地址和 /v1，保留完整与自定义请求路径',()=>{
    expect(normalizeChatEndpoint('https://ai6s.cn')).toBe('https://ai6s.cn/v1/chat/completions');
    expect(normalizeChatEndpoint('https://ai6s.cn/v1/')).toBe('https://ai6s.cn/v1/chat/completions');
    expect(normalizeChatEndpoint('https://ai6s.cn/v1/chat/completions')).toBe('https://ai6s.cn/v1/chat/completions');
    expect(normalizeChatEndpoint('https://example.com/custom/chat')).toBe('https://example.com/custom/chat');
    expect(()=>normalizeChatEndpoint('https://user:secret@example.com')).toThrow();
  });
  it('旧配置只有根地址时，绝不把候选人发往首页',async()=>{
    const db=new MemoryDB();const scorer=vi.fn();const e=new Engine(db,{...settings,endpoint:'https://ai6s.cn'},scorer);await e.init();await e.ingest([input(`昨天\n测试同学\n${title}\n您好`)]);await e.pause(false);expect(scorer).not.toHaveBeenCalled();expect(hasCompleteEndpoint('https://ai6s.cn')).toBe(false);
  });
  it('补全地址后重试不会复活旧地址的已取消任务',async()=>{
    const db=new MemoryDB();const scorer=vi.fn();const e=new Engine(db,{...settings,endpoint:'https://example.com'},scorer);await e.init();
    await e.ingest([{...input(`昨天\n测试同学\n${title}\n您好`),bossJobName:title,stage:'deep',rawText:'测试同学\n个人优势\n熟悉 Python 开发和数据库设计，参与企业内部知识库开发，负责模型调用与检索优化。\n教育经历\n测试大学，计算机专业，本科。\n项目经历\n完成一个端侧 Agent 项目，实现工具调用与会话管理，通过测试集验证任务效果，能够解释技术选型和问题排查过程。'}]);await e.cancel();e.settings.endpoint='https://example.com/v1/chat/completions';await e.reprepare();await e.retry();
    expect(Object.values(e.state.tasks).filter(t=>t.state==='waiting')).toHaveLength(1);expect(Object.values(e.state.tasks).filter(t=>t.state==='cancelled')).toHaveLength(1);expect(scorer).not.toHaveBeenCalled();
  });
});
