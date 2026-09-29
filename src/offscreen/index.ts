import { createWorker, type Worker } from 'tesseract.js';
let worker: Promise<Worker> | undefined;
let queue: Promise<unknown> = Promise.resolve();
function getWorker() {
  return worker ||= createWorker('chi_sim+eng', 1, {
    workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
    corePath: chrome.runtime.getURL('ocr/core/'),
    langPath: chrome.runtime.getURL('ocr/lang/'),
    workerBlobURL: false, gzip: true,
    logger: () => { void chrome.runtime.sendMessage({ target: 'ocr-progress' }).catch(() => {}); }
  }).catch(e => { worker = undefined; throw e; });
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'ocr-worker' || sender.id !== chrome.runtime.id) return false;
  const task = queue.then(async () => {
    const w = await getWorker();
    const { data } = await w.recognize(message.image);
    return { text: data.text, confidence: data.confidence };
  });
  queue = task.catch(() => {});
  void task.then(data => respond({ ok: true, data })).catch(() => respond({ ok: false, error: '本机文字识别失败，请重试当前简历' }));
  return true;
});
