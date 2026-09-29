import './report.css';
import { request, isPreview } from './api';
import { latestAnalysis } from '../core/engine';
import { candidateForKey } from '../core/identity';
import { escapeHtml as h } from '../core/utils';
import type { State } from '../core/types';
document.body.className='report-page';
const root=document.querySelector('#report')!;
async function main(){
  const {state}:{state:State}=await request('GET_STATE');
  const key=new URLSearchParams(location.search).get('key')||'';const c=candidateForKey(state,key);
  if(!c?.savedAt)throw new Error('请先收藏此候选人，或记录已超过保存期限。');
  const a=latestAnalysis(c,state.jobs),job=state.jobs.find(j=>j.id===c.jobId);
  const list=(items:string[])=>items.length?`<ul>${items.map(t=>`<li>${h(t)}</li>`).join('')}</ul>`:'<p>当前材料未提供，待核实。</p>';
  const title=`${c.name}_${job?.name||c.bossJobName}_${a?.score.score??'待评分'}分`.replace(/[\\/:*?"<>|]/g,'-');document.title=title;
  root.innerHTML=`<div class="print-toolbar"><span>点击打印，在目标打印机中选择“另存为 PDF”。${isPreview?'此报告仅含虚构演示数据。':''}</span><button id="print">打印 / 保存为 PDF</button></div><article class="report-sheet"><div class="report-meta">识才 · 公司内部招聘资料${isPreview?' · 演示报告':''}</div><h1>AI 候选人分析报告</h1><p class="report-meta">生成时间：${new Date().toLocaleString('zh-CN')} · 收藏时间：${new Date(c.savedAt).toLocaleString('zh-CN')}</p><h2>${h(c.name)} · ${h(job?.name||c.bossJobName||'未关联岗位')}</h2><div class="report-grid"><p>学历：${h(c.degree||'待核实')}<br>学校：${h(c.school||'待核实')}<br>经验：${h(c.experience||'待核实')}<br>跟进状态：${h(c.status)}</p><p>候选人标识：${h(c.id)}<br>身份依据：${c.identity==='stable'?'页面稳定标识':'材料指纹，需核实'}<br>AI 评分材料范围：${a?.stage==='deep'?'详情页已展示材料':'列表可见材料'}<br>JD 版本：${a?.jobVersion??job?.version??'未配置'}</p></div><h2>岗位匹配分析</h2><p><b class="report-score">${a?.score.score??'—'}</b> / 100 · ${h(a?.score.recommendation||'尚未完成分析')}</p><p>${h(a?.score.reason||'未获得当前版本的评分，不使用过期结果。')}</p>${a?.score.fitAnalysis?`<p>${h(a.score.fitAnalysis)}</p>`:''}<h2>学历与院校筛选（独立于 AI 分数）</h2><p>${c.education?.status==='pass'?'条件通过':c.education?.status==='fail'?'条件未通过':'待核实'}</p>${list(c.education?.reasons||[])}<h2>核心优势</h2>${list(a?.score.strengths||[])}<h2>主要疑点与信息缺口</h2>${list([...(a?.score.concerns||[]),...(a?.score.gaps||[])])}<h2>建议面试问题</h2>${list(a?.score.interviewQuestions||[])}<h2>教育、工作、项目及技能原始材料</h2><p class="report-meta">以下按页面原文保留，未显示的经历不作补全。</p><pre>${h(c.deepText||c.quickText)}</pre>${c.chatProfile?`<h2>已打开聊天的资料摘要</h2><p class="report-meta">聊天顶部已展示的教育与工作摘要；此处的补充资料未自动用于 AI 评分。</p><pre>${h(c.chatProfile.text)}</pre>`:''}<h2>对应岗位 JD</h2><pre>${h(a?.jd||job?.jd||'未配置')}</pre><div class="report-footer">模型：${h(a?.model||'未分析')} · 请求标识：${h(a?.requestId||'无')}<br>评分只代表当前候选人与对应 JD 的匹配参考。招聘人员应复核材料及结论。此报告仅限公司招聘用途，请按公司规定控制访问和保存期限；已导出的文件不受插件自动清理控制。</div></article>`;
  document.querySelector('#print')!.addEventListener('click',()=>window.print());
}
main().catch(e=>{root.textContent=e instanceof Error?e.message:'报告生成失败';});
