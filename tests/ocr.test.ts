import { describe, expect, it } from 'vitest';
import { cleanOcrText, InsufficientResumeError, mergeResumeText, validateOcrResume } from '../src/core/ocr';
const text = '示 例 甲\n个人优势\n能够完成 Python 后端开发与 Agent 编排，具有工具调用和知识检索的项目实践。\n项目经验 DemoAgent 多 Agent 系统\n负责路由、记忆和工具治理，基于测试集比较检索效果，完成监控与部署。\n教育经历 测试大学 软件工程 硕士\n2025—2028，在读，学习计算机相关课程。';
describe('本机 OCR 简历核验', () => {
  it('兼容中文识别空格及与正文同一行的章节标题', () => { expect(cleanOcrText(text)).toContain('示例甲'); expect(validateOcrResume(text, '示例甲', 88)).toContain('DemoAgent'); });
  it('中文校名紧接教育标题时仍保留有效章节', () => { expect(validateOcrResume(text.replace('个人优势\n', ''), '示例甲', 88)).toContain('测试大学'); });
  it('姓名错配、清晰度不足及招呼文本不能进入评分', () => {
    expect(() => validateOcrResume(text, '另一同学', 88)).toThrow('姓名');
    expect(() => validateOcrResume(text, '示例甲', 30)).toThrow('清晰度');
    expect(() => validateOcrResume('示例甲 您好，我有信心胜任岗位，希望沟通。', '示例甲', 88)).toThrow('正文');
  });
  it('打开来源、当前候选人和简历均核对后，姓名乱码不阻止正文读取', () => {
    const garbled = text.replace('示 例 甲', 'e MBF ae 8');
    expect(validateOcrResume(garbled, '示例甲', 88, true)).toContain('DemoAgent');
    expect(() => validateOcrResume(garbled, '示例甲', 88)).toThrow('打开来源');
    expect(() => validateOcrResume('e MBF ae 8 您好，希望沟通', '示例甲', 88, true)).toThrow('正文');
    expect(() => validateOcrResume(garbled, '示例甲', 20, true)).toThrow('清晰度');
  });
  it('合并相邻片段的跨行重叠，保留后续新正文和不同经历中的相同短语', () => {
    const shared = '负责开发检索增强应用，完成文档切分、索引构建与效果评估，记录优化过程。';
    const merged = mergeResumeText(['工作经历\n第一家公司\n' + shared, shared.slice(0, 18) + '\n' + shared.slice(18) + '\n教育经历\n测试大学']);
    expect(merged.match(/负责开发检索增强应用/g)).toHaveLength(1); expect(merged).toContain('教育经历\n测试大学');
    expect(mergeResumeText(['公司一\n开发工程师', '公司二\n开发工程师']).match(/开发工程师/g)).toHaveLength(2);
  });
  it('只在足够长的正文重叠吻合时替换边缘残缺行', () => {
    const shared = '完成数据清洗和索引构建，使用业务测试集评估召回率，并针对失败案例调整检索方案。';
    expect(mergeResumeText(['项目经历\n' + shared + '\n教育经口', shared + '\n教育经历\n测试大学'])).toBe('项目经历\n' + shared + '\n教育经历\n测试大学');
  });
  it('只有项目一节或标题丢失但有明确教育与项目正文时仍可分析', () => {
    const single = '示例甲\n项目经历：\n' + '负责开发企业知识库，使用 Python 完成文档索引和检索，设计测试用例验证结果，记录性能与质量。'.repeat(3);
    expect(validateOcrResume(single, '示例甲', 88, true, true)).toBe(single);
    const noHeading = '示例甲\n就读于测试大学计算机专业\n相关课程：数据结构、计算机网络、软件工程。\n' + '参与企业知识库开发，负责文档切分、索引和重排，使用测试集评估检索质量并记录优化结果。'.repeat(3);
    expect(validateOcrResume(noHeading, '示例甲', 88, true, true)).toBe(noHeading);
  });
  it('到达底部不等于资料足够，只有长招呼或超长正文均不截断送出', () => {
    expect(() => validateOcrResume('您好，希望进一步沟通。'.repeat(20), '', 88, true, true)).toThrow('已读到简历底部');
    expect(() => validateOcrResume(text.repeat(500), '示例甲', 88, true, true)).toThrow('未截断提交');
  });
  it('只有完整读取并核对清晰度、身份后的内容不足，才允许自动跳过', () => {
    const sparse = '测试同学\n自学能力强，团队协作优秀\n期望职位 深圳 Python 行业不限\n教育经历\n测试大学 通信工程 本科 2023—2027';
    expect(() => validateOcrResume(sparse, '测试同学', 88, true, true)).toThrow(InsufficientResumeError);
    for (const args of [[88, true, false], [20, true, true], [88, false, true]] as const) {
      const error = (() => { try { validateOcrResume(sparse, '另一同学', args[0], args[1], args[2]); } catch (error) { return error; } })();
      expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(InsufficientResumeError);
    }
  });
});
