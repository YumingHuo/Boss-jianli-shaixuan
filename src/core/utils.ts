export const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export async function hash(s: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
export const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const appKey = (c: { id: string; bossJobId: string; bossJobName: string }) => JSON.stringify([c.id, c.bossJobId || normalize(c.bossJobName)]);
export function safeBossUrl(value: string): string {
  try { const u = new URL(value); return u.origin === 'https://www.zhipin.com' ? u.origin + u.pathname : ''; } catch { return ''; }
}
export function safeAvatarUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 3000) return '';
  try {
    const url = new URL(value);
    const allowed = ['zhipin.com', 'bosszhipin.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
    return url.protocol === 'https:' && !url.username && !url.password && allowed ? url.href : '';
  } catch { return ''; }
}
export function endpointOrigin(endpoint: string): string {
  const u = new URL(endpoint);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('接口必须是无账号、查询参数的 HTTPS 地址');
  return u.origin + '/*';
}
export function normalizeChatEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  endpointOrigin(value);
  const url = new URL(value);
  if (url.pathname === '/') url.pathname = '/v1/chat/completions';
  else if (url.pathname.replace(/\/$/, '') === '/v1') url.pathname = '/v1/chat/completions';
  return url.toString();
}
export function hasCompleteEndpoint(endpoint: string): boolean {
  try { const path = new URL(endpoint).pathname.replace(/\/$/, ''); endpointOrigin(endpoint); return !!path && path !== '/v1'; }
  catch { return false; }
}
