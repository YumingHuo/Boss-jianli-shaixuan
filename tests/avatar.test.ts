// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { avatarMarkup, bindAvatarFallbacks } from '../src/ui/avatar';
import { safeAvatarUrl } from '../src/core/utils';
describe('候选人头像展示', () => {
  it('只接受 BOSS 图片域名的 HTTPS 地址，拒绝伪装域名和脚本地址', () => {
    for (const url of ['javascript:alert(1)','https://bosszhipin.com.example/avatar.jpg','https://user:pass@img.bosszhipin.com/a.jpg','http://img.bosszhipin.com/a.jpg']) expect(safeAvatarUrl(url)).toBe('');
    expect(safeAvatarUrl('https://img.bosszhipin.com/a.jpg')).toContain('/a.jpg');
    expect(avatarMarkup('<同学>','javascript:alert(1)')).not.toContain('<img');
  });
  it('图片加载失败回退姓名首字，不出现损坏图标', () => {
    document.body.innerHTML=avatarMarkup('测试同学','https://img.bosszhipin.com/a.jpg');
    const img=document.querySelector('img')!;
    Object.defineProperty(img,'complete',{value:false}); bindAvatarFallbacks(document.body);
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer'); img.dispatchEvent(new Event('error'));
    expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('.avatar')?.textContent).toBe('测');
  });
});
