import { BUILD_VERSION } from '../core/version';
import { CARD_SELECTOR, DETAIL_SELECTOR, isDisplayed, parseCandidate, visibleText } from './parser';
import { findChatProfileRoot, matchChatProfile } from './chat-profile';
import { readOnlineResume, prepareResumeParts, onlineResumeFrame } from './online-resume';
import { ResumeIdentity } from './resume-identity';
import { ResumeBatch } from './batch';
import { candidateJobName } from '../core/jobs';
import { InsufficientResumeError, mergeResumeText, validateOcrResume } from '../core/ocr';
import { appKey, hash, escapeHtml as h } from '../core/utils';
import type { CandidateInput, Education, Score } from '../core/types';
type Summary = { version?: string; scanEnabled: boolean; configured: boolean; paused: boolean; mode: string; stats: { duplicates?: number; discovered: number; completed: number; running: number; waiting: number; errors: number }; jobs: { id: string; name: string; educationAction: string }[]; candidates: { key: string; queueStatus?: { label: string; reason: string }; jobId?: string; resolution: string; hasResume: boolean; resumeReadStatus?: string; school: string; degree: string; education?: Education; saved: boolean; analysis?: Score; stage?: string; taskState?: string }[] };
const rpc = async <T>(type: string, payload = {}): Promise<T> => {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '扩展连接已断开，请刷新页面'); return response.data;
};
const cards = new Map<Element, { input: CandidateInput; key: string; signature: string; host: HTMLElement }>();
const seen = new WeakMap<Element, string>();
let clicked: { input: CandidateInput; at: number } | undefined;
let summary: Summary | undefined;
let busy = false, dirty = false;
let profileSnapshot: { signature: string; since: number; saved: boolean } | undefined;
let resumeHint = '', resumeStatusSignature = '', readProgress = '';
let readGeneration = 0;
let ocrFlight: Promise<void> | undefined, ocrAttempt = '', ocrError = '', profileKey = '';
let ocrPreview = '', ocrPreviewOpen = false;
const resumeIdentity = new ResumeIdentity();
function currentProfile() {
  const root = findChatProfileRoot(document);
  return root && matchChatProfile(root, [...cards.entries()].filter(([el]) => el.isConnected && isDisplayed(el)).map(([, c]) => c.input));
}
const batch = new ResumeBatch({
  items: () => [...cards.entries()].filter(([el, c]) => el.isConnected && isDisplayed(el) && c.input.stage === 'quick').map(([element, c]) => ({ element, key: c.key, name: c.input.name, job: candidateJobName(c.input, []), hasResume: !!summary?.candidates.find(s => s.key === c.key)?.hasResume, skipped: summary?.candidates.find(s => s.key === c.key)?.resumeReadStatus === 'insufficient' })),
  current: () => { const p = currentProfile(); return p ? { key: appKey(p.input), name: p.input.name, job: p.profile.jobName, element: [...cards.entries()].find(([, c]) => c.key === appKey(p.input))?.[0] || document.body, hasResume: false } : undefined; },
  read: () => readCurrentResume(), changed: () => toolbarView(resumeHint)
});
async function readCurrentResume(): Promise<void> {
  if (ocrFlight) return ocrFlight;
  ocrFlight = (async () => {
    const matched = currentProfile(); if (!matched) throw new Error('当前简历无法唯一关联候选人，已停止读取');
    const key = appKey(matched.input);
    if (summary?.candidates.find(c => c.key === key)?.hasResume) return;
    const frame = onlineResumeFrame(document); if (!frame) throw new Error('请先打开当前候选人的在线简历');
    const frameDocument = frame.contentDocument;
    const binding = resumeIdentity.bind(key, frame);
    const generation = readGeneration;
    const checkIdentity = () => {
      if (generation !== readGeneration || !summary?.scanEnabled) throw new Error('简历读取已停止');
      if (document.hidden) throw new Error('页面已切到后台，简历读取已停止；回到 BOSS 后请重新读取');
      const live = currentProfile();
      if (!live || appKey(live.input) !== key || onlineResumeFrame(document) !== frame || frame.contentDocument !== frameDocument || (binding && !resumeIdentity.matches(binding, key, frame))) throw new Error('识别期间候选人或简历发生变化，结果未写入；请重新读取');
    };
    const progress = (message: string) => { readProgress = resumeHint = message; toolbarView(message); };
    const capture = await prepareResumeParts(document, checkIdentity, progress);
    const signature = key + await hash(JSON.stringify(capture.segments));
    if (signature === ocrAttempt && ocrError) throw new Error(ocrError);
    ocrAttempt = signature; ocrError = ''; progress('简历已加载到底，正在本机识别正文，首次使用需要加载识字组件…');
    const texts: string[] = [], confidences: number[] = [];
    const imageCount = capture.segments.flat().filter(p => 'image' in p).length;
    let imageIndex = 0;
    for (const segment of capture.segments) {
      const pieces: string[] = [];
      for (const part of segment) {
        checkIdentity();
        if ('text' in part) { pieces.push(part.text); continue; }
        progress(`简历已加载到底，正在识别图片片段 ${++imageIndex} / ${imageCount}…`);
        const result = await rpc<{ text: string; confidence: number }>('OCR_IMAGE', { image: part.image });
        checkIdentity(); pieces.push(result.text);
        if (result.text.trim()) confidences.push(result.confidence);
      }
      texts.push(mergeResumeText(pieces));
      ocrPreview = mergeResumeText(texts);
    }
    const result = { text: mergeResumeText(texts), confidence: confidences.length ? Math.min(...confidences) : imageCount ? 0 : 100 };
    const live = currentProfile();
    if (!live || appKey(live.input) !== key) throw new Error('识别期间候选人发生变化，结果未写入；请重新读取');
    capture.verify();
    const finalProfile = currentProfile();
    if (!finalProfile || appKey(finalProfile.input) !== key) throw new Error('识别期间候选人发生变化，结果未写入；请重新读取');
    ocrPreview = result.text;
    let text: string;
    try { text = validateOcrResume(result.text, matched.input.name, result.confidence, resumeIdentity.matches(binding, key, frame), true); }
    catch (error) {
      if (error instanceof InsufficientResumeError) {
        await rpc('RESUME_STATUS', { input: matched.input, status: 'insufficient' });
        await refresh();
      }
      throw error;
    }
    await rpc('SCAN', { inputs: [{ ...matched.input, observedJobName: matched.profile.jobName, school: matched.profile.school, degree: matched.profile.degree, rawText: text, stage: 'deep', resumeSource: imageCount ? 'ocr' : 'dom', ocrConfidence: result.confidence }] });
    await refresh();
    resumeHint = `已读取在线简历 ${text.length} 字，${summary?.candidates.find(c => c.key === key)?.queueStatus?.label || '正在核对队列状态'}`;
    toolbarView(resumeHint);
  })().catch(error => { const message = error instanceof Error ? error.message : '简历文字识别失败'; ocrError = message; resumeHint = message; toolbarView(resumeHint); throw error; }).finally(() => { ocrFlight = undefined; readProgress = ''; });
  return ocrFlight;
}
const toolbar = document.createElement('div'); toolbar.setAttribute('data-shicai', 'toolbar');
Object.assign(toolbar.style, { position: 'fixed', right: '22px', bottom: '22px', zIndex: '2147483600' });
const toolbarRoot = toolbar.attachShadow({ mode: 'closed' });
document.documentElement.append(toolbar);
function toolbarView(error = '') {
  const s = summary?.stats;
  toolbarRoot.innerHTML = `<style>:host{font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#203e36}.bar{background:#fff;border:1px solid #dce5df;box-shadow:0 8px 32px #193b3022;border-radius:14px;padding:13px 17px;max-width:390px}b{color:#176d54}p{margin:5px 0;color:#607469;font-size:12px}button{font:inherit;background:#176d54;color:#fff;border:0;border-radius:7px;padding:6px 12px;cursor:pointer;float:right;margin-left:15px}</style><div class="bar"><button>工作台 ↗</button><b>识才 v${BUILD_VERSION} · ${summary?.scanEnabled ? summary.paused ? '分析已暂停' : '辅助筛选中' : '等待开启扫描'}</b><p>${h(error || (!summary?.scanEnabled ? '在工作台配置岗位后开启页面读取' : s ? `已发现 ${s.discovered} · 已完成 ${s.completed} · 分析中 ${s.running} · 等待 ${s.waiting}${s.errors ? ` · 异常 ${s.errors}` : ''}${s.duplicates ? ` · 已合并 ${s.duplicates} 条重复记录` : ''}` : '连接后台中…'))}</p>${summary?.scanEnabled && !summary.configured ? '<p>尚未授权模型，仅本地读取和匹配岗位</p>' : ''}</div>`;
  if (summary && summary.version !== BUILD_VERSION) { const notice = document.createElement('p'); notice.textContent = '扩展后台仍为旧版，请重新加载识才并刷新 BOSS 页面。'; toolbarRoot.querySelector('.bar')!.append(notice); }
  const controls = document.createElement('div'); controls.style.cssText = 'display:flex;gap:8px;clear:both;padding-top:8px';
  controls.innerHTML = `<button data-batch ${!summary?.scanEnabled || (ocrFlight && !batch.running) ? 'disabled' : ''}>${batch.running ? batch.paused ? '继续读取' : '暂停读取' : '自动读取简历'}</button>${batch.running || ocrFlight ? '<button data-stop>停止</button>' : '<button data-read>读取当前简历</button>'}`;
  toolbarRoot.querySelector('.bar')!.append(controls);
  if (batch.message) { const p = document.createElement('p'); p.textContent = batch.message; toolbarRoot.querySelector('.bar')!.append(p); }
  if (ocrPreview && ocrError) {
    const details = document.createElement('details'); details.open = ocrPreviewOpen;
    details.innerHTML = `<summary>查看本机识别正文</summary><pre style="white-space:pre-wrap;max-height:260px;overflow:auto;font:12px/1.6 inherit">${h(ocrPreview)}</pre>`;
    details.addEventListener('toggle', () => { ocrPreviewOpen = details.open; }); toolbarRoot.querySelector('.bar')!.append(details);
  }
  controls.querySelector('[data-batch]')!.addEventListener('click', () => { if (batch.running) batch.pause(); else batch.start(); });
  controls.querySelector('[data-stop]')?.addEventListener('click', () => { readGeneration++; batch.stop(); void rpc('BATCH_ANALYSIS', { paused: true }).then(refresh); });
  controls.querySelector('[data-read]')?.addEventListener('click', () => { batch.clearMessage(); ocrAttempt = ''; ocrError = ''; void readCurrentResume().catch(() => {}); });
  toolbarRoot.querySelector('button')!.addEventListener('click', () => void rpc('OPEN'));
}
function paint() {
  for (const [el, item] of cards) {
    if (!el.isConnected) { cards.delete(el); continue; }
    const result = summary?.candidates.find(c => c.key === item.key);
    const job = summary?.jobs.find(j => j.id === result?.jobId);
    const score = result?.analysis;
    const edu = result?.education;
    const label = score ? `${score.score}` : result?.queueStatus?.label || (result?.taskState === 'waiting' ? '等待分析' : result?.taskState === 'error' ? '待重试' : result?.hasResume ? '请更新扩展后台' : result?.jobId ? '待简历' : '待关联岗位');
    let html = `<style>:host{display:block;clear:both;font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#263e35}.box{margin:10px 0 4px;padding:10px 12px;background:#f2f8f4;border:1px solid #d9e9df;border-radius:9px}.head{display:flex;align-items:center;gap:9px}.score{font-size:${score ? 17 : 12}px;font-weight:700;color:#176c50}.sub{color:#60766b;margin-top:3px}.bad{color:#b44139}.warn{color:#946321}button{margin-left:auto;border:1px solid #b9d5c4;background:#fff;color:#176c50;border-radius:6px;cursor:pointer;padding:4px 8px;font:inherit}details{margin-top:4px}</style><div class="box"><div class="head"><b>${h(job?.name || item.input.bossJobName || '岗位未显示')}</b><span class="score">${h(label)}</span><button>${result?.saved ? '已收藏' : '☆ 收藏'}</button></div><div class="sub ${edu?.status === 'fail' ? 'bad' : edu?.status === 'unknown' ? 'warn' : ''}">${h(edu ? edu.status === 'pass' ? '学历条件通过 ✓' : edu.status === 'fail' ? '学历条件未通过' : '学历 / 院校待核实' : result?.resolution || '正在读取岗位')} · ${item.input.identity === 'fingerprint' ? '身份待核实' : score?.recommendation || '仅供人工复核'}</div>${result?.school || result?.degree ? `<div class="sub">${h(result.school || '学校待核实')} · ${h(result.degree || '学历待核实')}</div>` : ''}${score ? `<details ${edu?.status === 'fail' && job?.educationAction === 'collapse' ? '' : 'open'}><summary>${result?.stage === 'deep' ? '详情分析' : '列表初筛'}</summary><div>${h(score.reason)}</div></details>` : ''}${!result?.jobId ? '<a style="cursor:pointer;color:#176c50">新建 / 关联岗位 ↗</a>' : ''}</div>`;
    if (location.pathname.includes('/web/chat/')) html = `<style>:host{font:11px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.pill{display:flex;gap:5px;align-items:center;padding:2px 5px;border:1px solid #d8e7dc;border-radius:5px;background:#f4faf6;color:#176c50;white-space:nowrap}button{border:0;background:none;color:inherit;cursor:pointer;padding:0;font:inherit}</style><div class="pill" title="${h([job?.name, result?.school, result?.degree, score?.reason].filter(Boolean).join(' · '))}"><span>${h(label)}</span><button>${result?.saved ? '★' : '☆'}</button></div>`;
    if (item.host.dataset.view === html) continue;
    item.host.dataset.view = html;
    const root = item.host.shadowRoot!; root.innerHTML = html;
    root.querySelector('button')!.addEventListener('click', event => { event.stopPropagation(); void rpc('SAVE_CANDIDATE', { key: item.key }).then(refresh).catch(e => toolbarView(e.message)); });
    root.querySelector('a')?.addEventListener('click', () => void rpc('OPEN'));
  }
}
async function scan() {
  if (busy) { dirty = true; return; }
  if (!summary?.scanEnabled) return;
  busy = true;
  try {
    const inputs: CandidateInput[] = [];
    const elements = [...document.querySelectorAll(CARD_SELECTOR)].filter(el => !el.parentElement?.closest(CARD_SELECTOR) && !el.closest(DETAIL_SELECTOR));
    const details = onlineResumeFrame(document) ? [] : [...document.querySelectorAll(DETAIL_SELECTOR)].filter(el => !el.parentElement?.closest(DETAIL_SELECTOR));
    for (const root of [...elements, ...details]) {
      const isDetail = details.includes(root);
      const input = await parseCandidate(root, isDetail ? 'deep' : 'quick', clicked && Date.now() - clicked.at < 120000 ? clicked.input : undefined);
      if (!input) { const old = cards.get(root); old?.host.remove(); cards.delete(root); seen.delete(root); continue; }
      const key = appKey(input), signature = JSON.stringify([key, input.rawText, input.stage, input.avatarUrl]);
      let item = cards.get(root);
      if (!item || !item.host.isConnected || item.key !== key) {
        item?.host.remove(); const host = document.createElement('div'); host.setAttribute('data-shicai', 'candidate'); host.attachShadow({ mode: 'open' }); root.append(host);
        if (!isDetail && location.pathname.includes('/web/chat/')) {
          if (getComputedStyle(root).position === 'static') (root as HTMLElement).style.position = 'relative';
          Object.assign(host.style, { position: 'absolute', right: '6px', bottom: '3px', maxWidth: '60%', zIndex: '1' });
        }
        item = { input, key, signature, host }; cards.set(root, item);
      }
      item.input = input; item.key = key;
      if (seen.get(root) !== signature) { inputs.push(input); seen.set(root, signature); }
    }
    for (let i = 0; i < inputs.length; i += 50) await rpc('SCAN', { inputs: inputs.slice(i, i + 50) });
    const profileRoot = findChatProfileRoot(document);
    const matched = profileRoot && matchChatProfile(profileRoot, [...cards.entries()].filter(([el]) => el.isConnected).map(([, c]) => c.input));
    const currentKey = matched ? appKey(matched.input) : '';
    if (profileKey !== currentKey) { resumeIdentity.select(currentKey); profileKey = currentKey; ocrError = ''; ocrPreview = ''; ocrPreviewOpen = false; }
    if (!matched) profileSnapshot = undefined;
    else {
      const signature = JSON.stringify([appKey(matched.input), matched.profile]);
      if (signature !== profileSnapshot?.signature) profileSnapshot = { signature, since: Date.now(), saved: false };
      // 聊天切换时资料异步更新；连续两次以上一致后才补到候选人记录。
      if (Date.now() - profileSnapshot.since < 600) schedule();
      else if (!profileSnapshot.saved) {
        await rpc('CHAT_PROFILE', matched); profileSnapshot.saved = true; await refresh();
      }
    }
    if (inputs.length) await refresh();
    const resume = await readOnlineResume(document, matched ? { ...matched.input, observedJobName: matched.profile.jobName } : undefined);
    const currentCandidate = summary?.candidates.find(c => c.key === currentKey);
    resumeHint = ocrFlight ? readProgress || '正在准备完整读取简历…' : summary?.candidates.find(c => c.key === currentKey)?.hasResume ? `在线简历已读取，${summary?.candidates.find(c => c.key === currentKey)?.queueStatus?.label || '正在核对队列状态'}` : ocrError || (currentCandidate?.resumeReadStatus === 'insufficient' ? '简历内容不足，已跳过；可点击读取当前简历重新核对。' : '') || (resume?.status === 'image' ? '图片简历已打开，准备本机识别正文。'
      : resume?.status === 'unmatched' ? '在线简历身份尚未核对，暂不进入分析。'
      : resume?.status === 'unavailable' ? '在线简历正文尚未读到，暂不进入分析。' : '');
    if (resume && matched && !ocrFlight && !batch.running && !ocrError && !currentCandidate?.hasResume && currentCandidate?.resumeReadStatus !== 'insufficient') void readCurrentResume().catch(() => {});
    if (resume && resume.status !== 'text' && matched) {
      const signature = JSON.stringify([appKey(matched.input), resume.status]);
      if (signature !== resumeStatusSignature) { await rpc('RESUME_STATUS', { input: matched.input, status: resume.status }); resumeStatusSignature = signature; await refresh(); }
    } else resumeStatusSignature = '';
    toolbarView(resumeHint);
    paint();
  } catch (e) { for (const root of cards.keys()) seen.delete(root); toolbarView(e instanceof Error ? e.message : '页面读取失败'); }
  finally { busy = false; if (dirty) { dirty = false; schedule(); } }
}
let scanTimer: ReturnType<typeof setTimeout>;
function schedule() { clearTimeout(scanTimer); scanTimer = setTimeout(() => void scan(), 300); }
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const previously = summary?.scanEnabled;
    summary = await rpc<Summary>('SUMMARY', { keys: [...cards.values()].map(c => c.key) });
    toolbarView(resumeHint); paint();
    if (summary.scanEnabled && (!previously || document.querySelector('iframe'))) schedule();
    if (!summary.scanEnabled) { cards.forEach(c => c.host.remove()); cards.clear(); }
  } catch (e) { toolbarView(e instanceof Error ? e.message : '扩展连接失败'); }
  finally { refreshing = false; }
}
const observer = new MutationObserver(records => {
  if (records.some(r => !(r.target instanceof Element && r.target.closest('[data-shicai]')) && !(r.type === 'childList' && [...r.addedNodes,...r.removedNodes].every(n => n instanceof Element && n.hasAttribute('data-shicai'))))) schedule();
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-geek-id', 'data-candidate-id', 'data-job-id', 'class', 'hidden', 'aria-hidden', 'src', 'srcset'] });
document.addEventListener('click', event => {
  if (!(event.target instanceof Element) || event.target.closest('[data-shicai]')) return;
  const link = event.target.closest('a, button, [role="button"]');
  if (link && visibleText(link).trim() === '在线简历') {
    const matched = currentProfile();
    resumeIdentity.clear();
    if (matched && !onlineResumeFrame(document)) resumeIdentity.open(appKey(matched.input));
    ocrAttempt = ''; ocrError = '';
  }
  const root = event.target.closest(CARD_SELECTOR), item = root && cards.get(root);
  if (item) { resumeIdentity.clear(); if (event.isTrusted) clicked = { input: item.input, at: Date.now() }; }
}, true);
let scrollTimer: ReturnType<typeof setTimeout>;
document.addEventListener('scroll', () => {
  clearTimeout(scrollTimer); scrollTimer = setTimeout(() => {
    const keys = [...cards.entries()].filter(([el]) => { const r = el.getBoundingClientRect(); return r.bottom >= 0 && r.top <= innerHeight; }).map(([, c]) => c.key);
    if (summary?.scanEnabled && keys.length) void rpc('PRIORITY', { keys }).catch(() => {});
    schedule();
  }, 250);
}, { capture: true, passive: true });
toolbarView(); void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
