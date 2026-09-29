type Opening = { key: string; frame?: HTMLIFrameElement; document?: Document | null };

// 从“在线简历”入口记录归属；OCR 只负责正文，不负责辨认姓名。
export class ResumeIdentity {
  private opening?: Opening;
  open(key: string) { this.opening = { key }; }
  clear() { this.opening = undefined; }
  select(key: string) { if (this.opening?.key !== key) this.clear(); }
  bind(key: string, frame: HTMLIFrameElement) {
    const opening = this.opening;
    if (!opening || opening.key !== key) return;
    if (opening.frame && (opening.frame !== frame || opening.document !== frame.contentDocument)) return;
    opening.frame = frame; opening.document = frame.contentDocument;
    return opening;
  }
  matches(binding: Opening | undefined, key: string, frame: HTMLIFrameElement | undefined): boolean {
    return !!binding && binding === this.opening && binding.key === key && !!frame
      && binding.frame === frame && binding.document === frame.contentDocument;
  }
}
