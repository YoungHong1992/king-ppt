// 场景图质量校验：文字溢出 / 越界 / 内容约束，纯本地估算，不调 LLM
// 两个用途：
// ① SSE 逐页 warnings —— 前端黄条提示，用户可指令修正或重生成该页
// ② 首页门禁 —— 第 1 页出现 error 级问题时反馈给模型重试一次（学 PPT Master first-page gate）
const CANVAS_PAD = 0.02; // 越界判定容差（英寸）

// 估一段文字的单行宽度（英寸）：CJK 全角 ≈ 1em，拉丁/数字/半角标点 ≈ 0.55em
function textWidthIn(text, fontSizePt) {
  let units = 0;
  for (const ch of String(text)) {
    units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 1 : 0.55;
  }
  return (units * fontSizePt) / 72;
}

// 估文本在框内占用的行数与总高（英寸）；行高 1.3em 与 dom-painter/pptx 默认一致
function estimateLines(text, fontSizePt, boxW) {
  const w = Math.max(textWidthIn(text, fontSizePt), 0.01);
  return Math.max(1, Math.ceil(w / Math.max(boxW, 0.01)));
}
function textHeightIn(text, fontSizePt, boxW) {
  return estimateLines(text, fontSizePt, boxW) * ((fontSizePt * 1.3) / 72);
}

function validateScene(scene, canvas, index) {
  const warnings = [];
  const add = (level, msg) => warnings.push({ index, level, message: msg });
  if (!scene || !Array.isArray(scene.objects)) return warnings;
  const W = canvas.width;
  const H = canvas.height;

  for (const o of scene.objects) {
    if (typeof o.x === 'number' && (o.x < -CANVAS_PAD || o.y < -CANVAS_PAD
      || o.x + o.w > W + CANVAS_PAD || o.y + o.h > H + CANVAS_PAD)) {
      add('error', `有元素超出画布边界（x:${o.x.toFixed(2)} y:${o.y.toFixed(2)} w:${o.w.toFixed(2)} h:${o.h.toFixed(2)}）`);
    }
    if (o.kind === 'text' && o.text) {
      const need = textHeightIn(o.text, o.fontSize || 14, o.w);
      if (need > o.h * 1.35) {
        const lines = estimateLines(o.text, o.fontSize || 14, o.w);
        add('warn', `「${String(o.text).slice(0, 12)}…」约需 ${lines} 行，超出文本框高度，可能被裁切`);
      }
    }
    if (o.kind === 'bullets') {
      const items = o.items || [];
      const fs = o.fontSize || 14;
      let total = 0;
      let worst = null;
      for (const t of items) {
        const h = textHeightIn(t, fs, o.w - 0.35); // 留出项目符号缩进
        if (!worst || h > worst.h) worst = { t, h };
        total += h + ((o.paraSpaceAfter || 0) / 72);
      }
      if (total > o.h * 1.3) {
        add('error', `要点共 ${items.length} 条，预计高度超出区域约 ${Math.round(((total / o.h) - 1) * 100)}%，请精简条数或字数`);
      } else if (worst && worst.h > (fs * 1.3 * 2.2) / 72) {
        add('warn', `要点「${String(worst.t).slice(0, 12)}…」过长，将折行显示`);
      }
    }
    if (o.kind === 'table') {
      const cols = Math.max(1, (o.headers || []).length);
      const colW = o.w / cols;
      const cellFs = (o.cell && o.cell.fontSize) || 12;
      let overflow = 0;
      for (const c of [...(o.headers || []), ...(o.rows || []).flat()]) {
        if (estimateLines(c, cellFs, colW) > 2) overflow++;
      }
      if (overflow > 0) add('warn', `表格有 ${overflow} 个单元格文字过长（超过 2 行）`);
    }
  }
  return warnings;
}

// 内容级校验（不依赖场景图）：模板字数约束 / 必填字段，供首页门禁反馈给模型
function validateSlideContent(slide, constraints, index) {
  const warnings = [];
  const add = (level, message) => warnings.push({ index, level, message });
  const chars = constraints || {};
  const over = (v, limit, what) => {
    if (typeof v === 'string' && limit && v.length > limit) {
      add('warn', `${what}「${v.slice(0, 12)}…」${v.length} 字超过建议上限 ${limit} 字`);
    }
  };
  if (slide.title) over(slide.title, chars.pageTitle, '页面标题');
  if (slide.subtitle) over(slide.subtitle, chars.subtitle, '副标题');
  if (slide.conclusion) over(slide.conclusion, chars.conclusion, '结论句');
  if (slide.quote) over(slide.quote, chars.quote, '金句');
  for (const b of slide.bullets || []) over(b, chars.bullet, '要点');
  for (const b of [...(slide.leftBullets || []), ...(slide.rightBullets || [])]) over(b, chars.bullet, '两栏要点');
  for (const st of slide.steps || []) {
    over(st.title, chars.cardTitle, '步骤名');
    over(st.desc, chars.stepDesc, '步骤描述');
  }
  for (const st of slide.stats || []) over(st.label, 12, '数字标签');
  for (const c of [...(slide.headers || []), ...(slide.rows || []).flat()]) over(c, chars.tableCell, '表格单元格');

  if ((slide.type === 'bullets' || slide.type === 'twoColumn') && !(slide.bullets || []).length
    && !(slide.leftBullets || []).length) {
    add('error', '要点页没有任何要点内容');
  }
  if (slide.type === 'table' && !(slide.rows || []).length) {
    add('error', '表格页没有任何数据行');
  }
  if (slide.type === 'steps' && (slide.steps || []).length < 2) {
    add('warn', '流程页步骤少于 2 步');
  }
  if (slide.type === 'stats' && (slide.stats || []).length < 2) {
    add('warn', '关键数字页少于 2 个数字');
  }
  if (slide.type === 'quote' && !slide.quote) {
    add('error', '金句页缺少 quote 字段');
  }
  return warnings;
}

// 组合入口：返回该页全部 warnings（scene 级 + 内容级）
function validateSlide({ slide, scene, canvas, constraints, index }) {
  return [
    ...validateSlideContent(slide, constraints, index),
    ...validateScene(scene, canvas, index),
  ];
}

module.exports = { validateScene, validateSlideContent, validateSlide, textWidthIn, estimateLines, textHeightIn };
