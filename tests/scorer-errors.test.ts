import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildMessages, scoreCandidate } from '../src/core/scorer';
import { defaultSettings, newJob, type Candidate, type Task } from '../src/core/types';
const settings={...defaultSettings,apiKey:'test-secret-key',endpoint:'https://example.com/v1/chat/completions'};
const task={stage:'deep',model:'new-model',text:'候选人完整私密材料',job:{...newJob(),name:'开发实习生',jd:'公司岗位详细说明'}} as Task;
const candidate={name:'测试同学',avatarUrl:'https://img.bosszhipin.com/private-photo.jpg'} as Candidate;
afterEach(()=>vi.unstubAllGlobals());
describe('模型接口错误诊断',()=>{
  it.each(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-max-2026-09-01'])('默认关闭 %s 的思考，不更改其他模型的请求参数',async model=>{
    const fetcher=vi.fn(async()=>new Response('{}',{status:400})); vi.stubGlobal('fetch',fetcher);
    await scoreCandidate({...task,model},candidate,settings,new AbortController().signal).catch(()=>{});
    const payload=JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(payload.enable_thinking).toBe(false); expect(payload.stream).toBe(false);
    await scoreCandidate(task,candidate,settings,new AbortController().signal).catch(()=>{});
    expect(JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[1][1].body as string)).not.toHaveProperty('enable_thinking');
  });
  it('保留服务商说明和请求标识，并移除回显的密钥与原始材料',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:`response_format is not supported; ${settings.apiKey}; ${task.text}; ${task.job.jd}`}}),{status:400,headers:{'x-request-id':'req-test'}})));
    const error=await scoreCandidate(task,candidate,settings,new AbortController().signal).catch(e=>e) as ApiError;
    expect(error).toBeInstanceOf(ApiError); expect(error.message).toContain('response_format is not supported'); expect(error.requestId).toBe('req-test');
    expect(error.message).not.toContain(settings.apiKey); expect(error.message).not.toContain(task.text); expect(error.message).not.toContain(task.job.jd); expect(error.retryable).toBe(false);
  });
  it('错误 HTML 和非 JSON 成功页给出明确提示',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>Not Found</html>',{status:404})));
    await expect(scoreCandidate(task,candidate,settings,new AbortController().signal)).rejects.toThrow('接口路径和模型名称');
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>Homepage</html>',{status:200})));
    await expect(scoreCandidate(task,candidate,settings,new AbortController().signal)).rejects.toThrow('非 JSON');
  });
  it('限流仍保留退避信息，头像不会随分析请求发送',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({message:'rate limit'}),{status:429,headers:{'retry-after':'20'}})));
    const error=await scoreCandidate(task,candidate,settings,new AbortController().signal).catch(e=>e) as ApiError;
    expect(error.retryable).toBe(true); expect(error.limited).toBe(true); expect(error.retryAfter).toBe(20000);
    expect(JSON.stringify(buildMessages(task,candidate))).not.toContain('private-photo');
  });
});
