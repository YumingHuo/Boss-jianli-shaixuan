# 本地文字识别资源

- 引擎：Tesseract.js 7.0.0，通过 npm 安装，Apache-2.0。
- 词库：Tesseract 官方 tessdata_fast，中文 chi_sim 与英文 eng，安装时下载并以 gzip 保存。
- 来源：https://github.com/tesseract-ocr/tessdata_fast
- 词库许可证：Apache-2.0，完整文本见本目录 [LICENSE](LICENSE)。
- 运行时使用扩展内置 worker、WASM 和词库，不从 CDN 加载代码，不上传简历图片。
- 文字识别置信度不等于实际准确率；姓名必须与当前聊天一致，章节及正文必须满足简历检查，未通过则停止。
