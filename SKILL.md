---
name: king-ppt
description: >-
  卷王PPT — generate editable .pptx presentations through a live web studio that
  YOU (the calling Agent) drive. Use this skill whenever the user wants to create,
  design, or export a PowerPoint / slide deck / 演示文稿 / PPT, especially when they
  want to pick a theme on a webpage, preview slides live, or iterate on a deck
  interactively. You are the content brain and the designer; this skill is the
  SVG-as-IR compiler + browser studio. It never calls an LLM itself — you author
  every slide as one full-page SVG.
---

# 卷王PPT · Agent-driven SVG PPT studio

You are the **content brain and the designer**. This skill is an **SVG-as-IR compiler** (`one full-page SVG per slide → native editable .pptx`) wrapped in a **web studio** the human watches and edits in real time. There is **no built-in LLM** — *you* author every slide. The skill guarantees **preview == export**: the browser and the `.pptx` consume the *same* sanitized SVG, so what the human sees is exactly what lands in the file.

**The medium is SVG.** Every slide is one `<svg viewBox="0 0 1280 720">` that you compose. There are no fixed slide "types" and no per-field char limits anymore — you lay out the whole page yourself, using the chosen **theme's design tokens** (palette, type scale, geometry) to stay consistent. The compiler turns your `<rect>/<text>/<path>/…` into native, editable PowerPoint shapes — no Chrome, no rasterization.

Your job: start the studio → pick a theme and read its **spec** (tokens + role prototypes + rules) → author the deck as SVG and push it (the human sees it instantly) → **collaborate** (block on human actions, react, re-push) until they export.

---

## How it works (control flow)

```
  YOU (Agent) ──push deck/slide (SVG)──▶ studio server ──SSE──▶ human's browser (live inline SVG)
       ▲                                  (relay)                    │
       └──────── next (long-poll) ◀────── action queue ◀──── picks theme / edits text / annotates
```

You and the human take turns. **You always push first** (so the human has something to look at), then call `next` to hand control over and wait. This turn-based loop replaces any self-healing generation loop — the human is in the loop instead.

---

## Setup — start the studio (once per session)

Run the server as a **background task** and leave it running. It prints a JSON line with the URL, opens the browser, then blocks.

```bash
# from the skill directory; runs in background, opens browser
node bin/cli.js serve
```

- Default port `3210` (override with `--port=N` or `PORT`). Other commands auto-locate it via `KING_PPT_HOME/server.json`. Headless? add `--no-open`.
- **Data location:** set `KING_PPT_HOME` to keep sessions/assets/uploaded themes with the project (defaults to `~/.king-ppt`), e.g. `KING_PPT_HOME=./.king-ppt node bin/cli.js serve`.
- Node ≥ 18 (uses global `fetch`). Run `npm install` first if `node_modules` is absent. The browser UI is a prebuilt Vite/React bundle in `public/` — no build step needed to run; rebuild with `npm run build` only if you change `web/`.

When done: `node bin/cli.js stop`.

---

## The collaboration loop (the core protocol)

1. **List themes**, optionally let the human pick first:
   `node bin/cli.js templates` → `{ templates: [{id, name, source, palette}] }`
2. **Fetch the spec** for the chosen theme — it returns that theme's **design tokens**, four **role prototype pages** (ready-to-edit SVG skeletons), and the **SVG authoring rules**:
   `node bin/cli.js spec <themeId>`
3. **Author** the whole deck as SVG (following the contract below) and **push** it:
   `node bin/cli.js push deck.json` — the human sees all pages instantly.
   *(Or stream page-by-page with `push-slide <index> slide.json` for a live typewriter feel.)*
4. **Hand over** — block for the next human action:
   `node bin/cli.js next` — returns one action (or a `heartbeat` after ~25s).
5. **React** to the action (table below), re-push the affected page(s) or deck, then `next` again.
6. Loop 4–5 until satisfied. They export from the browser button, **or** you export on request: `node bin/cli.js export out.pptx`.

### Reacting to `next` actions

`next` returns `{ action, payload, version }`. Handle each:

| action | payload | what the human did → what you do |
|---|---|---|
| `generate` | `{topic, pages, themeId}` | Asked to (re)generate. **Author the whole deck as SVG** for `topic`/`pages` on `themeId`, then `push`. |
| `annotate` | `{instruction, index?, themeId}` | Typed a natural-language change ("把第3页的图表改成对比两年数据"). If `index` is set it targets that page; else the whole deck. Redraw the affected SVG(s), re-`push`/`push-slide`. |
| `edit` | `{index, slide}` | Edited text **in-place** on page `index`. The server **already applied** it authoritatively (re-sanitized SVG in `slide.svg`) — just absorb it into your working copy; only re-push if you further change it. |
| `regen` | `{index, feedback?}` | Wants page `index` redrawn. Re-author that page's SVG, `push-slide index`. |
| `theme-pick` | `{themeId}` | Switched theme. **Re-fetch `spec`** for the new theme and redraw pages using the new tokens (colors/scale/geometry change; your SVG structure can stay). |
| `heartbeat` | `{version}` | ~25s passed with no action. Just call `next` again (or do other work). |

**No deadlock:** you push before you wait, so the human always has content to act on; the queue delivers their action instantly, else `next` returns a heartbeat. Never block on `next` before your first push.

**Concurrency:** writes are single-page-granular with a monotonic `version`. Your `push-slide` and the human's `edit` can't clobber each other. If a `next`/state `version` is older than one you've seen, ignore stale content.

---

## Slide contract (the medium is SVG)

A deck is `{ title, themeId, slides: [ … ] }`. **Every slide is one full-page SVG.** Each entry may be either a bare SVG string or an object:

```json
{ "svg": "<svg …>…</svg>", "role": "content", "title": "页面标题" }
```

- `svg` — **required**, one complete `<svg viewBox="0 0 1280 720">…</svg>` (see rules below).
- `role` — optional hint (`cover` · `section` · `content` · `closing`), used for the page-rail label and to pick a starting prototype. If omitted, the server infers: page 1 → `cover`, last → `closing`, else `content`.
- `title` — optional plain-text page title (for thumbnails/outline); does not affect rendering.

There are **no other fields, no `type`, no char limits.** You own the whole page. (`themeId` may also be sent as `templateId` — both accepted.)

### Page roles (layout intent, not hard fields)

- **`cover`** — page 1. Oversized headline + eyebrow + subtitle/byline; one visual anchor, lots of color or whitespace.
- **`section`** — divider. Dark ground + huge section number (01/02) + section name; minimal, a breath between chapters.
- **`content`** — the workhorse. Page title + accent underline + 2–5 points/cards/stats; strict alignment, generous whitespace.
- **`closing`** — last page. Thanks / call-to-action; one calm centered line.

`spec <themeId>` returns a **ready-made SVG prototype for each role** in the theme's colors — start from the closest one, swap the text/data, then add or remove elements for your content.

### Design with the theme's tokens

`spec` returns `tokens`: **`color`** (palette roles like `primary`/`accent`/`text`/`bg`), **`scale`** (a type-size ramp: `display`/`sectionTitle`/`pageTitle`/`body`/`caption`/…), **`font`** (title & body stacks), and **`geometry`** (corner radius, hairline, margin). Use *only* these palette colors and pick `font-size` from the scale so the whole deck stays coherent. The theme carries the design; you carry the content and composition.

---

## SVG authoring rules (what the compiler & sanitizer accept)

`spec.authoringText` returns the exact rules; the essentials:

- **Root:** `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">…</svg>`. Canvas is always 1280×720. Output only the SVG. When pushing as JSON, escape inner quotes as `\"`.
- **Allowed elements:** `<rect> <circle> <ellipse> <line> <polyline> <polygon> <path> <text> <g> <image>`. `<g>` only for `transform="translate/rotate/scale"`. `<path>` uses standard `d` commands (M/L/H/V/C/S/Q/T/A/Z, abs or rel) → compiled to native editable custom geometry.
- **`<text>`** must carry `x`, `y`, `font-size`, `fill`; align via `text-anchor="start|middle|end"`; **line breaks = multiple `<text>` elements, never `<tspan>`** (tspan positioning isn't guaranteed on export).
- **`<image>`** — inline `data:` URI only (`href="data:image/…;base64,…"`). Upload first via `asset` to get base64, then inline it. External image URLs are stripped.
- **Forbidden (stripped by the sanitizer, so don't rely on them):** `<script>`, `on*` handlers, `javascript:` · `<defs>`, gradients (`linear/radialGradient`), `<filter>`, `<mask>`, `<clipPath>`, `<pattern>`, `<use>`, `<symbol>` · `<style>`, CSS animation, `<animate*>`, external fonts/resources. **Gradients and filters are forbidden by design** — pptxgenjs can't reproduce them, so allowing them would break preview==export. For depth, layer **solid colors with `fill-opacity`** instead.
- **Layout self-check:** put decorative shapes first and **text last** (so nothing covers it); keep text ≥ `margin` from the edges; body `font-size` ≥ the `caption` step; align same-kind elements to shared baselines; one idea per page — prefer whitespace over clutter.

Spend your design effort where it matters: hero pages (key selling point, big number, creative visual) deserve bespoke layouts; narrative pages should stay regular and consistent.

---

## CLI reference

All commands print JSON to stdout; errors go to stderr with a non-zero exit. They locate the server via `KING_PPT_HOME/server.json` (override with `--port=N` or `KING_PPT_PORT`).

| command | purpose |
|---|---|
| `serve [--port=N] [--no-open]` | Start studio + open browser. **Run as a background task.** |
| `stop` | Stop the running server. |
| `templates` | List available themes `{id, name, source, palette}`. |
| `spec <themeId>` | Authoring spec: design tokens, 4 role prototype SVGs, SVG rules. |
| `push [deck.json]` | Push a whole deck `{title, themeId, slides:[{svg,role?,title?}]}` (file or stdin). Returns `{themeId, canvas, slides, recovered, version}`. |
| `push-slide <index> [slide.json]` | Push one page `{svg}` (streaming feel). File/stdin. |
| `next [--timeout=ms]` | Long-poll the next human action (blocks; ~25s heartbeat). |
| `state` | Full current deck snapshot (for reconnect/export). |
| `asset --file=<img> \| --data=<base64> \| --url=<url>` | Store an image; returns a payload you can inline as a `data:` URI. |
| `export <out.pptx>` | Export the current deck to a `.pptx` file. |

Pipe JSON via stdin instead of a file, e.g.: `echo '{"title":"…","themeId":"classic-blue","slides":[…]}' | node bin/cli.js push`.

---

## Worked example

```bash
# 1. start studio in the background (browser opens for the human)
KING_PPT_HOME=./.king-ppt node bin/cli.js serve &

# 2. see themes, read the token spec + role prototypes for the one you'll use
node bin/cli.js templates
node bin/cli.js spec classic-blue     # → tokens, layouts[cover|section|content|closing].svg, rules

# 3. author the deck as full-page SVG (start from the role prototypes) and push it
cat > /tmp/deck.json <<'JSON'
{ "title": "时间管理分享", "themeId": "classic-blue", "slides": [
  { "role": "cover", "title": "封面",
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><rect width=\"1280\" height=\"720\" fill=\"#FFFFFF\"/><rect x=\"0\" y=\"0\" width=\"14\" height=\"720\" fill=\"#2E86C1\"/><text x=\"80\" y=\"210\" font-size=\"22\" fill=\"#777777\">AI 提效 · 实践</text><text x=\"80\" y=\"350\" font-family=\"'Microsoft YaHei', sans-serif\" font-size=\"96\" fill=\"#1F4E79\">十分钟做完别人熬夜的 PPT</text><text x=\"80\" y=\"420\" font-size=\"44\" fill=\"#333333\">给大学生的时间管理分享</text></svg>" },
  { "role": "content", "title": "三个误区",
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><rect width=\"1280\" height=\"720\" fill=\"#FFFFFF\"/><text x=\"80\" y=\"150\" font-size=\"44\" fill=\"#1F4E79\">三个误区</text><rect x=\"80\" y=\"180\" width=\"90\" height=\"4\" fill=\"#2E86C1\"/><circle cx=\"90\" cy=\"292\" r=\"6\" fill=\"#2E86C1\"/><text x=\"120\" y=\"300\" font-size=\"26\" fill=\"#333333\">把忙碌当高效</text><circle cx=\"90\" cy=\"382\" r=\"6\" fill=\"#2E86C1\"/><text x=\"120\" y=\"390\" font-size=\"26\" fill=\"#333333\">不给任务留缓冲</text><circle cx=\"90\" cy=\"472\" r=\"6\" fill=\"#2E86C1\"/><text x=\"120\" y=\"480\" font-size=\"26\" fill=\"#333333\">做完从不复盘</text></svg>" },
  { "role": "closing", "title": "谢谢",
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><rect width=\"1280\" height=\"720\" fill=\"#1F4E79\"/><text x=\"640\" y=\"350\" font-family=\"'Microsoft YaHei', sans-serif\" font-size=\"96\" fill=\"#FFFFFF\" text-anchor=\"middle\">谢谢观看</text><text x=\"640\" y=\"430\" font-size=\"26\" fill=\"#D6E4F0\" text-anchor=\"middle\">开始你的第一次复盘</text></svg>" }
] }
JSON
node bin/cli.js push /tmp/deck.json

# 4. hand over and react
node bin/cli.js next        # → e.g. {"action":"regen","payload":{"index":1}}
#    ...redraw page 1's SVG, then:
node bin/cli.js push-slide 1 /tmp/slide1.json
node bin/cli.js next        # → loop until they export

# 5. export on request
node bin/cli.js export ./时间管理分享.pptx
```

---

## Notes & guarantees

- **Preview == export.** The browser and the `.pptx` consume the same sanitized SVG. The sanitizer runs on ingress (push/edit), so it strips anything the exporter can't reproduce *before* the human ever sees it — you never preview something that won't export.
- **You are the designer.** Unlike the old fixed-type engine, there are no auto-placed layouts — compose each page yourself. Lean on the theme tokens and the role prototypes from `spec` so pages stay consistent, then go bespoke on hero pages.
- **Native, editable output.** `<rect>/<text>/<path>/<image>` become real PowerPoint shapes, text runs, custom-geometry paths, and pictures — fully editable in PowerPoint, no rasterization, no Chrome.
- **Themes carry the design system.** A theme is a token pack (`theme.json`: palette + type scale + geometry). Uploading a `.pptx` in the browser extracts its palette/fonts into a usable theme that appears in `templates`; you author against it identically.
- **`recovered` on push** lists page indices whose SVG failed to parse and were replaced with a blank fallback — redraw those. Keep your working copy in sync with `state` after `edit`/`theme-pick`, since the server may have applied changes authoritatively.
