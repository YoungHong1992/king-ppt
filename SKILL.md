---
name: king-ppt
description: >-
  卷王PPT — generate editable .pptx presentations through a live web studio that
  YOU (the calling Agent) drive. Use this skill whenever the user wants to create,
  design, or export a PowerPoint / slide deck / 演示文稿 / PPT, especially when they
  want to pick a template on a webpage, preview slides live, or iterate on a deck
  interactively. You are the content brain; this skill is the deterministic layout
  engine + browser studio. It never calls an LLM itself — you write the slide JSON.
---

# 卷王PPT · Agent-driven PPT studio

You are the content brain. This skill is a **deterministic layout engine** (`slide JSON → resolved scene graph → .pptx`) wrapped in a **web studio** that the human watches and edits in real time. There is **no built-in LLM** — *you* author every slide's JSON. The skill guarantees **preview == export**: what the human sees in the browser is exactly what lands in the `.pptx`.

Your job: start the studio, generate slide JSON that obeys the contract below, push it (the human sees it instantly), then **collaborate** — block on human actions, react, re-push, until they export.

---

## How it works (control flow)

```
  YOU (Agent) ──push deck/slide──▶ studio server ──SSE──▶ human's browser (live preview)
       ▲                              (relay)                    │
       └──────── next (long-poll) ◀── action queue ◀──── picks template / edits / instructs
```

You and the human take turns. **You always push first** (so the human has something to look at), then you call `next` to hand control over and wait for what they do. This turn-based loop replaces any self-healing generation loop — the human is in the loop instead.

---

## Setup — start the studio (once per session)

Run the server as a **background task** and leave it running. It prints a JSON line with the URL, opens the human's browser, then blocks.

```bash
# from the skill directory; runs in background, opens browser
node bin/cli.js serve
```

- The server picks port `3210` by default (override with `--port=N` or `PORT`).
- All other commands auto-locate it via `KING_PPT_HOME/server.json`. In a headless env or when you don't want a browser popup, add `--no-open`.
- **Data location:** set `KING_PPT_HOME` to keep sessions/assets/uploaded templates with the project (defaults to `~/.king-ppt`). e.g. `KING_PPT_HOME=./.king-ppt node bin/cli.js serve`.
- Node ≥ 18 required (uses global `fetch`). Run `npm install` first if `node_modules` is absent.

When done: `node bin/cli.js stop`.

---

## The collaboration loop (the core protocol)

1. **List templates**, optionally let the human pick first:
   `node bin/cli.js templates` → `{ templates: [{id, name, source}] }`
2. **Fetch the spec** for the chosen template — it gives you the exact char limits, palette, and free-SVG rules **for that template**:
   `node bin/cli.js spec <templateId>`
3. **Generate** the full deck as slide JSON (following the contract below) and **push** it:
   `node bin/cli.js push deck.json` — the human sees all pages instantly.
   *(Or stream page-by-page with `push-slide <index> slide.json` for a live typewriter feel.)*
4. **Hand over** — block for the next human action:
   `node bin/cli.js next` — returns one action (or a `heartbeat` after ~25s).
5. **React** to the action (table below), re-push the affected page(s) or deck, then `next` again.
6. Loop 4–5 until the human is satisfied. They export from the browser button, **or** you export on request: `node bin/cli.js export out.pptx`.

### Reacting to `next` actions

`next` returns `{ action, payload, version }`. Handle each:

| action | payload | what the human did → what you do |
|---|---|---|
| `generate` | `{topic, pages, templateId}` | Asked to (re)generate. **Author the whole deck** for `topic`/`pages` on `templateId`, then `push`. |
| `revise` | `{instruction, templateId}` | Typed a natural-language change ("把第3页精简一半"). Apply it to the relevant page(s), re-`push` or `push-slide`. |
| `edit` | `{index, slide}` | Edited text in-place on page `index`. The server **already applied** it authoritatively — `slide` is their new content. Just absorb it into your working copy; only re-push if you further change it. |
| `regen` | `{index, feedback?}` | Wants page `index` rewritten. `feedback` may list quality warnings. Rewrite that page, `push-slide index`. |
| `template-pick` | `{templateId}` | Switched template. The server re-resolved existing pages locally; **re-fetch `spec`** for the new template and keep new content within its limits. |
| `heartbeat` | `{version}` | ~25s passed with no action. Just call `next` again (or do other work). Keeps you from hanging forever. |

**No deadlock:** you push before you wait, so the human always has content to act on; the queue delivers their action the instant it arrives, else `next` returns a heartbeat. Never block on `next` before your first push.

**Concurrency:** writes are single-page-granular with a monotonic `version`. Your `push-slide` and the human's `edit` can't clobber each other. If a `next`/state `version` is older than one you've already seen, ignore stale content.

---

## Slide contract (author JSON to match this exactly)

A deck is `{ title, templateId, slides: [...] }`. Every slide has a `type` and its fields. **`spec <id>` returns the authoritative limits for the chosen template** — the values below are the defaults.

### Types (the `type` field must be one of these)

- `"title"` — cover. `{ title, subtitle }`
- `"section"` — section divider. `{ title, subtitle? }`
- `"bullets"` — bullet page. `{ title, bullets: string[] }` (3–6 items, each ≤ 40 chars)
- `"twoColumn"` — two-column compare. `{ title, leftTitle, leftBullets: string[], rightTitle, rightBullets: string[] }`
- `"table"` — data table. `{ title, headers: string[], rows: string[][] }` (3–5 cols, 2–6 rows, cell ≤ 20 chars)
- `"steps"` — process. `{ title, steps: [{title, desc}] }` (3–5 steps, title ≤ 10, desc ≤ 30 chars)
- `"quote"` — pull quote. `{ quote, author? }` (one punchy line ≤ 50 chars)
- `"stats"` — key numbers. `{ title, stats: [{value, label}] }` (2–4 numbers, `value` bold like `"87%"`, `label` ≤ 12 chars)
- `"free"` — free-form page. `{ title, svg }` — design the whole page in SVG (see rules below). **Use 1–3 per deck** for your highest-impact pages (key selling point, hero number, creative visual) so the deck isn't monotonous.

### Optional enrichment fields (include if useful, omit otherwise)

- `eyebrow` — kicker on cover/section (≤ 12 chars, e.g. `"AI 提效 · 实践"`)
- `conclusion` — bottom summary bar on a content page (one line ≤ 50 chars); optional companion `note` (≤ 50 chars)
- `author` — cover byline
- `image` — picture payload, **only on `bullets` pages**: first upload via `asset` to get `{file, path, url}`, attach the whole object as `slide.image`; the `imageRight` variant auto-uses it.

### Type selection guidance

Structured data / multi-dimension compare → `table`. Sequential content → `steps`. Emphasize one line → `quote`. Eye-catching number → `stats`. Core selling point / big number / creative showcase → `free` (1–3 per deck for visual punch). Everything else narrative → `bullets` or `twoColumn`.

### Position contract (mandatory)

- **Page 1 must be `title`.**
- **Last page must be `section`** (a thank-you / closing page).

Structured pages are auto-nudged into place, but author with this in mind. `free` pages are exempt (a `free` hero cover stays put).

### Char limits (defaults; `spec` returns the real numbers per template)

Title ≤ 20 · bullet ≤ 40 · column/step title ≤ 10 · table cell ≤ 20 · step desc ≤ 30 · quote ≤ 50 · conclusion ≤ 50. Overflows come back as `warnings` on the push response — tighten and re-push.

---

## Free SVG pages (`type: "free"`)

The `svg` string is rendered natively into the .pptx as **editable vector shapes** (no rasterization, no Chrome needed). Rules — `spec` returns the exact palette per template:

- Output one complete SVG: root `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`. Only the SVG itself. Escape inner quotes as `\"`.
- **Allowed elements only:** `<rect> <circle> <ellipse> <line> <text> <g>` (`<g>` only for `transform="translate(x,y)"`).
- **Only the template palette colors** (from `spec.freeStyle.colors`); you may add `fill-opacity`/`stroke-opacity` for depth.
- `<text>` must carry `x`, `y`, `font-size`, `fill`; align via `text-anchor="start|middle|end"`; **line breaks = multiple `<text>` elements**, never `<tspan>`.
- **Forbidden:** `<script>`, event attributes, any external resource (href/images/fonts), `<defs>`, gradients, filters, mask, clip-path, CSS animation.
- **Layout self-check:** decorative blocks must not cover text (put text elements last); keep text ≥ 40px from edges; font-size ≥ 16.
- Encouraged: bold block contrast, circle/line geometry, translucent overlays, oversized numbers, generous aligned whitespace.

> A legacy `{type:"free", html}` (raw HTML) path also exists but requires a local Chrome/Chromium/Edge for export rasterization. **Prefer `svg`** — it's editable and dependency-free. (Set `KING_PPT_CHROME` if you must use HTML and Chrome isn't auto-found.)

---

## CLI reference

All commands print JSON to stdout; errors go to stderr with a non-zero exit. They locate the server via `KING_PPT_HOME/server.json` (override with `--port=N` or `KING_PPT_PORT`).

| command | purpose |
|---|---|
| `serve [--port=N] [--no-open]` | Start studio + open browser. **Run as a background task.** |
| `stop` | Stop the running server. |
| `templates` | List available templates. |
| `spec <templateId>` | Authoring spec for a template: canvas, char limits, palette, free-SVG rules, type contract text. |
| `push [deck.json]` | Push a whole deck `{title, templateId, slides[]}` (file arg or stdin). Returns `{scenes, warnings, version}`. |
| `push-slide <index> [slide.json]` | Push one page (streaming feel). File/stdin. |
| `next [--timeout=ms]` | Long-poll the next human action (blocks; ~25s heartbeat). |
| `state` | Full current deck snapshot (for reconnect/export). |
| `asset --file=<img> \| --data=<base64> \| --url=<url>` | Store an image, returns the `slide.image` payload. |
| `export <out.pptx>` | Export the current deck to a `.pptx` file. |

Pipe JSON via stdin instead of a file, e.g.: `echo '{"title":"…","templateId":"classic-blue","slides":[…]}' | node bin/cli.js push`.

---

## Worked example

```bash
# 1. start studio in the background (browser opens for the human)
KING_PPT_HOME=./.king-ppt node bin/cli.js serve &

# 2. see templates, read the contract for the one you'll use
node bin/cli.js templates
node bin/cli.js spec classic-blue

# 3. author a deck (obey the contract) and push it — human sees it live
cat > /tmp/deck.json <<'JSON'
{ "title": "时间管理分享", "templateId": "classic-blue", "slides": [
  {"type":"title","title":"十分钟做完别人熬夜的 PPT","subtitle":"给大学生的时间管理分享"},
  {"type":"bullets","title":"三个误区","bullets":["把忙碌当高效","不留缓冲时间","从不复盘"]},
  {"type":"stats","title":"数据说话","stats":[{"value":"2h","label":"日均可回收"},{"value":"87%","label":"效率提升"}]},
  {"type":"free","title":"核心公式","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><rect width=\"1280\" height=\"720\" fill=\"#1F4E79\"/><text x=\"640\" y=\"380\" font-size=\"64\" fill=\"#FFFFFF\" text-anchor=\"middle\">要事 × 专注 = 产出</text></svg>"},
  {"type":"section","title":"谢谢观看","subtitle":"开始你的第一次复盘"}
] }
JSON
node bin/cli.js push /tmp/deck.json

# 4. hand over and react
node bin/cli.js next        # → e.g. {"action":"regen","payload":{"index":1}}
#    ...rewrite page 1, then:
echo '{"type":"bullets","title":"三个误区","bullets":["把忙碌当高效","不给任务留缓冲","做完从不复盘"]}' \
  | node bin/cli.js push-slide 1
node bin/cli.js next        # → loop until they export

# 5. export on request
node bin/cli.js export ./时间管理分享.pptx
```

---

## Notes & guarantees

- **Preview == export**: the same normalize/resolve path feeds both the browser preview and the `.pptx`. Don't second-guess layout — author content, the engine places it.
- **Templates carry the design.** You choose colors/positions *only* inside `free` SVG (within the template palette). Structured types are fully themed by the template.
- **Uploading a template:** the human can drop a `.pptx` in the browser to extract it into a reusable template — it then appears in `templates`. You author against it identically.
- **Warnings are advisory**, not errors — a deck with warnings still renders/exports. Tighten text to clear them when it matters.
- Keep your working copy of the deck in sync with `state` after `edit`/`template-pick` actions, since the server may have applied changes authoritatively.
