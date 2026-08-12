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

## 模板系统

生成逻辑由**模板描述符（template descriptor）**驱动：每个模板一份 `template.json`，声明画布、角色化色板、字体档位、装饰构件、页面家族（family + variant）、组件、类型映射与字数约束。描述符 + 内容经 Layout Resolver 解析为 **Resolved Scene Graph**（与模板无关的最终场景），后端导出（pptxgenjs）与前端预览（DOM）只是两个"画家"，从机制上保证预览 = 导出。

- 详细设计见 `docs/template-system-design.md`
- **预设模板**：`classic-blue`（经典蓝）、`warm-retro`（复古蓝米，插画素材仅供本机使用，不可再分发）
- **上传模板**：在模板画廊点「+ 上传模板」选一份 .pptx，系统自动提取主题色、字体、字号档位、背景插画、页脚等，生成描述符草稿；确认面板展示样例预览与低置信度项，保存后即可用于生成
- 预设模板在 `templates/<id>/`，上传模板存 `~/.king-ppt/templates/<id>/`（含 `source.pptx` 原件，供重新提取）
- LLM 只输出结构化 JSON（8 种内容类型不变），模板差异全部由渲染层吸收

### 自由排版页（free）

除 8 种结构化类型外，LLM 每页还可以选择输出第 9 类 `"free"`：直接产出固定 1280×720 画布的 HTML 片段，用于核心卖点、重磅数字等重点页的视觉发挥（每份演示硬性要求 1~3 页，harness 会指定内容页正中一页作为重点展示页）。大风格一致性由 prompt 注入的模板风格令牌（色板/字体/基调）保证。

- **预览**：sandbox iframe + 文档级 zoom 等比缩放（`public/html-frame.js`，字符串级 sanitize 剔除脚本/外链）
- **导出**：本机 Chrome/Edge headless 截图成 2x PNG，整页图片嵌入 PPTX（**该页不可编辑**，结构化页保持矢量可编辑）；未检测到浏览器时设置 `KING_PPT_CHROME` 指向可执行文件
- `html-frame.js` 的 `sanitize/wrap` 前后端共用，保证预览 = 导出
- free 页不经 Layout Resolver；html 缺失/损坏时走「反馈重试 → 结构化兜底页」自愈阶梯

## 原理

- LLM 只输出结构化 JSON（大纲 / 幻灯片 schema），不直接排版
- 版式收敛为 8 种固定组件：`title`（封面）、`section`（章节页）、`bullets`（要点页）、`twoColumn`（两栏对比）、`table`（数据表格）、`steps`（流程步骤）、`quote`（金句页）、`stats`（关键数字）
- 前端将场景图渲染为 HTML 预览；后端用 PptxGenJS 将同一份场景图转成 .pptx

## 目录结构

```
bin/cli.js         # 启动入口：拉起服务 + 自动开浏览器
src/server.js      # Express 路由（/api/outline、/api/slides(SSE)、/api/revise、/api/export、/api/templates(+extract)、/api/providers、/api/instances、/api/active）
src/agent.js       # Prompt 与 JSON 解析（大纲 / 单页 / 局部修改，注入模板字数约束）
src/descriptor.js  # 模板描述符加载与枚举（templates/ + ~/.king-ppt/templates/，schemaVersion 校验）
src/layout-resolver.js # 描述符 + 内容 → Resolved Scene Graph（唯一设计决策者）
src/pptx-painter.js    # Scene Graph → pptxgenjs（纯绘制；free 页整页图片满铺）
src/pptx.js        # buildPptx 薄入口（free 页经 renderFree 钩子栅格化）
src/html-shot.js   # free 页 HTML → PNG（本机 Chrome/Edge headless 截图）
src/extract.js     # 上传 pptx → 描述符草稿（Stage 0 对象图 + 三层提取 + 安全限制）
src/llm.js         # 薄封装：保持旧接口，内部走 llmprovider
src/llmprovider.js # 多供应商抽象：实例/模型管理、能力路由、OpenAI 兼容 / Gemini 适配器、异步任务轮询器
src/config.js      # 配置持久化（~/.king-ppt/config.json）
templates/         # 预设模板（template.json + assets/）
public/            # 前端单页 + dom-painter.js + html-frame.js（无构建步骤）
docs/              # 设计文档
```

## 环境变量（向后兼容，可选）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | 否 | — | 未在页面配置时的 chat 兜底 key |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | chat 兜底端点 |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | chat 兜底模型 |
| `PORT` | 否 | `3210` | 服务端口 |
