# 卷王PPT 模板系统设计文档

> 版本：v1.1（对抗式评审修订版）
> 范围：模板描述符 schema、渲染架构、预设模板、上传自动提取、质量验证、实施计划
> v1.1 变更：融入外部评审的 8 项 P0 架构要求——元素语义角色、family+variant、候选布局、容量模型、Resolved Scene Graph、烘焙装饰、source.pptx 留存与 schemaVersion、round-trip 质量验证。

## 1. 背景与目标

卷王PPT 是一个本地运行的 AI PPT 生成工具（Node.js + Express + pptxgenjs + 无构建前端单页）。本设计将 PPT 生成升级为**模板描述符（template descriptor）驱动**，核心目标：

1. 定义一套模板描述符 schema，结构化表达一套 PPT 模板的设计语言。
2. 描述符 + 内容经 **Layout Resolver** 解析为 **Resolved Scene Graph**（解析过的场景图），后端导出与前端预览只是两个「画家」，从机制上保证「预览 = 导出」。
3. 预设模板手工精调描述符；用户上传的 .pptx 通过自动提取生成描述符草稿，经确认后入库。两类模板走同一条渲染管线。

### 1.1 两类模板的不同成功标准

| 类型 | 典型来源 | 成功标准 | 泛化策略 |
| --- | --- | --- | --- |
| 规范型 | 企业/学校/政府内部规范模板 | **Compliance**：Logo、背景、页脚、字体、标题区域绝不被破坏 | conservative：宁可普通，绝不能不像 |
| Showcase 精品型 | 设计师作品、网上精品 | **Fidelity + Generalization**：保持设计语言一致，能泛化出模板里不存在的新页面 | balanced/expressive |

底层同一套描述符，解析策略与质量评价分开。

## 2. 关键技术事实（已验证）

| 事实 | 影响 |
| --- | --- |
| pptxgenjs 不支持渐变填充（仅 solid + transparency） | 渐变蒙版用「阶梯透明度矩形带」近似，近似逻辑内置在 Layout Resolver，描述符按渐变语义声明 |
| pptxgenjs 提供 `parallelogram` 等预设形状 | 近似模板中常见的斜切平行四边形 custGeom 装饰 |
| pptxgenjs 不能导入现有 .pptx 作为模板 | 模板复用必须走「描述符 + 素材」路线 |
| 真实 PPT 的设计常手绘在各页 slide XML 中，母版/布局可能为空 | 自动提取必须做逐页对象解析 + 跨页聚类，不能只读母版 |
| 不同模板画布尺寸不同（10×5.625in / 13.33×7.5in） | 描述符携带 canvas，坐标跟随模板画布 |
| jszip 已随 pptxgenjs 传递安装 | 提取器直接 require，显式加入 package.json |
| 项目当前无 XML 解析库 | 新增 `fast-xml-parser`（纯 JS、无原生依赖） |

## 3. 模板描述符 schema（v1.1）

每个模板一个目录：

```
templates/<id>/
├── template.json     # 描述符
├── source.pptx       # 仅上传模板：原始文件留存（重新提取/debug/算法升级用）
├── assets/           # 图片素材（含烘焙装饰）
└── preview.png       # 画廊缩略图
```

```jsonc
{
  "schemaVersion": "1.1",          // 从第一天带版本号，未来由 migrateDescriptor() 升级

  // 1. 元信息
  "meta": {
    "id": "warm-retro",
    "name": "复古蓝米",
    "source": "preset | uploaded",
    "preview": "preview.png",
    "licensing": { "redistributable": false, "commercialUse": "unknown" },  // 素材授权（用户上传素材永不进公共库）
    "confidence": { "palette": 1.0, "families": 0.7 },   // 仅上传模板：提取置信度
    "generalizationMode": "conservative | balanced | expressive"  // 内部判断，不暴露给用户
  },

  // 2. 画布（英寸，16:9）
  "canvas": { "width": 13.33, "height": 7.5 },

  // 3. 色板：角色名固定，色值随模板；渲染器只认角色
  "palette": {
    "bg": "F7F1E5", "surface": "FBF7EE",
    "primary": "2B4C7E", "primaryDeep": "1F3A63",
    "accent": "E2703A", "secondary": "5B8A72",
    "divider": "D8CCB4", "warn": "C0392B",
    "text": "33302B", "textMuted": "6B6155", "textFaint": "99907F",
    "onDark": "F7F1E5", "onDarkMuted": "EFE6D2"
  },

  // 4. 字体与字号档位：档位名固定，数值随模板
  "typography": {
    "fonts": {
      "title": { "latin": "Georgia", "ea": "KaiTi" },
      "body":  { "latin": "Segoe UI", "ea": "Microsoft YaHei" },
      "code":  { "latin": "Consolas" }
    },
    "fontFallback": { "KaiTi": "Microsoft YaHei" },   // 缺字体时的替代链；导入时检测并在确认面板提示
    "scale": {
      "display": 54, "sectionNo": 112.5, "sectionTitle": 39, "pageTitle": 31.5,
      "conclusion": 21, "eyebrow": 16.5, "body": 15, "caption": 13.5, "footer": 12
    }
  },

  // 5. 装饰构件库：命名的可复用形状配方（版式签名）
  //    kind: primitive（声明式形状）| baked（复杂装饰烘焙为图片，schema 不膨胀的关键折中）
  "decorations": {
    "ribbon":   { "kind": "primitive", "shape": "parallelogram", "fill": "surface", "defaultSize": [9.5, 0.71], "skew": 0.2,
                  "role": "decoration", "behavior": "fixed" },
    "sideEdge": { "kind": "primitive", "shape": "rect", "fill": "primaryDeep", "width": 0.25,
                  "role": "decoration", "behavior": "fixed" },
    "divider":  { "kind": "primitive", "shape": "line", "color": "divider", "pt": 1.1,
                  "role": "decoration", "behavior": "fixed" },
    "decoCorner": { "kind": "baked", "src": "assets/deco-corner.png",   // 复杂但固定的视觉直接烘焙
                  "role": "decoration", "behavior": "fixed" }
  },

  // 6. 页面家族：family 描述页面功能，variant 描述页面构图
  //    （避免 archetype 数量爆炸：不加 content2/content3，而是 content 的 variant）
  "families": {
    "cover": {
      "variants": {
        "default": {
          "background": {
            "image": "assets/cover.jpg",
            "overlay": { "direction": "horizontal", "stops": [[0, 94], [0.4, 78], [0.7, 28], [1, 0]] }
          },
          "slots": {
            // 每个槽位带语义角色与行为：
            // role: brand | content | decoration | chrome
            // behavior: fixed（原样保留）| replace（换内容保样式）| generate（AI 生成）| repeat（按数据量复制）
            "eyebrow":  { "rect": [0.73, 1.2, 8, 0.5], "size": "eyebrow", "color": "secondary",
                          "bold": true, "letterSpacing": 4.5, "role": "content", "behavior": "generate" },
            "title":    { "rect": [0.73, 2.0, 9, 2.2], "size": "display", "color": "primary",
                          "bold": true, "font": "title", "role": "content", "behavior": "replace" },
            "subtitle": { "rect": [0.73, 4.4, 9, 0.8], "size": "conclusion", "color": "text",
                          "role": "content", "behavior": "generate" }
          },
          "decorations": [ { "use": "ribbon", "at": [0.75, 1.98] } ]
        }
      }
    },
    "section": { "variants": { "default": { "...": "纵向渐变蒙版 + 超大章节号 + 章名 + 导语" } } },
    "content": {
      "variants": {
        "simple":    { "chrome": ["titleBand", "summaryBar", "footer"], "body": "..." },
        "cards":     { "...": "卡片网格构图" },
        "imageLeft": { "...": "左图右文构图（预留，配合图片能力）" }
      }
    },
    "closing": { "variants": { "default": { "...": "..." } } }
  },

  // 7. 内容组件：结构规则与几何参数
  "components": {
    "titleBand":  { "role": "chrome", "behavior": "fixed",
                    "decorations": ["ribbon", "iconDot"], "titleSlot": { "...": "..." } },
    "card":       { "role": "content", "behavior": "repeat",
                    "fill": "surface", "radius": 0.12,
                    "tag": { "fill": "primary", "textColor": "onDark", "size": "eyebrow" } },
    "summaryBar": { "role": "chrome", "behavior": "fixed",
                    "fill": "primary", "edge": "sideEdge", "rect": [0.6, 5.2, 11.6, 1.17],
                    "slots": {
                      "conclusion": { "size": "conclusion", "color": "onDark", "bold": true },
                      "note":       { "size": "body", "color": "onDarkMuted" }
                    } },
    "footer":     { "role": "chrome", "behavior": "fixed",
                    "y": 7.15, "left": "sectionName", "right": "pageNo", "size": "footer", "color": "textFaint" }
  },

  // 8. 类型映射：内容类型 → 候选布局（候选制，Layout Resolver 按数据量/容量/风格选择；
  //    v1 先取首个候选，schema 预留多候选，防止类型膨胀 stats2/stats3）
  "typeMapping": {
    "title":     { "candidates": ["cover.default"] },
    "section":   { "candidates": ["section.default"] },
    "bullets":   { "candidates": ["content.simple", "content.cards"] },
    "twoColumn": { "candidates": ["content.cards"] },
    "table":     { "candidates": ["content.simple"] },
    "steps":     { "candidates": ["content.cards"] },
    "quote":     { "candidates": ["closing.default"] },
    "stats":     { "candidates": ["content.cards"] }
  },

  // 9. 容量模型 + 字数约束
  //    constraints.chars：喂 LLM prompt（生成前置约束）
  //    capacity：渲染期容量声明（Layout Resolver 的 fit 依据）
  "constraints": {
    "chars": { "pageTitle": 20, "bullet": 40, "cardTitle": 10, "conclusion": 50, "subtitle": 40 }
  },
  "capacity": {
    "bulletList":  { "preferredItems": 4, "maxItems": 6, "minFontSize": 13, "overflow": "compress" },
    "pageTitle":   { "preferredLines": 1, "maxLines": 2, "minFontSize": 24, "overflow": "compress" },
    "summaryBar":  { "preferredLines": 2, "maxLines": 3, "minFontSize": 15, "overflow": "truncate" }
    // overflow 策略枚举：compress（缩字号）| truncate（截断并标记）|
    //                    rephrase（回退 LLM 精简）| relayout（换大容量 variant）| split（拆页）
    // v1 渲染器实现 compress + truncate；rephrase/relayout/split 属 Fit Engine 完整阶梯，后续迭代
  },

  // 10. 设计语法（软标签，不参与坐标硬契约）
  //     用途：候选布局排序、fallback 生成、模板相似度；不直接控制几何
  "designGrammar": {
    "density": "low", "alignment": "left", "cornerStyle": "rounded",
    "cardStyle": "flat", "imageStyle": "fullBleed", "titlePattern": "ribbon",
    "numberStyle": "oversized", "whitespace": "generous"
  }
}
```

### 设计要点

- **角色化而非色值化**：palette 角色名跨模板固定；配色成对规则（深底必配 onDark 文字）通过角色内置。
- **语义角色与行为**：每个元素声明 `role`（brand/content/decoration/chrome）与 `behavior`（fixed/replace/generate/repeat）——规范型模板的 Logo/背景/页脚标记 `brand + fixed`，生成时绝不触碰。
- **family + variant 两层**：family 表功能，variant 表构图；typeMapping 输出候选列表，由 Layout Resolver 选择，内容类型有限而视觉实现可扩展。
- **复杂装饰烘焙（baked）**：不值得/无法用声明式表达的固定视觉直接烘焙为 PNG，schema 永不膨胀，内容槽仍保持可编辑。
- **constraints 双向使用**：chars 喂 LLM 从源头控制长度；capacity 供渲染期 fit。

## 4. 渲染架构

```
 template.json + slide 内容 JSON
        │
        ▼
 ┌──────────────────┐
 │  Layout Resolver  │   ← 唯一的设计决策者：
 │                   │     palette/字体/档位查表、variant 选择、
 │                   │     渐变离散化、容量 fit、坐标计算
 └────────┬─────────┘
          │ Resolved Scene Graph（与模板无关的最终场景：对象数组，
          │ 每项含 type/x/y/w/h/fontSize/color/text…，单位英寸）
     ┌────┴─────┐
     ▼          ▼
 pptx-painter  dom-painter      ← 两个画家，不做任何设计决策
 (pptxgenjs)   (DOM/CSS)
     │          │
 .pptx 导出   浏览器预览
```

核心原则：**Renderer 是画家，不是设计师。** 所有查表、选择、计算只执行一次，杜绝前后端两个解释器漂移。

### 4.1 Resolved Scene Graph 示例

```jsonc
{
  "canvas": { "width": 13.33, "height": 7.5 },
  "slides": [
    {
      "background": { "color": "F7F1E5" },
      "objects": [
        { "type": "image", "src": "assets/cover.jpg", "x": 0, "y": 0, "w": 13.33, "h": 7.5 },
        { "type": "rect", "fill": "F7F1E5", "transparency": 94, "x": 0, "y": 0, "w": 5.3, "h": 7.5 },
        { "type": "rect", "fill": "F7F1E5", "transparency": 78, "x": 5.3, "y": 0, "w": 2.7, "h": 7.5 },
        { "type": "text", "x": 0.73, "y": 2.0, "w": 9, "h": 2.2,
          "fontFace": "Georgia/KaiTi", "fontSize": 54, "bold": true, "color": "2B4C7E", "text": "…" }
      ]
    }
  ]
}
```

### 4.2 Overflow 处理阶梯（Fit Engine）

完整阶梯（目标态）：

```
正常排版 → 缩段距 → 缩字号 → 换大容量 variant → LLM 精简 → 拆页 → 明确提示用户
```

v1 实现 `compress`（缩字号至 minFontSize 为止）+ `truncate`（截断并在导出日志/前端标记），其余档随 Fit Engine 迭代。原则：**不静默溢出，有硬性最小字号**。

### 4.3 LLM 集成

- 生成/修改接口接收 `templateId`，服务端加载描述符，把 `constraints.chars` 与类型选型指引拼入 prompt。
- LLM 只输出结构化 JSON（8 种结构化类型 + free 自由排版页，见 4.4）。模板差异、布局选择、坐标计算全部由渲染管线吸收——**LLM 负责「表达什么」，Layout Resolver 负责「怎么表达」**。
- 后续演进方向：LLM 输出升级为 Slide Intent IR（purpose/blocks/emphasis），与 8 类型并跑后切换；本期不动 LLM 契约。

### 4.4 free 自由排版页（HTML 渲染通道）

8 种结构化类型之外，LLM 每页可以选择输出第 9 类 `"free"`：直接产出固定 1280×720 画布的 HTML 片段，用于重点展示页的视觉发挥（核心卖点、重磅数字、创意混排）。这是 generic renderer 原则的**受控 escape hatch**——自由度让渡给 LLM 的 HTML/CSS，换取版式不重复。

- **使用引导**：prompt 硬性要求每份演示 1~3 页 free；harness 额外指定内容页正中一页（`index === floor((total-1)/2)`，5 页以上 deck）在 user message 中点名引导。
- **风格一致性**：`buildFreeStyle(descriptor)` 提取模板色板/字体/designGrammar 基调注入 prompt（`freeStyleText`），HTML 只允许使用模板配色与系统字体；禁止脚本/外部资源/动画；要求文字不被遮挡、留安全边距。
- **预览**：`public/html-frame.js`——字符串级 sanitize（剔 script/iframe/外链/on\*/@import）→ sandbox iframe（`allow-same-origin`，脚本仍禁）→ 文档级 zoom 等比缩放（不用 transform scale，规避软件渲染合成问题且文字不糊）。
- **导出**：`src/html-shot.js` 调本机 Chrome/Edge headless（`KING_PPT_CHROME` 可指定路径）截图 2x PNG → `buildPptx` 的 `renderFree` 钩子 → pptx-painter 整页 addImage 满铺。**free 页导出为图片（不可编辑）**，结构化页保持矢量可编辑——混合取舍已与用户确认。
- **预览 = 导出**：`sanitize/wrap` 前后端共用同一份实现（html-frame.js 以 UMD 形式同时被浏览器和 Node require）。
- **自愈**：free 页 html 缺失/损坏 → 走统一「反馈重试（最多 3 次）→ 结构化兜底页」阶梯，deck 不出空洞；resolver 对 free 页透传 null 场景。
- **已知边界**：LLM 的 HTML 布局质量不受 Fit Engine 约束，可能出现元素重叠/溢出（prompt 已加自检要求）；外部图片与 AI 生图暂不支持。

## 5. 预设模板

| 模板 | 说明 | 来源 |
| --- | --- | --- |
| `classic-blue` 经典蓝 | 现有样式平移（白底 + 深蓝标题 + 8 种基础组件），保证回归安全 | 从现有 `src/pptx.js` 的 THEME 与坐标抽象 |
| `warm-retro` 复古蓝米 | 复刻样板：米色底 + 藏蓝色块 + 橙色点缀，Georgia/楷体标题，斜切色带标题组件、卡片 + 标签条、底部深蓝总结条、封面/章节页插画 + 渐变蒙版 | 样板 PPT 解剖数据手工编写；插画素材抽取自样板，`licensing.redistributable=false`，仅本机使用，公开分发前需授权确认 |

warm-retro 同时承担架构验证任务：明确哪些元素 descriptor 化、哪些 baked（如封面渐变蒙版离散带、斜切色带 parallelogram 近似），不强迫所有视觉元素进入 schema。

## 6. 上传模板自动提取

### 6.1 流程

```
用户上传 .pptx（含安全限制）
  → Stage 0: Normalized Object Graph（XML → 统一对象树，隔离 OOXML 复杂度）
  → 三层提取（全部只读 Object Graph，不直接碰 XML）
  → 描述符草稿（各维度带提取置信度）
  → 前端确认面板
  → 保存 templates/<id>/（template.json + source.pptx + assets + preview）
  → 出现在画廊，走统一渲染管线
```

### 6.2 Stage 0：Normalized Object Graph

所有 slide XML 先归一化为统一对象树：

```jsonc
{ "type": "text | shape | image", "bbox": [x, y, w, h], "fill": "…",
  "text": { "content": "…", "fontSize": 15, "bold": true, "color": "…", "fontFace": "…" },
  "zIndex": 4, "group": null }
```

palette 提取、聚类、构件识别、原型识别**都只读这张图**，OOXML 兼容逻辑收敛在 Stage 0 一处。

### 6.3 三层提取策略

**直接层（confidence = 1.0）**
- `theme1.xml` → palette 色值（角色映射启发式：最深色 → text、最浅色 → bg、使用频次最高 accent → primary）+ 字体族（major/minor × latin/ea）
- `presentation.xml` → canvas

**聚类层（confidence 0.5~0.9）**
- 满屏 rect/图片 → 背景规则；满屏渐变矩形 → overlay stops
- 跨 ≥3 页重复、位置尺寸容差 ±5%、同填充 → decorations/components 候选
- 字号直方图聚类 → typography.scale
- 页面聚类：含全屏图 + 超大字号 → cover/section；其余 → content
- `media/*` → assets 拷贝

**元素语义判定：多信号评分，不是单条启发式**

| 语义 | 信号组合 |
| --- | --- |
| logo | 跨页重复 + 位置稳定 + 图片 hash 相同 + 靠近边缘 + 面积小 |
| title | 页面上部 + 字号大 + 文本页页不同 + 位置稳定 |
| footer | 底部 + 字号小 + 跨页重复 + 颜色弱 |
| body | 文本变化明显 + 处于主内容区 + 尺寸大 |

输出 `roleScore`（如 `logo: 0.94`），据此填 role/behavior。

**估算层（confidence < 0.5，必须用户确认）**
- variant 归类、typeMapping（套默认映射）、capacity（按槽位宽/字号估算）

### 6.4 安全边界（上传即不可信文件）

- 压缩包 ≤ 20MB，解压后 ≤ 200MB；slides 数、单文件 shapes 数、单 asset 体积均设上限
- 拒绝路径含 `..` 的 zip 条目；拒绝 .pptm（宏文件）；不解析外部 relationship
- assets 静态路由防路径穿越

### 6.5 确认面板（四块，不是模板编辑器）

1. **模板预览**：草稿描述符实时渲染 cover / section / content 三张样例页
2. **识别结果**：色板色块、字体（含缺字体提示与 fallback）、Logo、页脚
3. **页面家族**：识别到的 family/variant 清单（实测 ✓ / 推导 标记）
4. **风险提示**：低置信度项高亮（如「Logo 判断置信度 72%」「检测到 2 个可能的页脚元素」）

可改模板名后保存。轻量修复（「这是 Logo 吗？是/否」）列为后续 Template Repair，本期不做。

## 7. API 变更

| 接口 | 变更 |
| --- | --- |
| `GET /api/templates` | 新增。返回模板列表（id、name、source、previewUrl、descriptor 全量） |
| `GET /api/templates/:id/assets/:file` | 新增。模板素材路由（预设读项目 `templates/`，上传读 `~/.king-ppt/templates/`，防路径穿越） |
| `POST /api/templates/extract` | 新增。上传 pptx（v1 用 base64 ≤ 20MB；multipart 列为后续优化）→ 描述符草稿 + 置信度 |
| `POST /api/templates` | 新增。保存确认后的描述符 + source.pptx 到用户目录 |
| `POST /api/outline` / `POST /api/slides` / `POST /api/export` | 请求体新增 `templateId`（缺省 `classic-blue`） |

## 8. 前端变更

- 输入区上方模板画廊条：横向卡片（预览缩略 + 名称 + 选中态），末尾「上传模板」卡片
- `state.templateId` 持久化 localStorage；生成/导出接口携带
- 预览改为 **Scene Graph 驱动**：后端 resolve 出 scene graph 随 SSE 下发（或前端用同一描述符跑同构 resolver），`public/dom-painter.js` 只负责画
- 渐变蒙版用 CSS `linear-gradient`（真渐变）；其余对象与 pptx 画家逐一对齐
- 现有 `.slide-*` 样式消费 `--tpl-*` CSS 变量
- 上传确认面板（见 6.5）

## 9. 实施计划

### 阶段 0：质量基线（轻量）
1. 固定测试 deck（8 类型示例 slides，已有 `.debug/test-components.js`）
2. round-trip 测试脚手架：描述符 → 重新生成 → 结构比对（页数/对象数/色值/字号），为 extractor/renderer 改动提供自动回归

### 阶段 1：schema v1.1 + Layout Resolver + 经典蓝（行为平移）
1. `templates/classic-blue/template.json`：现有 THEME 与 8 种版式坐标全部抽成描述符（含 role/behavior/capacity）
2. `src/descriptor.js`：加载（schemaVersion 校验 + 默认值 + assets 路径解析）、枚举
3. `src/layout-resolver.js`：descriptor + slides → Resolved Scene Graph
4. `src/pptx-painter.js`：scene graph → pptxgenjs；`src/pptx.js` 改薄入口 `buildPptx(slides, title, templateId)`
5. 验证：测试 deck 导出与改动前结构等价（页数、表格、形状齐全）

### 阶段 2：复古蓝米复刻
1. 样板 PPT 的 6 张插画拷入 `templates/warm-retro/assets/`（licensing 标记不可再分发）
2. 按解剖数据编写 `template.json`（10 维全填；复杂装饰评估 baked）
3. Resolver 补齐：阶梯透明度渐变带、parallelogram skew
4. 验证：导出物与样板 PPT 人工比对（封面/章节页/内容页各一页，色值/构件/字号档位）

### 阶段 3：前端画廊 + Scene Graph 预览
1. `GET /api/templates`、assets 路由
2. 模板画廊 UI + `state.templateId` + localStorage
3. dom-painter + `--tpl-*` 变量化；SSE 携带 scene graph
4. `agent.js` 接入 constraints.chars；server 三接口解析 templateId
5. 验证：切模板预览即时变化；预览与导出同风格；SSE 不回归

### 阶段 4：上传提取 + 确认
1. `package.json` 显式加入 `jszip`、`fast-xml-parser`
2. `src/extract.js`：Stage 0 Object Graph + 三层提取 + 多信号语义评分 + 安全限制
3. extract / save 接口（保存 source.pptx）
4. 前端确认面板（四块）
5. 验证：**round-trip**——样板 PPT 提取草稿的 palette/fonts/canvas 与手工版一致；用原文字重新生成并结构比对；上传-确认-生成-导出全链路

### 收尾
- README 新增「模板系统」章节

## 10. 质量验证体系

### 10.1 核心自动测试：Round-trip Reconstruction

```
原 PPT → 提取描述符 → 用原文字/素材重新生成 → 导出 → 结构比对
```

extractor 或 renderer 任何改动都可自动回归。v1 比结构（页数/对象清单/色值/字号/坐标容差），像素级 visual diff 列为后续。

### 10.2 质量指标（逐步建设）

| 指标 | 说明 | v1 |
| --- | --- | --- |
| Extraction Accuracy | palette/font/logo/footer/构件识别正确率 | 阶段 4 样板验证 |
| Visual Fidelity | round-trip 重建与原页相似度 | 结构比对 |
| Content Fit | overflow/overlap/越界/字号过小检测 | compress+truncate 生效 |
| Style Consistency | 新页面是否像同一模板 | 人工比对 |
| Layout Selection | 候选选择是否正确 | 取首候选 |
| First-pass Acceptance | 用户免修改页比例（北极星指标） | 暂不度量 |

规范型与 Showcase 模板分开评价，不混用同一分数。完整 Benchmark Suite（多行业真实模板）列为商业化阶段建设。

## 11. 非目标（本期明确不做）

- 贝塞尔手绘图标 / custGeom 像素级还原（parallelogram/圆点近似 + baked）
- 模板在线可视化编辑器（只有确认面板；Template Repair 轻量修复列为后续）
- 完整 Fit Engine 阶梯（rephrase/relayout/split）、Slide Intent IR、SVG 预览
- Template Health Score、multipart 上传、模板市场/团队共享
- 视频/音乐生成能力接入模板

## 附录：外部评审意见处置对照

| 评审建议 | 处置 | 说明 |
| --- | --- | --- |
| 元素 role/behavior 语义 | ✅ v1.1 采纳 | 已入 schema |
| family + variant | ✅ v1.1 采纳 | archetype 重构为 families.variants |
| typeMapping 候选制 | ✅ v1.1 采纳（schema） | v1 取首候选，多候选选择后续 |
| 容量模型 capacity | ✅ v1.1 采纳（schema + compress/truncate） | 完整 ladder 后续 |
| Resolved Scene Graph | ✅ v1.1 采纳 | 渲染架构核心（§4） |
| Baked Decoration | ✅ v1.1 采纳 | decorations.kind=baked |
| source.pptx 留存 + schemaVersion | ✅ v1.1 采纳 | §3、§6 |
| Benchmark + Round-trip | ✅ 采纳（轻量版） | 阶段 0 + 阶段 4；完整 Suite 暂缓 |
| Overflow Ladder 完整阶梯 | 🕐 后续 | v1 只做 compress/truncate |
| Slide Intent IR | 🕐 后续 | LLM 契约本期不变 |
| designGrammar 软标签 | ✅ schema 预留 | 不参与坐标计算 |
| Normalized Object Graph | ✅ 采纳 | 提取器 Stage 0 |
| 多信号语义评分 | ✅ 采纳 | §6.3 |
| Confidence 拆分为提取置信度 + 生成可用度 | 🕐 后续 | v1 只保留提取置信度 |
| 确认面板增强（四块） | ✅ 采纳 | §6.5 |
| 复杂度预算 / 健康分 | 🕐 后续 | 商业化阶段 |
| 字体 fallback 检测 | ✅ schema 预留 + 确认面板提示 | §3、§6.5 |
| 图片型内容块（image/hero/gallery） | 🕐 后续 | 配合 image 能力单独迭代 |
| multipart 上传 | 🕐 后续 | v1 base64 ≤ 20MB |
| 上传安全限制 | ✅ 采纳 | §6.4 |
| 素材授权建模 | ✅ 采纳 | meta.licensing |
| Generic Renderer + 受控 escape hatch | ✅ 采纳 | baked 即受控逃生口 |
| 前端向 SVG/绝对坐标演进 | 🕐 后续 | Scene Graph 已为切换留好接口 |
| Template Repair（轻量修复） | 🕐 后续 | 确认面板之后迭代 |
