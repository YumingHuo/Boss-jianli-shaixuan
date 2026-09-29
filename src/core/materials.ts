// 只有正常打开的在线简历正文才可评分；聊天消息不属于简历材料。
export function hasResumeBody(text: string): boolean {
  if (text.trim().length < 100) return false;
  const sections = new Set([...text.matchAll(/(?:^|[\s：:|丨·•])(?:[一二三四五六\d]+[、.．]\s*)?(教育经[历验]|教育背景|工作经[历验]|项目经[历验]|实习经历|个人优势|专业技能)/g)].map(m => m[1]));
  if (sections.size >= 2) return true;
  // 学生可能只有教育或项目一节；完整性由读取流程判断，不要求必须有工作经历。
  const substance = /(?:负责|实现|开发|设计|搭建|完成|参与|维护|主修|相关课程|项目描述|工作内容)[^\n]{8,}/.test(text);
  if ([...sections].some(s => s !== '个人优势') && substance) return true;
  // 标题未被识别时，需要同时出现明确的经历或教育线索及具体正文。
  return substance && /(?:20\d{2}\s*[年./－—-].{0,25}(?:20\d{2}|至今)|(?:就读于|毕业于)[^\n]{2,35}(?:大学|学院)|(?:专业|项目名称|公司名称)\s*[：:][^\n]{3,})/.test(text);
}
