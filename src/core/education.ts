import type { CandidateInput, Degree, Education, Job, School } from './types';
import { builtinSchools } from '../data/schools';
import { normalize } from './utils';
export const degreeRanks: Record<Degree, number> = { 不限: 0, 高中及以下: 1, 专科: 2, 本科: 3, 硕士: 4, 博士: 5 };
export function allSchools(custom: School[]): School[] {
  const map = new Map(builtinSchools.map(s => [normalize(s.name), s]));
  custom.forEach(s => map.set(normalize(s.name), s)); return [...map.values()];
}
export function educationFilter(c: Pick<CandidateInput, 'degree' | 'school'>, job: Job, custom: School[]): Education {
  let fail = false, unknown = false; const reasons: string[] = [];
  if (job.minDegree !== '不限') {
    if (!c.degree) { unknown = true; reasons.push('最高学历未明确，待核实'); }
    else if (degreeRanks[c.degree] < degreeRanks[job.minDegree]) { fail = true; reasons.push(`页面学历${c.degree}，低于${job.minDegree}`); }
    else reasons.push(`页面学历${c.degree}，满足最低学历`);
  }
  const matches = allSchools(custom).filter(s => [s.name, ...s.aliases].some(n => normalize(n) === normalize(c.school)));
  const school = matches.length === 1 ? matches[0] : undefined;
  let preferred = false;
  if (job.schoolRequirement !== '不限') {
    const pass = school && (job.schoolRequirement === '企业分组' ? school.groups.includes(job.schoolGroup) : school.tags.includes(job.schoolRequirement));
    if (job.schoolPreferred) { preferred = !!pass; reasons.push(pass ? '满足院校优先条件' : '院校优先条件未确认，不作为硬性门槛'); }
    else if (!school) { unknown = true; reasons.push('学校未识别或不在基础库，待核实'); }
    else if (!pass) { fail = true; reasons.push(`未满足院校条件：${job.schoolRequirement === '企业分组' ? job.schoolGroup : job.schoolRequirement}`); }
    else reasons.push('满足院校条件');
  }
  return { status: fail ? 'fail' : unknown ? 'unknown' : 'pass', reasons: reasons.length ? reasons : ['该岗位未设置学历院校门槛'], tags: school?.tags ?? [], preferred };
}
