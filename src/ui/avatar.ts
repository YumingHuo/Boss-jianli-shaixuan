import { escapeHtml as h, safeAvatarUrl } from '../core/utils';
export function avatarMarkup(name: string, url?: string): string {
  const src = safeAvatarUrl(url);
  return `<div class="avatar candidate-avatar" title="${src ? h(name) + '的头像' : '尚未读取头像，请刷新 BOSS 并浏览此人的列表卡片'}"><span>${h(name.slice(0, 1))}</span>${src ? `<img src="${h(src)}" alt="${h(name)}的头像" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
export function bindAvatarFallbacks(root: Element) {
  root.querySelectorAll<HTMLImageElement>('.candidate-avatar img').forEach(img => {
    const fallback = () => { if (img.parentElement) img.parentElement.title = '头像加载失败，请在 BOSS 列表重新读取'; img.remove(); };
    img.addEventListener('error', fallback, { once: true });
    if (img.complete && !img.naturalWidth) fallback();
  });
}
