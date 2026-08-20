# 卷王PPT · 工作进展与架构决策备忘

> 更新时间：2026-08-19
> 记录人：开发协作（yanghong + Agent）

---

## 一、本轮已完成的工作：阶段1「内容大纲确认」

在原有「出片阶段（SVG→pptx）」之前，新增了一个标准化的**内容确认阶段**，同一 studio 顶部切阶段。

### 标准化流程（改造后）

- **阶段0 · 素材**：用户口述/粘贴、把文件放进 `./inputs/` 目录、或 Agent 联网调研；网页也支持拖拽上传（→ `material-added` 动作通知 Agent 去读）。
- **阶段1 · 大纲确认**：Agent 消化素材 → 产出结构化 Markdown 内容底稿 → `push-outline` 推到网页 → 用户**划词批注** → 攒一批发回 → Agent 改稿重推 → 循环到**定稿**。定稿的 Markdown 成为冻结的内容基线。
- **阶段2 · 出片**：现有 SVG-as-IR 流程，消费定稿大纲。**本次未改动，`preview==export` 契约不受影响。**

### 落地的文件

**新增**
- `src/normalize-outline.js` — 大纲归一 + Markdown 清洗（复用 svg-sanitize.removeTag）+ 批注校验（剔除失效 quote，永不抛错）
- `src/materials.js` — 素材存储（保留原名、目录穿越防护）
- `web/src/md.js` — 零依赖 Markdown 渲染器，每块带 `data-block` 锚点、全文 HTML 转义防 XSS
- `web/src/components/OutlineView.jsx` — 文档渲染 + 划词批注气泡 + 高亮
- `web/src/components/OutlineBatchPanel.jsx` — 右栏待发送批注列表 + 发送/定稿

**修改**：`src/paths.js`（MATERIALS_DIR）、`src/relay.js`（doc 镜像 + SSE 广播）、`src/server.js`（/api/agent/outline、/api/materials、批注清洗分支、SSE 回放 doc、/api/agent/doc）、`bin/cli.js`（push-outline 命令）、`web/src/api.js`（onDoc + uploadMaterial）、`web/src/App.jsx`（阶段切换 + 数据流）、`web/src/styles.css`、`SKILL.md`（3 段式流程文档）

**构建**：`npm run build` 重新生成 `public/`（装了 devDependencies：vite 等 61 个包；`package-lock.json` 可能有变动）

### 批注交互的迭代（按用户反馈）

1. 标注样式从「四边框」改为**下划线 + 浅底色**，单条线、不叠加（重叠选区拦截提示）
2. **双向高亮联动**：点文稿标注 → 右栏条目高亮；点右栏条目 → 文稿标注高亮并滚动到位；删除联动
3. **跨行标注**：`surroundContents` 跨元素会抛错 → 改为**逐文本节点上色**（收集选区相交的所有 text node 各包一个同 `data-cid` 的 span），跨 `<br>`/`<li>`/加粗都能画出连续标注

### 端到端验证（全绿）

push-outline、SSE 回放、批注往返（失效引用剔除）、定稿、素材上传落盘、出片阶段不受影响、构建产物含新代码 —— 均通过。

> ⚠️ 验证踩坑：**Git Bash 的 `curl -d` 会把内联中文 UTF-8 搞坏**，导致 `includes(乱码)` 失败误判为 bug。改用 node `fetch`（与浏览器一致）后正常。中文项目测试勿用 curl 内联中文。

---

## 二、暴露的核心问题：批注「石沉大海」

**现象**：用户在网页点「发送批注」，Agent 侧感觉没收到。

**诊断结论（已确认，非 bug）**：链路分三段——
1. 浏览器 → 服务端动作队列：✅ 正常，批注确实入队
2. 服务端队列 → Agent：⚠️ **断点**。队列里的动作**只有 Agent 主动调 `next` 长轮询才会被取走**
3. Agent 收到 → 响应改稿：未发生

**根因**：回合制乒乓协议（push → next 阻塞等 → 反应 → 再 push）与**真人异步操作**错配。Agent 改完代码就把控制权交回用户、没挂在 `next` 上守着；人不会掐点在 `next` 窗口内操作。

---

## 三、架构岔路讨论：是否恢复「LLM provider + Agent Loop」

### 关键澄清：两件事可分离

- **Agent Loop**（谁编排、谁守队列响应批注）= 控制流
- **LLM provider**（谁生成文字/大纲）= 内容智能来源

**可只恢复其一。** 这是决策核心。

### 历史事实（git 考据）

- 提交 `44e8904`「改造为 Agent 驱动的 Skill」删除约 1050 行：`llmprovider.js`(711行, 11家供应商: OpenAI/硅基/Kimi/DeepSeek/智谱/通义/豆包/MiniMax/Gemini/Ollama/自定义)、`agent.js`(278行, 自愈生成循环)、`config.js`、provider 路由 + 前端设置 UI。
- 当年的 `agent.js` 生成的是**旧的 8 类版式 type**（title/bullets/table…），**不是**现在的整页 SVG。SVG-as-IR 是之后 `ca65609` 才重建的。
- **含义：恢复 = 重写，不是搬运**（生成逻辑要重新适配 SVG-as-IR）。

### 三条路线对比

| 路线 | 内容 | 评价 |
|---|---|---|
| **A. 恢复 LLM provider + 自愈 loop（回到最初）** | 搬回 1050 行，服务端自己当会调大模型的常驻 Agent | 彻底解决「没人接批注」、用户零门槛；但**成本重**（要重写生成逻辑适配 SVG）、**要用户配 API Key/余额/网络**（当初主动甩掉的债）、**与「调用方 Agent 才是大脑」的 Skill 定位正面冲突** |
| **B. 只让当前 Agent 守在 loop（不碰 LLM）** | Agent push 完持续挂 `next`，收批注即响应；网页加「待接收/已接收」状态 | **契合现有架构、零回归、内容质量是 Opus 级**；改动小；但**依赖调用方 Agent 在线**，对「纯人类、手边无 Agent」不友好 |
| **C. 混合：服务端常驻编排器（状态机，非 LLM）** | 服务端加轻量状态机守队列/管状态/给网页反馈；改稿仍委托调用方 Agent | 解决网页侧「石沉大海」体感；不引 provider、不违背定位；但没填补「Agent 不在线谁改稿」，只是把空窗显式化 |

### Agent 的看法（结论）

1. **不建议路线 A 恢复 LLM provider**：711 行是当初主动甩掉的技术债（密钥/余额/网络/11家适配）；旧 agent.js 不能复用需重写；与产品定位（调用方 Agent 是大脑）冲突。当前「Agent push 大纲 / 用户批注 / Agent 改」的协作本身就是定位的活证明，且内容质量优于让用户配便宜模型。
2. **自写 Agent Loop 值得做，但做的是 B/C 的编排层，不是 A 的 LLM 那一半**。把「常驻的是编排/状态机」与「生成内容的是 Agent」拆开：服务端可有自己的 loop（守队列、管状态、给网页反馈），但大模型能力不必回归。
3. **LLM provider 不必伴随恢复**：你要的是「有人守队列并反馈」，不是「服务端自己会调大模型」。守队列几十行状态机足够，不需要那 711 行。

### 待用户拍板的关键问题

**这个 skill 的主要使用场景是哪种？**
- **「人 + 调用方 Agent 协同」（如当前你我这样）** → 走**路线 B**（轻，推荐），别碰 provider。
- **「纯人类、独立开网页、无 Agent 在侧」** → 才需服务端自带生成能力，才考虑 A；即便如此也建议只集成**一个**默认 provider（而非恢复 11 家选择器 UI），把复杂度压到最低。

> **决策已定（2026-08-19）**：目标场景 = 纯人类、无 Agent → 走**路线 A**（服务端自带生成，单一 OpenAI 兼容 provider，用户自配 baseURL/key/model）。Milestone 1 已落地，见第五节。

---

## 四、当前运行状态

- 后台 server 在跑：`http://localhost:3210`（`KING_PPT_HOME=./.king-ppt`）
- 已推一份演示大纲《时间管理分享》在 doc 里（version=1）
- 未提交任何改动（含 `public/` 构建产物、可能变动的 `package-lock.json`）

---

## 五、Milestone 1 落地：服务端自带生成（阶段1）

> 2026-08-19 · 路线 A（单一 provider，用户自配）

**决策**：目标 = 纯人类无 Agent → 服务端内置生成。反转 `44e8904` 的「移除 LLM」，但**只集成一个 OpenAI 兼容 provider**（非当年 11 家选择器 UI），用户在设置面板自配 baseURL/key/model。

**本轮范围**：阶段1 大纲生成 + 批注改稿闭环。阶段2 整页 SVG 生成留作 Milestone 2（接口已预留）。

### 新增 / 改动
- **新增** `src/config.js`（单 provider 存储，落 `KING_PPT_HOME/config.json`，key 绝不回传明文）、`src/llm.js`（OpenAI 兼容客户端，移植自 `44e8904^` 的 `postJSON`/`probeCandidates`/`normalizeBaseURL`；`/v1` 缺失自愈）、`src/generate-outline.js`（`generateOutline`/`reviseOutline` + 模块级 in-flight 守卫）、`web/src/components/SettingsPanel.jsx`。
- **改** `src/paths.js`（+`CONFIG_FILE`）、`src/server.js`（+`GET/POST /api/config`、`POST /api/config/test`、`POST /api/generate/outline`；`statusOf` 扩错误码；body-size 判定加 `/api/generate/`）、`web/src/api.js`、`web/src/App.jsx`（设置齿轮 + 左栏 topic 生成框 + `onSendBatch` 按 `serverGen` 分支）、`web/src/styles.css`。

### 「石沉大海」的解法
「**有 key 即 server-gen 模式**」：批注走**直连路由** `POST /api/generate/outline`——HTTP 请求自身驱动 LLM 改稿并 `relay.setDoc`，**不依赖任何人轮询 `next`**，从根上消除石沉大海。既有 `/api/agent/*` 关系路径原样保留（双模式共存）。生成结果经**同一** `normalizeOutline`/`normalizeComments` + `relay.setDoc` 落库，`preview==export` 与 SSE 不变。

### 验证（20/20 全绿）
mock OpenAI 兼容服务驱动全链路：无 key 拒绝 → 配置（掩码 / 明文不外泄）→ `/v1` 自愈探测 → 生成大纲(v1) → 批注改稿(v2 内容变化) → 失效批注拒绝 → 并发守卫(200+409) → Agent 关系路径回归不受影响。构建产物含新 UI。

### 下一步（Milestone 2，未做）
`src/generate-slides.js`：`buildSpec` 上下文 + 定稿大纲 → 逐页 SVG（attempt→sanitize/validate→回灌失败原因→重试 ≤3→降级 + 首页门禁），`relay.setSlide` 逐页流式；失败页回退主题**角色原型页**（`spec.layouts`）而非纯空白。前端幻灯片空态加「生成幻灯片」。
