import React from 'react';
import { api } from '../../api.js';

// 「默认模型」视图：只两组——文本(chat) / 生图(image)。vision 由后端回退 chat，不单独设。
// 每组一个下拉，选中即 setActive；chat 组绑定前对未验证模型做一次实测（image 生图调用即扣费，跳过实测）。
const GROUPS = [
  { cap: 'chat', title: '文本与多模态', badge: '推荐', desc: '生成大纲、修改指令；具备识图能力的模型可同时理解图片', pick: (m) => m.caps.includes('chat') },
  { cap: 'image', title: '图像生成', badge: '', desc: '为封面与关键页面生成匹配模板的插画', pick: (m) => m.caps.includes('image') },
];

export default function DefaultsView({ data, reload, flash, onGoServices }) {
  const { instances, active } = data;

  const optionsFor = (pick) => instances
    .filter((inst) => inst.enabled !== false)
    .flatMap((inst) => inst.models
      .filter((m) => m.enabled !== false && pick(m))
      .map((m) => ({
        value: `${inst.id}|||${m.id}`,
        instId: inst.id, model: m.id, instanceName: inst.name,
        vision: m.caps.includes('vision'), lastTest: m.lastTest,
        label: `${inst.name} · ${m.id}${m.caps.includes('vision') ? ' 👁' : ''}${m.lastTest === 'ok' ? ' ✓' : ''}`,
      })));

  const bind = async (cap, opt) => {
    if (!opt) return;
    try {
      if (cap !== 'image' && opt.lastTest !== 'ok') {
        const r = await api.testModel(opt.instId, opt.model);
        if (!r.ok) { flash(`模型验证失败：${r.error}`, 'error'); await reload(); return; }
        if (r.suggestedBaseURL) flash(`验证通过。实际可用地址为 ${r.suggestedBaseURL}，可到「模型服务」一键更新`, 'ok');
      }
      await api.setActive(cap, opt.instId, opt.model);
      await reload();
      flash('默认模型已更新', 'ok');
    } catch (e) { flash(`绑定失败：${e.message}`, 'error'); }
  };

  return (
    <div className="def-wrap">
      {GROUPS.map((g) => {
        const options = optionsFor(g.pick);
        const cur = active[g.cap];
        const curValue = cur && cur.instance ? `${cur.instance}|||${cur.model}` : '';
        return (
          <div key={g.cap} className="def-card">
            <div className="def-card-head">
              <span className="def-card-icon">{g.cap === 'chat' ? '💬' : '🖼️'}</span>
              <span className="def-card-title">{g.title}</span>
              {g.badge ? <span className="def-card-badge">{g.badge}</span> : null}
            </div>
            <div className="def-card-desc">{g.desc}</div>
            {options.length === 0 ? (
              <div className="def-empty">
                <div>暂无可用模型</div>
                <button className="btn btn-sm" onClick={onGoServices}>＋ 去添加供应商</button>
              </div>
            ) : (
              <select
                className="def-select"
                value={curValue}
                onChange={(e) => bind(g.cap, options.find((o) => o.value === e.target.value))}
              >
                <option value="">请选择模型</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {cur && cur.instance === null ? <div className="def-envhint">当前由环境变量 OPENAI_API_KEY 兜底：{cur.instanceName} · {cur.model}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
