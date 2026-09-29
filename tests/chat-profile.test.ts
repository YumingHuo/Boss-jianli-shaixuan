// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { findChatProfileRoot, matchChatProfile, readChatProfile } from '../src/content/chat-profile';
import { readOnlineResume } from '../src/content/online-resume';
import { visibleText } from '../src/content/parser';
import type { CandidateInput } from '../src/core/types';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const title = 'AI Agent 工程实习生 （端侧智能体方向）';
const input = (): CandidateInput => ({ id: 'p1', identity: 'stable', name: '测试同学', bossJobId: '', bossJobName: '', degree: '', school: '', experience: '', currentTitle: '', expectedTitle: '', skills: [], rawText: `07:40\n测试同学\n${title}\n您好，希望进一步沟通`, stage: 'quick', sourceUrl: 'https://www.zhipin.com/web/chat/index', priority: 0 });
const header = () => `<section id="profile"><div><b>测试同学.</b><span>在线</span><span>20岁</span><span>27年应届生</span><span>本科</span><a>在线简历</a><span>附件简历</span></div><div><ul><li>2026.05-2026.09</li><li>2023-2027</li></ul><ul><li>测试信息技术 · Java</li><li><span>新余学院</span><i>·</i><span>计算机科学与技术</span><i>·</i><span>本科</span></li></ul><div>沟通职位：<span>${title}</span></div><div>期望：<span>广州 &amp; 深圳 · 后端开发</span></div></div></section>`;
beforeEach(() => { document.body.innerHTML = `<main><aside><article class="geek-card">列表</article></aside>${header()}<div>招聘人员发送的聊天</div></main>`; });
describe('已打开的聊天资料', () => {
  it('从截图布局读取学校、专业和明确学历，不混入聊天正文', () => {
    const root = findChatProfileRoot(document)!; const p = readChatProfile(root)!;
    expect(root.id).toBe('profile'); expect(p).toMatchObject({ name: '测试同学', degree: '本科', school: '新余学院', major: '计算机科学与技术', jobName: title }); expect(p.text).not.toContain('招聘人员发送');
    expect(matchChatProfile(root, [input()])?.input.id).toBe('p1');
  });
  it('最近关注布局也能读取，姓名或岗位冲突及同名同岗位多人时拒绝关联', () => {
    document.querySelector('#profile')!.innerHTML = document.querySelector('#profile')!.innerHTML.replace('期望：', '最近关注：');
    const root = findChatProfileRoot(document)!;
    expect(matchChatProfile(root, [{ ...input(), name: '别的同学' }])).toBeUndefined();
    expect(matchChatProfile(root, [{ ...input(), bossJobName: '财务助理' }])).toBeUndefined();
    expect(matchChatProfile(root, [input(), { ...input(), id: 'p2' }])).toBeUndefined();
    root.setAttribute('data-candidate-id', 'p2'); expect(matchChatProfile(root, [input()])).toBeUndefined();
  });
  it('顶部为硕士但只展示本科经历时，不把本科院校当作硕士院校', () => {
    document.querySelector('#profile > div > span:last-of-type')!.textContent = '附件简历';
    document.querySelector('#profile')!.innerHTML = document.querySelector('#profile')!.innerHTML.replace('<span>本科</span><a>', '<span>硕士</span><a>');
    const p = readChatProfile(document.querySelector('#profile')!)!;
    expect(p.degree).toBe('硕士'); expect(p.school).toBe('');
  });
  it('未填写工作经历与教育摘要共用外层列表时，不把外层误当另一所学校', () => {
    const root = document.querySelector('#profile')!;
    root.innerHTML = root.innerHTML.replace('测试信息技术 · Java', '未填写工作经历');
    expect(readChatProfile(root)?.school).toBe('新余学院');
  });
  it('姓名拆成两个 DOM 文本片段时仍能唯一关联', () => {
    const root = document.querySelector('#profile')!;
    root.querySelector('b')!.innerHTML = '<span>测试</span><span>同学</span>';
    expect(matchChatProfile(root, [input()])?.input.name).toBe('测试同学');
  });
  it('隐藏资料、加载中资料和截断岗位不进行关联', () => {
    const root = document.querySelector('#profile')!; root.setAttribute('hidden', ''); expect(findChatProfileRoot(document)).toBeUndefined(); root.removeAttribute('hidden');
    root.setAttribute('aria-busy', 'true'); expect(findChatProfileRoot(document)).toBeUndefined(); root.removeAttribute('aria-busy');
    root.innerHTML = root.innerHTML.replace(title, 'AI Agent…'); expect(readChatProfile(root)).toBeUndefined();
  });
});
describe('在线简历独立文档读取', () => {
  function frame(html: string) {
    const el = document.createElement('iframe'); document.body.append(el);
    el.contentDocument!.body.innerHTML = html;
    Object.defineProperty(el, 'src', { value: 'https://www.zhipin.com/web/frame/c-resume/?source=chat-resume-online' });
    return el;
  }
  it('只有图像的简历明确标记未取得正文，不把聊天替代为简历', async () => {
    frame('<img alt=""><canvas></canvas>'); expect(await readOnlineResume(document, input())).toEqual({ status: 'image' });
  });
  it('读取同源简历正文，姓名核对后沿用同一候选人和应聘岗位', async () => {
    const el = frame('<b class="name">测试同学</b><h2>个人优势</h2><p>熟悉 Python 编程与数据库，具有 Agent 项目开发经历，能够完成检索和工具调用。</p><h2>教育经历</h2><p>测试大学，计算机技术，本科。</p><h2>项目经历</h2><p>开发知识库检索应用，负责文本切分、召回和重排，通过测试集记录效果，并完成服务部署和故障排查。</p>');
    expect(visibleText(el.contentDocument!.body)).toContain('文本切分');
    const r = await readOnlineResume(document, input()); expect(r?.status).toBe('text'); expect(r?.input?.id).toBe('p1'); expect(r?.input?.stage).toBe('deep'); expect(r?.input?.rawText).not.toContain('您好');
    el.contentDocument!.querySelector('b')!.textContent = '另一同学'; expect((await readOnlineResume(document, input()))?.status).toBe('unmatched');
  });
});
