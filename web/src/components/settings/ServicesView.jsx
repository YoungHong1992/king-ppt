import React, { useState } from 'react';
import { api } from '../../api.js';
import { Avatar, Switch, REC_IDS } from './ui.jsx';
import InstanceDetail from './InstanceDetail.jsx';

// 「添加供应商」下拉（稳定组件——不可内联进 ServicesView，否则每次渲染重挂载）。
function AddMenu({ templates, open, setOpen, onAdd }) {
  return (
    <div className="svc-add">
      <button className="btn btn-primary btn-sm" onClick={() => setOpen((v) => !v)}>＋ 添加供应商</button>
      {open ? (
        <>
          <div className="dropdown-scrim" onClick={() => setOpen(false)} />
          <div className="svc-add-menu">
            {templates.map((t) => (
              <button key={t.id} className="svc-add-item" onClick={() => onAdd(t.id)}>
                <Avatar tpl={t} size={28} />
                <span className="svc-add-item-main">
                  <span className="svc-add-item-name">{t.name}</span>
                  <span className="svc-add-item-sub">{t.tagline}{t.id !== 'custom' && t.noKey ? ' · 无需 Key' : ''}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// 「模型服务」视图：无实例 → 空状态 + 推荐卡；有实例 → 手风琴列表（同时只展开一个）。
export default function ServicesView({ data, reload, flash, ask }) {
  const { templates, instances } = data;
  const [menuOpen, setMenuOpen] = useState(false);
  // 展开的实例：undefined=默认展开第一个，null=全收起，否则指定 id
  const [openId, setOpenId] = useState(undefined);
  const effectiveOpen = openId === undefined ? instances[0]?.id : openId;

  const tplOf = (preset) => templates.find((t) => t.id === preset) || null;

  const addProvider = async (tplId) => {
    setMenuOpen(false);
    let name;
    if (tplId === 'custom') {
      name = await ask({ title: '添加自定义供应商', input: { placeholder: '供应商名称，如：中转站A' }, okText: '创建' });
      if (!name) return;
    }
    try {
      const { id } = await api.createInstance({ preset: tplId, name });
      setOpenId(id);
      await reload();
      flash(tplId === 'custom' ? '已创建，请填写服务地址与 API Key' : '供应商已添加，请填写 API Key', 'ok');
    } catch (e) {
      flash(`添加失败：${e.message}`, 'error');
    }
  };

  if (instances.length === 0) {
    const recs = REC_IDS.map((id) => templates.find((t) => t.id === id)).filter(Boolean);
    return (
      <div className="svc-empty">
        <div className="svc-empty-hero">
          <div className="svc-empty-icon">🗄️</div>
          <div className="svc-empty-title">还没有添加任何模型供应商</div>
          <div className="svc-empty-sub">添加一个供应商、填入 API Key，即可让服务端自助生成内容大纲</div>
          <AddMenu templates={templates} open={menuOpen} setOpen={setMenuOpen} onAdd={addProvider} />
        </div>
        <div className="svc-rec-title">推荐供应商</div>
        <div className="svc-rec-grid">
          {recs.map((t) => (
            <div key={t.id} className="svc-rec-card">
              <Avatar tpl={t} size={40} />
              <div className="svc-rec-name">{t.name}</div>
              <div className="svc-rec-tagline">{t.tagline}</div>
              <span className="svc-rec-tag">{t.tag}</span>
              <button className="btn btn-sm" onClick={() => addProvider(t.id)}>＋ 添加</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const statusOf = (inst) => {
    if (inst.enabled === false) return { cls: 'off', text: '已停用' };
    if (inst.hasKey || inst.noKey) return { cls: 'ok', text: '可用' };
    return { cls: 'warn', text: '缺少 Key' };
  };

  const toggleOpen = (id) => {
    setOpenId((prev) => {
      const eff = prev === undefined ? instances[0]?.id : prev;
      return eff === id ? null : id;
    });
  };

  const toggleEnabled = async (inst, enabled) => {
    try { await api.updateInstance(inst.id, { enabled }); await reload(); }
    catch (e) { flash(`操作失败：${e.message}`, 'error'); }
  };

  return (
    <div className="svc-list-wrap">
      <div className="svc-topbar">
        <span className="svc-topbar-hint">点击供应商展开模型配置。状态：绿=可用，黄=缺 Key，灰=停用。</span>
        <AddMenu templates={templates} open={menuOpen} setOpen={setMenuOpen} onAdd={addProvider} />
      </div>
      <div className="acc-list">
        {instances.map((inst) => {
          const tpl = tplOf(inst.preset);
          const st = statusOf(inst);
          const open = effectiveOpen === inst.id;
          const hasVision = inst.models.some((m) => m.caps.includes('vision'));
          return (
            <div key={inst.id} className={`acc-item${open ? ' open' : ''}`}>
              <div className="acc-head" role="button" tabIndex={0}
                onClick={() => toggleOpen(inst.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(inst.id); } }}
              >
                <Avatar tpl={tpl} name={inst.name} />
                <div className="acc-head-main">
                  <div className="acc-name">{inst.name}</div>
                  <div className="acc-sub">
                    <span className={`acc-status ${st.cls}`}>● {st.text}</span>
                    {` · ${inst.models.length} 个模型`}{hasVision ? ' · 含多模态' : ''}
                  </div>
                </div>
                <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <Switch checked={inst.enabled !== false} onChange={(v) => toggleEnabled(inst, v)} />
                </span>
                <span className="acc-chevron">{open ? '▾' : '▸'}</span>
              </div>
              {open ? (
                <div className="acc-body">
                  <InstanceDetail key={inst.id} inst={inst} tpl={tpl} reload={reload} flash={flash} ask={ask} onDeleted={() => setOpenId(null)} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
