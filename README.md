# 卷王PPT (KingPPT)

**Agent 驱动的 PPT 生成 Skill**：任何 Agent（Claude Code 等）都能调用，起一个网页让人类挑模板、实时预览、就地编辑，导出**可编辑的 .pptx**。别人熬夜做的，没你十分钟做的好。

> **控制反转**：本项目**不含大模型**。今天不再是「服务器调 LLM 填引擎」，而是「**用户的 Agent 当内容源 + 编排者**」——Agent 写幻灯片 JSON，本 Skill 是确定性的排版引擎 + 网页工作台。引擎保证**预览 == 导出**。

## 作为 Skill 使用（推荐）

Agent 读 [`SKILL.md`](./SKILL.md) 即得完整创作契约与协作协议。核心闭环：

```
  用户 Agent ──push deck/slide──▶ 中继服务器 ──SSE──▶ 人类浏览器（实时预览）
       ▲                            (relay)                │
       └──────── next 长轮询 ◀──── 动作队列 ◀──── 挑模板 / 就地编辑 / 下指令
```

Agent 与人类**回合制**协作：Agent 先 push（人类立刻有东西看）→ 再 `next` 让位收人类动作 → 据动作重写 → 再 push，直到人类导出。这个「人类在环」的乒乓取代了任何自愈生成循环。

```bash
npm install
node bin/cli.js serve         # 后台任务方式起服务 + 开浏览器（默认 http://localhost:3210）
```

## CLI（Agent 的 shell-out 接口）

所有命令输出 JSON；经 `KING_PPT_HOME/server.json` 自动定位运行中的服务（或 `--port=N` / `KING_PPT_PORT`）。

| 命令 | 用途 |
| --- | --- |
| `serve [--port=N] [--no-open]` | 起工作台 + 开浏览器（**以后台任务运行**） |
| `stop` | 停止服务 |
| `templates` | 列出模板 |
| `spec <templateId>` | 某模板的创作规格（画布/字数约束/配色/free-SVG 规范/版式契约文本） |
| `push [deck.json]` | 推整册 `{title, templateId, slides[]}`（文件或 stdin）→ 浏览器实时预览 |
| `push-slide <index> [slide.json]` | 推单页（逐页流式体验） |
| `next [--timeout=ms]` | 长轮询下一个人类动作（阻塞；~25s 心跳） |
| `state` | 当前 deck 快照（重连/导出用） |
| `asset --file= \| --data= \| --url=` | 供图，返回 `slide.image` 载荷 |
| `export <out.pptx>` | 导出当前 deck 为 .pptx |

`next` 返回的人类动作：`generate`（生成整册）、`revise`（自然语言指令）、`edit`（就地编辑，服务器已权威落盘）、`regen`（重写某页）、`template-pick`（换模板）、`heartbeat`（超时空转，再 `next`）。详见 `SKILL.md`。

## 人类在浏览器上的使用流程

1. 挑选模板风格（画廊卡片实时预览）
2. 看 Agent 逐页推来的幻灯片在 16:9 预览区实时出现
3. 就地点选文字修改；或在输入框对 Agent 下自然语言指令
4. 满意后点「导出 PPTX」，可在 PowerPoint / WPS 继续编辑
5. 也可上传一份 .pptx，系统提取为可复用模板

## 模板系统（确定性引擎 —— 零 LLM 耦合）

生成逻辑由**模板描述符**驱动：每个模板一份 `template.json`，声明画布、角色化色板、字体档位、装饰构件、页面家族（family + variant）、组件、类型映射与字数约束。描述符 + 内容经 **Layout Resolver** 解析为 **Resolved Scene Graph**（与模板无关的最终场景），后端导出（pptxgenjs）与前端预览（DOM）只是两个「画家」，从机制上保证**预览 = 导出**。

- 详细设计见 [`docs/template-system-design.md`](./docs/template-system-design.md)
- **预设模板**：`classic-blue`（经典蓝）、`warm-retro`（复古蓝米，插画素材仅供本机使用，不可再分发）
- **上传模板**：浏览器里选一份 .pptx，系统自动提取主题色、字体、字号档位、背景插画、页脚等生成描述符草稿；确认后即可用于生成
- 预设模板在 `templates/<id>/`，上传模板存 `KING_PPT_HOME/templates/<id>/`（含 `source.pptx` 原件，供重新提取）
- Agent 只输出结构化 JSON（8 种内容类型），模板差异全部由渲染层吸收

### 8 类结构化版式 + 自由排版页

- 版式收敛为 8 种固定类型：`title`（封面）、`section`（章节页）、`bullets`（要点页）、`twoColumn`（两栏对比）、`table`（数据表格）、`steps`（流程步骤）、`quote`（金句页）、`stats`（关键数字）
- **位置契约**：第 1 页必为 `title`，末页必为 `section`
- 第 9 类 `"free"` 自由排版页：Agent 直接产出 1280×720 的 **SVG**，导出为**原生可编辑矢量**（无需 Chrome）。用于核心卖点/重磅数字等重点页，每份 1~3 页。风格一致性由 `spec` 返回的模板色板约束。
  - 预览：`public/svg-frame.js`；导出：`src/svg-to-pptx.js`（同源规范，保证预览 = 导出）
  - 旧的 `{type:"free", html}`（原始 HTML）路径仍在，但导出需本机 Chrome/Edge 栅格化（设 `KING_PPT_CHROME` 指向可执行文件）；**优先用 `svg`**

## 目录结构

```
SKILL.md               # Agent 创作契约 + 协作协议（Skill 入口）
bin/cli.js             # CLI 分发器：serve/stop/templates/spec/push/push-slide/next/state/asset/export
src/server.js          # 中继服务器：deck 存储 + SSE 事件总线 + 动作队列 + 保留路由
src/relay.js           # Agent ↔ 浏览器 有状态中继（单页粒度写入 + 单调 version）
src/normalize.js       # 幻灯片 JSON 归一（从旧 agent.js 迁出的纯函数，无 LLM、无重试循环）
src/spec.js            # 模板创作规格（/spec 路由 + 写进 SKILL.md 的契约文本）
src/paths.js           # 可移植数据根目录（KING_PPT_HOME，默认 ~/.king-ppt）
src/descriptor.js      # 模板描述符加载与枚举（templates/ + KING_PPT_HOME/templates/）
src/layout-resolver.js # 描述符 + 内容 → Resolved Scene Graph（唯一设计决策者）
src/pptx-painter.js    # Scene Graph → pptxgenjs（纯绘制）
src/svg-to-pptx.js     # free 页 SVG → 原生可编辑 pptx 形状
src/pptx.js            # buildPptx 薄入口
src/html-shot.js       # 旧版 free HTML → PNG（本机 Chrome/Edge headless，跨平台探测）
src/extract.js         # 上传 pptx → 描述符草稿
src/sessions.js/assets.js # 会话持久化 / 配图存储（均落 KING_PPT_HOME）
templates/             # 预设模板（template.json + assets/）
public/                # 前端单页 + dom-painter/svg-frame/html-frame（无构建步骤）
docs/                  # 设计文档
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `KING_PPT_HOME` | 否 | `~/.king-ppt` | 数据根目录（会话/配图/上传模板/运行时文件）。Skill 场景可指向工作区。 |
| `PORT` | 否 | `3210` | 服务端口 |
| `KING_PPT_PORT` | 否 | — | CLI 定位服务端口的覆盖项 |
| `KING_PPT_CHROME` | 否 | — | 旧版 free-HTML 页导出所需的 Chrome/Edge 可执行文件路径 |
| `OPENAI_API_KEY` | 否 | — | **内置生成（可选）**的 env 回退 Key；设置面板（⚙）配置优先。配了 Key 才启用「server-gen 模式」，让纯人类用户无需 Agent 也能生成/改稿阶段1 大纲 |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | 内置生成的 OpenAI 兼容端点（env 回退；缺 `/v1` 会自动探测补全） |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | 内置生成的模型名（env 回退） |

要求 Node ≥ 18（使用全局 `fetch`）。
