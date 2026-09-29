export const isPreview = typeof chrome === 'undefined' || !chrome.runtime?.id;
export async function request<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (isPreview) return (await import('./demo')).demoRequest(type, payload) as Promise<T>;
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '后台未响应，请重新加载扩展'); return response.data;
}
