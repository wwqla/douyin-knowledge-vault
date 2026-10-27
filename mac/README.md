# 抖音知识库 · macOS 版

把你的抖音收藏自动变成本地 Obsidian 知识库：扫码登录 → 批量读取收藏 → 下载音频 → **本机** Whisper 转写 → AI 提炼要点 → 按「收藏夹 / 父类 / 子类」写成 Markdown 笔记。界面沿用 Windows 版（皮肤、知识库浏览、知识图谱、知识卡片、周报、全文检索、AI 问答）。

> 预览版，仅支持 **Apple 芯片（M1/M2/M3/M4）Mac**，macOS 12 及以上。

## 安装

1. 到 [Releases](https://github.com/wwqla/douyin-knowledge-vault/releases) 下载最新的 `DouyinKnowledgeVault-x.y.z-mac-arm64.dmg`。
2. 双击打开 DMG，把「抖音知识库」拖到「应用程序」文件夹。
3. 第一次打开：应用没有经过 Apple 公证，会提示“无法验证开发者”。点「完成」，然后打开 **系统设置 › 隐私与安全性**，在页面底部找到「抖音知识库」，点 **仍要打开**，再输入开机密码确认。以后就能正常双击打开了。

## 第一次使用

全程在应用里点按钮完成，**不需要打开终端，也不需要安装 Homebrew**。

1. **安装处理组件**：首次启动会弹出「安装处理组件」，点「一键安装」。应用会自动下载 Python 运行环境、视频下载工具和本地语音识别组件（装在 `~/Library/Application Support/DouyinKnowledgeVault`），约 3~10 分钟，进度和失败原因都显示在窗口里。也可以随时在 **设置 › 处理组件** 里安装或修复。
2. **下载语音识别模型**：组件装好后点「下载语音识别模型」（Whisper large-v3-turbo，约 1.6 GB，只需一次；连不上 Hugging Face 时自动改用国内镜像）。转写完全在本机进行，音频不会上传。
3. **填写 API Key**：在 **设置 › AI 接口配置** 填 Base URL、API Key 和模型名（DeepSeek、Kimi、通义、OpenAI 等任意 OpenAI 兼容接口均可，例如 `https://api.deepseek.com/v1` + `deepseek-chat`），点「测试连接」，再点右上角「确认修改 · 应用全部设置」。Key 只保存在本机。
4. **扫码登录抖音**：在 **设置 › 抖音账号** 点「打开抖音扫码登录」，用抖音 App 扫码，登录成功后窗口自动关闭。登录状态只保存在本机，失效后重新扫码即可。
5. **选择知识库文件夹**（可选）：默认是 `~/文稿/抖音知识库`，可以在 **设置 › 项目配置** 点「选择…」换成你现有的 Obsidian 库。笔记写在其中的 `Knowledge/` 目录。
6. 回到 **总览**，选择「全部收藏」或「指定收藏夹」，点 **开始处理收藏**。

## 常用功能

- **处理范围**：设置里可选按时间（视频发布日期在起始日期之后）、按数量（最近 N 条快照）或全部；每次手动处理的条数上限也可调。已处理过的视频会自动跳过，失败的会在 30 秒后自动重试一次，之后的运行中最多再试 3 次。
- **暂停 / 继续**：流水线页可随时暂停（当前视频处理完再停），可设置电脑空闲 N 分钟后自动继续；残留的同步锁可一键复位。
- **新增收藏**：粘贴抖音分享链接或文案，加入待处理或立即处理。
- **定时同步**：设置 › 定时任务 选择时间和频率（每天或每周某天），应用会写入 `~/Library/LaunchAgents/com.douyin.knowledge.sync.plist`，到点在后台读取新收藏并处理，完成后发系统通知。需要先把应用放进「应用程序」文件夹；Mac 睡眠时错过的任务会在唤醒后补跑。
- **知识卡片 / 周报小结 / AI 问答**：直接调用你填写的 AI 接口。AI 问答选择一个知识库大类，AI 基于该类笔记回答。

## 与 Windows 版的差异

- **知识蒸馏（仓颉七阶段引擎）Mac 版暂未提供**，相关入口会显示“Mac 版暂未提供”。「我的技能」页同理。
- 收藏采集改为应用内置的抖音网页登录窗口完成，不再需要 Playwright / Chrome。
- 处理引擎来自 [FavVault](https://github.com/wwqla/fav-vault-mac) 的 Python worker（yt-dlp + mlx-whisper + OpenAI 兼容接口）。

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 设置、处理记录、知识卡片 | `~/Library/Application Support/DouyinKnowledgeVault/` |
| 处理组件、临时音频 | `~/Library/Application Support/DouyinKnowledgeVault/engine/` |
| 语音识别模型 | `~/.cache/huggingface/` |
| 笔记 | 你选择的知识库文件夹 `/Knowledge/` |
| 定时任务 | `~/Library/LaunchAgents/com.douyin.knowledge.sync.plist` |

卸载：删除应用，再删除上表中的文件夹即可（先在设置里停用定时任务）。

## 开发

```bash
cd mac
npm install
npm start          # 开发运行
npm run check      # 语法检查
npm test           # 单元测试（采集映射、Cookie 导出、launchd、状态、知识库）
npm run dist       # 打包 DMG（需在 macOS 上）
```

推送 `mac-v*` 标签会由 GitHub Actions（`.github/workflows/mac-release.yml`）在 macOS 上打包并发布到 Releases。
