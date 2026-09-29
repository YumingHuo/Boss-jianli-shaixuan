// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ResumeIdentity } from '../src/content/resume-identity';
function frame() { const f = document.createElement('iframe'); document.body.append(f); return f; }
describe('在线简历打开来源核对', () => {
  it('必须记录入口的候选人，已有未记录来源的简历不能直接绑定', () => {
    const identity = new ResumeIdentity(), f = frame();
    expect(identity.bind('a', f)).toBeUndefined();
    identity.open('a'); expect(identity.bind('b', f)).toBeUndefined();
    const binding = identity.bind('a', f);
    expect(identity.matches(binding, 'a', f)).toBe(true);
    identity.select('a'); expect(identity.matches(binding, 'a', f)).toBe(true);
    expect(identity.matches(binding, 'b', f)).toBe(false);
    identity.select('b'); expect(identity.matches(binding, 'a', f)).toBe(false);
  });
  it('切换后再切回、关闭重开或换简历文档，旧识别结果都不再有效', () => {
    const identity = new ResumeIdentity(), f = frame(); identity.open('a');
    const binding = identity.bind('a', f);
    expect(identity.matches(binding, 'a', undefined)).toBe(false);
    expect(identity.matches(binding, 'a', frame())).toBe(false);
    identity.clear(); identity.open('a');
    expect(identity.matches(binding, 'a', f)).toBe(false);
    const current = identity.bind('a', f);
    Object.defineProperty(f, 'contentDocument', { value: document.implementation.createHTMLDocument() });
    expect(identity.matches(current, 'a', f)).toBe(false);
    expect(identity.bind('a', f)).toBeUndefined();
  });
});
