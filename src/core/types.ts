export type Degree = '不限' | '高中及以下' | '专科' | '本科' | '硕士' | '博士';
export type Stage = 'quick' | 'deep';
export type Recommendation = '强烈推荐' | '推荐' | '待进一步了解' | '匹配度较低';
export interface Job {
  id: string; name: string; jd: string; notes: string; aliases: string[]; bossIds: string[];
  version: number; enabled: boolean; minDegree: Degree;
  schoolRequirement: '不限' | '985' | '211' | '双一流' | '本科院校' | '企业分组';
  schoolGroup: string; schoolPreferred: boolean;
  educationAction: 'mark' | 'collapse' | 'skip' | 'continue';
}
export interface School { name: string; aliases: string[]; tags: string[]; groups: string[]; source: string }
export interface Education { status: 'pass' | 'fail' | 'unknown'; reasons: string[]; tags: string[]; preferred: boolean }
export interface CandidateInput {
  id: string; identity: 'stable' | 'fingerprint'; name: string; bossJobId: string; bossJobName: string;
  degree: Degree | ''; school: string; experience: string; currentTitle: string;
  expectedTitle: string; skills: string[]; rawText: string; stage: Stage; sourceUrl: string; priority: number;
  resumeSource?: 'dom' | 'ocr'; ocrConfidence?: number;
  observedJobName?: string;
  avatarUrl?: string;
}
export interface ChatProfile {
  name: string; jobName: string; degree: Degree | ''; school: string; major: string; text: string;
}
export interface Score {
  score: number; recommendation: Recommendation; reason: string; strengths: string[]; concerns: string[];
  gaps: string[]; fitAnalysis: string; interviewQuestions: string[];
}
export interface Analysis {
  key: string; stage: Stage; jobId: string; jobName: string; jobVersion: number; jd: string;
  textHash: string; model: string; score: Score; createdAt: number;
  requestId: string; usage: unknown;
}
export interface Candidate extends CandidateInput {
  key: string; jobId?: string; resolution: string; education?: Education;
  duplicateOf?: string;
  quickText: string; deepText: string; quickHash: string; deepHash: string; analyses: Analysis[];
  chatProfile?: ChatProfile;
  resumeReadStatus?: 'image' | 'unavailable' | 'unmatched' | 'insufficient';
  savedAt?: number; status: '未收藏' | '已收藏' | '已沟通' | '待初试' | '技术面' | 'Offer' | '淘汰';
  createdAt: number; updatedAt: number;
}
export interface Task {
  key: string; candidateKey: string; job: Job; stage: Stage; model: string; text: string; textHash: string;
  state: 'waiting' | 'running' | 'done' | 'error' | 'cancelled'; priority: number; attempts: number;
  readyAt: number; createdAt: number; error?: string;
  endpoint?: string;
}
export interface Settings {
  endpoint: string; quickModel: string; deepModel: string; concurrency: number;
  apiKey: string; consent: boolean; scanEnabled: boolean; autoDeep: boolean;
  mode: 'auto' | 'manual'; manualJobId: string; retentionDays: number;
}
export interface State {
  schema: 1; jobs: Job[]; candidates: Record<string, Candidate>; tasks: Record<string, Task>;
  candidateAliases?: Record<string, string>; duplicateCount?: number;
  schools: School[]; paused: boolean; effectiveConcurrency: number;
}
export const defaultSettings: Settings = {
  endpoint: '', quickModel: '', deepModel: '', concurrency: 10, apiKey: '', consent: false,
  scanEnabled: false, autoDeep: true, mode: 'auto', manualJobId: '', retentionDays: 30
};
export const newState = (): State => ({ schema: 1, jobs: [], candidates: {}, tasks: {}, schools: [], paused: true, effectiveConcurrency: 10 });
export const newJob = (): Job => ({ id: crypto.randomUUID(), name: '', jd: '', notes: '', aliases: [], bossIds: [], version: 1, enabled: true, minDegree: '不限', schoolRequirement: '不限', schoolGroup: '', schoolPreferred: false, educationAction: 'mark' });
