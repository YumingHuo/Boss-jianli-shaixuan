import { newJob, newState, defaultSettings, type Candidate, type State } from '../core/types';
import { educationFilter } from '../core/education';
const seed = (): State => {
  const state = newState();
  state.jobs = ['AI Agent 实习生', '全栈开发工程师', '财务会计'].map((name, i) => ({ ...newJob(), id: `demo-job-${i}`, name, jd: i === 0 ? '参与企业 AI Agent 开发。使用 Python，理解 LLM、RAG、MCP 和 Tool Calling，有实际项目经验，能够解释检索评估方法。' : i === 1 ? '负责前后端产品开发，熟悉 TypeScript、React、Node.js 与数据库，具备独立交付和测试能力。' : '负责日常核算、报税和财务报表，熟悉会计准则与财务软件，认真细致。', aliases: i === 0 ? ['AI智能体开发实习生', 'Agent开发实习生'] : [], minDegree: '本科' }));
  const people = [
    ['林同学', 0, '华中科技大学', '硕士', 92, '有 Agent 与 RAG 实践，项目经历与岗位方向相符。', 'Python · RAG · MCP'],
    ['陈同学', 1, '浙江大学', '本科', 89, '具备前后端交付经验，熟悉 TypeScript 和数据库。', 'React · Node.js · PostgreSQL'],
    ['周同学', 2, '中南财经政法大学', '本科', 86, '有财务核算实习经历，需进一步核实独立报税经验。', '财务核算 · Excel · 用友'],
    ['许同学', 0, '北京邮电大学', '本科', 84, '做过知识库问答，检索评估的实际深度有待面试确认。', 'Python · LangChain · 向量检索'],
    ['吴同学', 0, '学校待确认', '本科', 78, '基础开发能力较好，Agent 的工程实践信息不足。', 'Python · FastAPI · SQL'],
    ['郑同学', 1, '同济大学', '硕士', 93, '有完整产品交付经历，能够说明架构与测试取舍。', 'TypeScript · Vue · Docker'],
    ['唐同学', 2, '学校待确认', '专科', 81, '有实际账务处理经验，学历条件需要单独复核。', '会计 · 应收应付'],
    ['顾同学', 0, '南京大学', '本科', 67, '当前材料以课程作业为主，尚缺实际 Agent 项目证据。', 'Python · 机器学习']
  ];
  people.forEach((p, i) => {
    const job = state.jobs[p[1] as number];
    const raw = `${p[0]}\n教育经历：${p[2]} ${p[3]}\n应聘岗位：${job.name}\n项目与技能：${p[6]}\n${p[5]}\n此记录是虚构的界面演示数据。`;
    const c: Candidate = { id: `demo-${i}`, key: `demo-${i}`, identity: 'stable', name: String(p[0]), bossJobId: '', bossJobName: job.name, school: String(p[2]), degree: p[3] as Candidate['degree'], experience: i % 2 ? '3 年经验' : '在校 / 应届', currentTitle: '', expectedTitle: job.name, skills: String(p[6]).split(' · '), rawText: raw, stage: 'quick', sourceUrl: '', priority: 0, jobId: job.id, resolution: '演示岗位匹配', quickText: raw, quickHash: 'demo', deepText: '', deepHash: '', analyses: [{ key: `demo-score-${i}`, stage: 'quick', jobId: job.id, jobName: job.name, jobVersion: 1, jd: job.jd, model: '演示数据（未调用模型）', textHash: 'demo', createdAt: Date.now(), requestId: '演示', usage: null, score: { score: p[4] as number, recommendation: Number(p[4]) >= 90 ? '强烈推荐' : Number(p[4]) >= 80 ? '推荐' : '待进一步了解', reason: String(p[5]), strengths: ['示例：有与岗位相关的项目经历'], concerns: ['示例：实际贡献和独立完成程度需要核实'], gaps: [], fitAnalysis: '', interviewQuestions: [] } }], status: i === 0 || i === 2 ? '已收藏' : '未收藏', savedAt: i === 0 || i === 2 ? Date.now() : undefined, createdAt: Date.now(), updatedAt: Date.now() };
    c.education = educationFilter(c, job, []); state.candidates[c.key] = c;
  });
  return state;
};
let demoState: State = JSON.parse(localStorage.getItem('shicai-demo-state') || 'null') || (new URLSearchParams(location.search).has('demo') ? seed() : newState());
export async function demoRequest(type: string, payload: Record<string, any>) {
  if (type === 'GET_STATE') return { state: demoState, settings: { ...defaultSettings, hasKey: false } };
  if (type === 'LOAD_DEMO') demoState = seed();
  else if (type === 'SAVE_JOB') { const j = payload.job; const prev = demoState.jobs.find(x => x.id === j.id); j.version = prev ? prev.version + 1 : 1; demoState.jobs = [...demoState.jobs.filter(x => x.id !== j.id), j]; }
  else if (type === 'SAVE_CANDIDATE') { demoState.candidates[payload.key].savedAt = Date.now(); demoState.candidates[payload.key].status = payload.status || '已收藏'; }
  else if (type === 'DELETE_CANDIDATE') delete demoState.candidates[payload.key];
  else if (type === 'SAVE_SCHOOLS') demoState.schools = payload.schools;
  else if (type === 'PAUSE' || type === 'CANCEL') demoState.paused = type === 'CANCEL' || payload.paused;
  else throw new Error('此功能需要加载 Chrome 扩展；浏览器预览不会读取 BOSS 或调用模型');
  localStorage.setItem('shicai-demo-state', JSON.stringify(demoState)); return true;
}
