let creating: Promise<void> | undefined;
export async function recognizeImage(image: string): Promise<{ text: string; confidence: number }> {
  if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(image) || image.length > 40000000) throw new Error('简历图片格式无效或过大');
  const url = chrome.runtime.getURL('offscreen.html');
  if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] })).length) {
    creating ||= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS], justification: '在本机识别已打开的在线简历图片，不上传图片到第三方服务' }).finally(() => { creating = undefined; });
    await creating;
  }
  const result = await chrome.runtime.sendMessage({ target: 'ocr-worker', image });
  if (!result?.ok) throw new Error(result?.error || '本机文字识别尚未就绪');
  return result.data;
}
