import { BUILD_VERSION } from '../core/version';
import { Engine, latestAnalysis, currentTasks, candidateQueueStatus } from '../core/engine';
import { LocalDatabase } from '../core/storage';
import { defaultSettings, type CandidateInput, type ChatProfile, type Job, type Settings, type School } from '../core/types';
import { endpointOrigin, safeBossUrl, normalizeChatEndpoint, safeAvatarUrl } from '../core/utils';
import { recognizeImage } from './ocr';
import { scoreInBackground } from './scorer';
import { activeCandidates, candidateForKey, candidateViewState } from '../core/identity';

const db = new LocalDatabase();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get('settings');
  const engine = new Engine(db, { ...defaultSettings, ...(saved.settings as Partial<Settings> | undefined) }, scoreInBackground);
  await engine.init();
  await chrome.alarms.create('queue-wake', { periodInMinutes: 0.5 });
  await chrome.alarms.create('retention', { periodInMinutes: 60 });
  void engine.pump(); return engine;
})();
const dashboardUrl = chrome.runtime.getURL('index.html');
chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: dashboardUrl }); });
chrome.alarms.onAlarm.addListener(alarm => { void ready.then(async e => { if (alarm.name === 'retention') await e.cleanup(); await e.pump(); }); });

function safeInput(value: unknown): CandidateInput {
  if (!value || typeof value !== 'object') throw new Error('候选人数据无效');
  const v = value as CandidateInput;
  for (const field of ['id', 'name', 'bossJobId', 'bossJobName', 'school', 'experience', 'currentTitle', 'expectedTitle', 'rawText', 'sourceUrl'] as const) if (typeof v[field] !== 'string') throw new Error('候选人字段无效');
  if (!v.id || v.id.length > 500 || !['quick', 'deep'].includes(v.stage) || !['stable', 'fingerprint'].includes(v.identity) || !Array.isArray(v.skills) || !v.skills.every(s => typeof s === 'string')) throw new Error('候选人标识或阶段无效');
  if (!['', '高中及以下', '专科', '本科', '硕士', '博士'].includes(v.degree)) throw new Error('学历字段无效');
  if (v.resumeSource !== undefined && !['dom', 'ocr'].includes(v.resumeSource)) throw new Error('简历来源无效');
  if (v.observedJobName !== undefined && (typeof v.observedJobName !== 'string' || v.observedJobName.length > 300)) throw new Error('页面岗位字段无效');
  if (v.ocrConfidence !== undefined && (typeof v.ocrConfidence !== 'number' || v.ocrConfidence < 0 || v.ocrConfidence > 100)) throw new Error('识别置信度无效');
  const input = { ...v, avatarUrl: safeAvatarUrl(v.avatarUrl) || undefined, rawText: v.rawText.slice(0, v.stage === 'quick' ? 18000 : 60000), sourceUrl: safeBossUrl(v.sourceUrl), priority: Math.max(0, Math.min(2, Number(v.priority) || 0)) };
  for (const field of ['name', 'bossJobId', 'bossJobName', 'school', 'experience', 'currentTitle', 'expectedTitle'] as const) input[field] = input[field].slice(0, 300);
  return input;
}
function safeProfile(value: unknown): ChatProfile {
  if (!value || typeof value !== 'object') throw new Error('聊天资料无效');
  const v = value as ChatProfile;
  for (const field of ['name', 'jobName', 'school', 'major', 'text'] as const) {
    if (typeof v[field] !== 'string' || v[field].length > (field === 'text' ? 10000 : 300)) throw new Error('聊天资料字段无效');
  }
  if (!['', '高中及以下', '专科', '本科', '硕士', '博士'].includes(v.degree)) throw new Error('聊天学历字段无效');
  return { name: v.name, jobName: v.jobName, school: v.school, degree: v.degree, major: v.major, text: v.text };
}
function summary(e: Engine, keys?: string[]) {
  const candidates = activeCandidates(e.state);
  const selected = (keys || []).flatMap(key => { const candidate = candidateForKey(e.state, key); return candidate ? [{ candidate, key }] : []; });
  const tasks = currentTasks(e.state, e.settings);
  return {
    version: BUILD_VERSION, scanEnabled: e.settings.scanEnabled, paused: e.state.paused, mode: e.settings.mode,
    configured: !!(e.settings.consent && e.settings.apiKey && e.settings.quickModel),
    jobs: e.state.jobs.map(j => ({ id: j.id, name: j.name, educationAction: j.educationAction })),
    stats: { discovered: candidates.length, duplicates: Object.values(e.state.candidates).filter(c => c.duplicateOf).length, completed: candidates.filter(c => !!latestAnalysis(c, e.state.jobs)).length, running: tasks.filter(t => t.state === 'running').length, waiting: tasks.filter(t => t.state === 'waiting').length, errors: tasks.filter(t => t.state === 'error').length },
    candidates: selected.map(({ candidate: c, key }) => ({ key, queueStatus: candidateQueueStatus(c, e.state, e.settings, tasks.find(t => candidateForKey(e.state, t.candidateKey)?.key === c.key)), jobId: c.jobId, resolution: c.resolution, hasResume: !!c.deepText, resumeReadStatus: c.resumeReadStatus, school: c.school, degree: c.degree, education: c.education, saved: !!c.savedAt, analysis: latestAnalysis(c, e.state.jobs)?.score, stage: latestAnalysis(c, e.state.jobs)?.stage, taskState: tasks.find(t => candidateForKey(e.state, t.candidateKey)?.key === c.key)?.state }))
  };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'ocr-worker' || message?.target === 'ocr-progress') return false;
  void (async () => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('消息来源无效');
    const privileged = !!sender.url?.startsWith(chrome.runtime.getURL('')) && !sender.tab?.url?.startsWith('https://www.zhipin.com');
    const fromBoss = !!sender.url && new URL(sender.url).origin === 'https://www.zhipin.com';
    const e = await ready;
    if (!privileged) {
      if (!fromBoss) throw new Error('仅接受 BOSS 页面消息');
      if (message.type === 'SCAN') {
        if (!Array.isArray(message.inputs) || message.inputs.length > 50) throw new Error('单批最多 50 个候选人');
        await e.ingest(message.inputs.map(safeInput)); return summary(e);
      }
      if (message.type === 'CHAT_PROFILE') { await e.enrichChatProfile(safeInput(message.input), safeProfile(message.profile)); return true; }
      if (message.type === 'RESUME_STATUS') {
        if (!['image', 'unavailable', 'unmatched', 'insufficient'].includes(message.status)) throw new Error('简历读取状态无效');
        await e.noteResumeRead(safeInput(message.input), message.status); return true;
      }
      if (message.type === 'OCR_IMAGE') {
        if (!e.settings.scanEnabled) throw new Error('页面读取已暂停');
        return recognizeImage(String(message.image));
      }
      if (message.type === 'BATCH_ANALYSIS') { await e.pause(!!message.paused); return true; }
      if (message.type === 'SUMMARY') return summary(e, Array.isArray(message.keys) ? message.keys.slice(0, 300) : []);
      if (message.type === 'PRIORITY') { await e.prioritize(message.keys.slice(0, 100)); return true; }
      if (message.type === 'SAVE_CANDIDATE') { await e.saveCandidate(String(message.key)); return true; }
      if (message.type === 'OPEN') { await chrome.tabs.create({ url: dashboardUrl }); return true; }
      throw new Error('页面没有此操作权限');
    }
    switch (message.type) {
      case 'GET_STATE': return { version: BUILD_VERSION, state: candidateViewState(e.state), settings: { ...e.settings, apiKey: '', hasKey: !!e.settings.apiKey } };
      case 'SAVE_JOB': {
        const j = message.job as Job;
        if (!j || !Array.isArray(j.aliases) || !Array.isArray(j.bossIds) || typeof j.jd !== 'string' || j.jd.length > 60000 || typeof j.notes !== 'string') throw new Error('岗位数据格式无效');
        await e.saveJob(j); return true;
      }
      case 'SAVE_SETTINGS': {
        const incoming = message.settings as Settings;
        endpointOrigin(incoming.endpoint);
        if (!await chrome.permissions.contains({ origins: [endpointOrigin(incoming.endpoint)] })) throw new Error('请先授权所填模型接口域名');
        if (!Number.isInteger(incoming.concurrency) || incoming.concurrency < 1 || incoming.concurrency > 10) throw new Error('并发数应为 1–10');
        if (!Number.isInteger(incoming.retentionDays) || incoming.retentionDays < 1 || incoming.retentionDays > 365) throw new Error('保存期限应为 1–365 天');
        const settings: Settings = { ...defaultSettings, ...incoming, endpoint: normalizeChatEndpoint(incoming.endpoint), apiKey: incoming.apiKey || (message.clearKey ? '' : e.settings.apiKey) };
        if (settings.endpoint !== e.settings.endpoint || settings.quickModel !== e.settings.quickModel || settings.deepModel !== e.settings.deepModel || !settings.consent) await e.cancel();
        await chrome.storage.local.set({ settings }); e.settings = settings;
        await e.change(s => { s.effectiveConcurrency = settings.concurrency; });
        await e.reprepare(); return true;
      }
      case 'SCAN_TOGGLE': e.settings.scanEnabled = !!message.enabled; await chrome.storage.local.set({ settings: e.settings }); return true;
      case 'PAUSE': await e.pause(!!message.paused); return true;
      case 'CANCEL': await e.cancel(); return true;
      case 'RETRY': await e.retry(message.key); return true;
      case 'DEEP': await e.deep(message.key); return true;
      case 'SAVE_CANDIDATE': {
        if (message.status && !['已收藏', '已沟通', '待初试', '技术面', 'Offer', '淘汰'].includes(message.status)) throw new Error('候选人状态无效');
        await e.saveCandidate(message.key, message.status); return true;
      }
      case 'DELETE_CANDIDATE': await e.deleteCandidate(message.key); return true;
      case 'SAVE_SCHOOLS': {
        const schools = message.schools as School[];
        if (!Array.isArray(schools) || schools.length > 5000 || schools.some(s => !s.name || !Array.isArray(s.tags) || !Array.isArray(s.groups) || !Array.isArray(s.aliases) || [...s.tags,...s.groups,...s.aliases].some(v => typeof v !== 'string'))) throw new Error('院校数据格式无效');
        await e.change(s => { s.schools = schools; }); await e.reprepare(); return true;
      }
      default: throw new Error('未知操作');
    }
  })().then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error instanceof Error ? error.message : '操作失败' }));
  return true;
});
