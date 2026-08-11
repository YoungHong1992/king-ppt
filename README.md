# 卷王PPT (KingPPT)

本地运行的 AI PPT 生成工具：在网页上对话生成大纲与幻灯片，实时预览，一键导出**可编辑的 .pptx**。别人熬夜做的，没你十分钟做的好。

## 快速开始

```bash
npm install
npm start    # 启动并自动打开浏览器，默认 http://localhost:3210
```

首次使用点击右上角 **⚙ 模型设置**，为「文本对话」选择供应商并填入 API Key 即可（也可继续使用环境变量方式，见下）。

自定义端口：`npm start -- --port=4000`

## 使用流程

1. 在左侧输入主题（可粘贴材料），选择页数，发送
2. 查看/重新生成大纲，满意后点「确认大纲，生成幻灯片」
3. 右侧 16:9 预览区逐页流式出现幻灯片
4. 继续输入自然语言修改指令（如「把第 3 页要点精简一半」）
5. 点击右上角「导出 PPTX」下载文件，可在 PowerPoint / WPS 中继续编辑

## LLM Provider 架构

模型接入按**能力**组织（`src/llmprovider.js`），每种能力可独立绑定不同的「供应商实例 · 模型」：

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| `chat` | 文本对话（大纲/幻灯片/修改） | ✅ 已实装 |
| `vision` | 多模态识图（看图生成 PPT） | ✅ 已实装（未配置时回退 chat 绑定） |
| `image` | 图像生成 | ✅ 已实装（OpenAI 兼容 `/images/generations`） |
| `video` | 视频生成 | 🔌 接口预留（异步任务轮询抽象 `runTask`） |
| `music` | 音乐生成 | 🔌 接口预留（异步任务轮询抽象 `runTask`） |

### 供应商实例 × 模型列表

- 供应商是**可添加多个的实例**：内置模板（OpenAI、Kimi、DeepSeek、智谱、通义、豆包、Gemini、Ollama）一键创建，中转站/私有网关用「自定义」填名称 + 地址 + Key
- 每个实例维护自己的**模型列表**：手动添加、或从 `/models` 接口一键拉取；每个模型用图标标记能力（👁 多模态 / 🖼 生图）
- 不同供应商的同名模型不会混淆：所有展示位统一 `供应商名 · 模型名`
- 实例可启停、可测试连接；删除实例会级联清理其默认绑定

配置保存在本机 `~/.king-ppt/config.json`（API Key 不会回传给前端，也不入库）。

### 扩展新能力/供应商

- 新增 OpenAI 兼容模板：在 `PROVIDER_TEMPLATES` 加一条记录即可。
- 实装视频/音乐生成：在对应适配器实现 `generateVideo(ctx, prompt, opts)` / `generateMusic(ctx, prompt, opts)`；异步任务可复用 `runTask({ submit, poll, isDone, extract })` 轮询器。

## 原理

- LLM 只输出结构化 JSON（大纲 / 幻灯片 schema），不直接排版
- 版式收敛为 4 种固定组件：`title`（封面）、`section`（章节页）、`bullets`（要点页）、`twoColumn`（两栏对比）
- 前端将 JSON 渲染为 HTML 预览；后端用 PptxGenJS 将同一份 JSON 转成 .pptx

## 目录结构

```
bin/cli.js         # 启动入口：拉起服务 + 自动开浏览器
src/server.js      # Express 路由（/api/outline、/api/slides(SSE)、/api/revise、/api/export、/api/providers、/api/instances、/api/active）
src/agent.js       # Prompt 与 JSON 解析（大纲 / 单页 / 局部修改）
src/llm.js         # 薄封装：保持旧接口，内部走 llmprovider
src/llmprovider.js # 多供应商抽象：实例/模型管理、能力路由、OpenAI 兼容 / Gemini 适配器、异步任务轮询器
src/config.js      # 配置持久化（~/.king-ppt/config.json）
src/pptx.js        # slides JSON → .pptx（16:9，统一主题）
public/            # 前端单页（无构建步骤）
```

## 环境变量（向后兼容，可选）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | 否 | — | 未在页面配置时的 chat 兜底 key |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | chat 兜底端点 |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | chat 兜底模型 |
| `PORT` | 否 | `3210` | 服务端口 |
