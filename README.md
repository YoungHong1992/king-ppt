# 卷王PPT (KingPPT)

本地运行的 AI PPT 生成工具：在网页上对话生成大纲与幻灯片，实时预览，一键导出**可编辑的 .pptx**。别人熬夜做的，没你十分钟做的好。

## 快速开始

```bash
npm install

# 配置 OpenAI 兼容的大模型服务（任一方式）
export OPENAI_API_KEY=sk-...                 # 必填（也可启动后在页面右上角填写）
export OPENAI_BASE_URL=https://api.openai.com/v1   # 可选，默认值即此
export OPENAI_MODEL=gpt-4o-mini              # 可选

npm start    # 启动并自动打开浏览器，默认 http://localhost:3210
```

自定义端口：`npm start -- --port=4000`

## 使用流程

1. 在左侧输入主题（可粘贴材料），选择页数，发送
2. 查看/重新生成大纲，满意后点「确认大纲，生成幻灯片」
3. 右侧 16:9 预览区逐页流式出现幻灯片
4. 继续输入自然语言修改指令（如「把第 3 页要点精简一半」）
5. 点击右上角「导出 PPTX」下载文件，可在 PowerPoint / WPS 中继续编辑

## 原理

- LLM 只输出结构化 JSON（大纲 / 幻灯片 schema），不直接排版
- 版式收敛为 4 种固定组件：`title`（封面）、`section`（章节页）、`bullets`（要点页）、`twoColumn`（两栏对比）
- 前端将 JSON 渲染为 HTML 预览；后端用 PptxGenJS 将同一份 JSON 转成 .pptx

## 目录结构

```
bin/cli.js      # 启动入口：拉起服务 + 自动开浏览器
src/server.js   # Express 路由（/api/outline、/api/slides(SSE)、/api/revise、/api/export、/api/config）
src/agent.js    # Prompt 与 JSON 解析（大纲 / 单页 / 局部修改）
src/llm.js      # OpenAI 兼容 chat 客户端（内置 fetch）
src/pptx.js     # slides JSON → .pptx（16:9，统一主题）
public/         # 前端单页（无构建步骤）
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | 是* | — | 也可在页面右上角临时填写（仅存内存） |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | 模型名 |
| `PORT` | 否 | `3210` | 服务端口 |
