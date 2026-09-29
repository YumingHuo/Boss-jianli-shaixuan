import { scoreCandidate } from '../core/scorer';

// 仅在请求进行期间调用扩展 API，避免等待长响应时后台因空闲被回收。
export const scoreInBackground: typeof scoreCandidate = async (...args) => {
  const signal = args[3];
  const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  const stop = () => clearInterval(keepAlive);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try { return await scoreCandidate(...args); }
  finally { stop(); signal.removeEventListener('abort', stop); }
};
