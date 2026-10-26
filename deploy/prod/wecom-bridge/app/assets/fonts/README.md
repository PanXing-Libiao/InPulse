# 海报字体资产

本目录只保存项目封箱海报使用的开源字体，供 Windows 本地桥接与 Linux 容器加载同一组字形，避免微软雅黑、黑体或 Arial 等专有字体的许可风险。

| 文件 | 用途 | 来源 |
| --- | --- | --- |
| `NotoSansSC-Regular.ttf` | 正文与常规标签 | Google Fonts Noto Sans SC v41，2026-10-20 下载 |
| `NotoSansSC-Black.ttf` | 标题、数字与强调 | Google Fonts Noto Sans SC v41，2026-10-20 下载 |
| `OFL.txt` | 字体许可 | SIL Open Font License 1.1 |

字体来源页：https://fonts.google.com/noto/specimen/Noto+Sans+SC

修改字体时必须继续使用允许商用和嵌入的 OFL 字体，并同步更新 `OFL.txt`；不要把 `C:/Windows/Fonts` 下的系统字体复制进仓库或运行镜像。`wrap-poster.mjs` 在找不到可用字体时会拒绝渲染，桥接按既有降级路径只发送文字。
