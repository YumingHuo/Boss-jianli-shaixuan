// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseCandidate, visibleText } from '../src/content/parser';
import { webcrypto } from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
beforeEach(()=>{document.body.innerHTML='';});
const fixture=(id='p1',name='张同学')=>`<article class="geek-card" data-geek-id="${id}" data-job-id="j1"><b class="geek-name">${name}</b><span class="job-name">AI Agent 实习生</span><span class="degree">硕士</span><span class="school-name">华中科技大学</span><p>个人优势：完成 Python RAG 项目</p><span style="display:none">隐藏手机号 13800138000</span><div data-shicai="candidate">AI 分数 92</div></article>`;
describe('只读 DOM 解析',()=>{
  it('无稳定编号时，未读数、日期和最后消息变化不会为同一岗位的个人头像生成新身份', async () => {
    document.body.innerHTML='<article class="geek-card"><i>2</i><time>09:30</time><b class="geek-name">测试同学</b><span class="job-name">实习生</span><p>您好，想进一步沟通</p><img src="https://img.bosszhipin.com/upload/avatar/person.jpg?size=small"></article>';
    const el=document.querySelector('article')!, first=(await parseCandidate(el))!;
    el.querySelector('i')!.remove(); el.querySelector('time')!.textContent='昨天'; el.querySelector('p')!.textContent='已发送附件简历'; el.querySelector('img')!.src='https://img.bosszhipin.com/upload/avatar/person.jpg?size=large';
    expect((await parseCandidate(el))!.id).toBe(first.id);
    el.querySelector('.job-name')!.textContent='另一个岗位'; expect((await parseCandidate(el))!.id).not.toBe(first.id);
    el.querySelector('.job-name')!.textContent='实习生'; el.querySelector('img')!.src='https://img.bosszhipin.com/upload/avatar/another-person.jpg'; expect((await parseCandidate(el))!.id).not.toBe(first.id);
  });
  it('尚无头像时也排除时间和未读数，但不拿默认头像合并不同材料', async () => {
    document.body.innerHTML='<article><i>2</i><time>09:30</time><b class="name">测试同学</b><span class="job-name">实习生</span><p>我有项目经历</p><img src="https://img.bosszhipin.com/upload/avatar/default.jpg"></article>';
    const el=document.querySelector('article')!, first=(await parseCandidate(el))!;
    el.querySelector('i')!.remove(); el.querySelector('time')!.textContent='昨天'; expect((await parseCandidate(el))!.id).toBe(first.id);
    el.querySelector('p')!.textContent='另一份个人材料'; expect((await parseCandidate(el))!.id).not.toBe(first.id);
  });
  it('同一条目的头像晚加载只补资料，之后的消息变化也保留原键', async () => {
    document.body.innerHTML='<article><time>09:30</time><b class="name">测试同学</b><span class="job-name">实习生</span><p>您好，希望沟通</p></article>';
    const el=document.querySelector('article')!, first=(await parseCandidate(el))!;
    el.insertAdjacentHTML('beforeend','<img src="https://img.bosszhipin.com/upload/avatar/person.jpg">'); expect((await parseCandidate(el))!.id).toBe(first.id);
    el.querySelector('p')!.textContent='新消息'; expect((await parseCandidate(el))!.id).toBe(first.id);
  });
  it('提取当前展示资料，排除隐藏节点及插件回写内容',async()=>{
    document.body.innerHTML=fixture();const c=await parseCandidate(document.querySelector('article')!);expect(c?.id).toBe('p1');expect(c?.school).toBe('华中科技大学');expect(c?.degree).toBe('硕士');expect(c?.rawText).not.toContain('13800138000');expect(c?.rawText).not.toContain('AI 分数');
  });
  it('虚拟列表复用同一个节点时重新识别身份',async()=>{
    document.body.innerHTML=fixture();const el=document.querySelector('article')!;const first=await parseCandidate(el);el.setAttribute('data-geek-id','p2');el.querySelector('b')!.textContent='李同学';const second=await parseCandidate(el);expect(first?.id).toBe('p1');expect(second?.id).toBe('p2');expect(second?.name).toBe('李同学');
  });
  it('无身份匿名卡片不入库，无稳定 ID 的实名材料使用可复现指纹',async()=>{
    document.body.innerHTML=fixture();const el=document.querySelector('article')!;el.removeAttribute('data-geek-id');const a=await parseCandidate(el);expect(a?.identity).toBe('fingerprint');expect((await parseCandidate(el))?.id).toBe(a?.id);el.querySelector('b')!.remove();expect(await parseCandidate(el)).toBeNull();
  });
  it('详情页身份冲突不继承上一位候选人的岗位',async()=>{
    document.body.innerHTML=fixture();const clicked=(await parseCandidate(document.querySelector('article')!))!;document.body.innerHTML='<article data-geek-id="p2"><b class="geek-name">李同学</b><p>详情：完整的工作经历与项目经历</p></article>';const c=await parseCandidate(document.querySelector('article')!,'deep',clicked);expect(c?.id).toBe('p2');expect(c?.bossJobId).toBe('');
  });
  it('无关联的详情不猜测身份，隐藏的整个简历不读取',async()=>{
    document.body.innerHTML='<article><b class="name">李同学</b><p>完整项目经验 RAG</p></article>';expect(await parseCandidate(document.querySelector('article')!,'deep')).toBeNull();document.querySelector('article')!.setAttribute('hidden','');expect(visibleText(document.querySelector('article')!)).toBe('');
  });
  it('经历中的学历词不能当作候选人的最高学历',async()=>{
    document.body.innerHTML='<article data-geek-id="x"><b class="geek-name">周同学</b><p>曾协助博士导师开发项目，希望读硕士</p></article>';expect((await parseCandidate(document.querySelector('article')!))?.degree).toBe('');
  });
  it('读取已展示的 BOSS 头像，忽略隐藏图片、插件图片和外站地址', async () => {
    document.body.innerHTML=fixture(); const root=document.querySelector('article')!;
    root.insertAdjacentHTML('afterbegin','<img hidden src="https://img.bosszhipin.com/hidden.jpg"><img src="https://example.com/other.jpg"><img src="https://img.bosszhipin.com/avatar/test.jpg">');
    const before=await parseCandidate(root); expect(before?.avatarUrl).toBe('https://img.bosszhipin.com/avatar/test.jpg');
    root.querySelectorAll('img')[2].setAttribute('src','https://img.bosszhipin.com/avatar/updated.jpg');
    const after=await parseCandidate(root); expect(after?.id).toBe(before?.id); expect(after?.avatarUrl).toContain('updated.jpg');
  });
});
