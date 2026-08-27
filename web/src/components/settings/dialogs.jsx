import React, { useState, useEffect } from 'react';
import { api } from '../../api.js';

// 从接口拉取模型：POST remote-models → 多选（已存在的禁选）→ 逐个 addModel(默认 chat 能力)。
export function ModelPickerDialog({ inst, reload, flash, onClose }) {
  const [loading, setLoading] = useState(true);
  const [ids, setIds] = useState([]);
  const [existing, setExisting] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.remoteModels(inst.id).then((r) => {
      if (!alive) return;
      setIds(r.ids || []);
      setExisting(new Set(r.existing || []));
      if (r.suggestedBaseURL) flash(`实际可用地址为 ${r.suggestedBaseURL}，可在服务地址栏一键采用`, 'ok');
    }).catch((e) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [inst.id, flash]);

  const shown = ids.filter((id) => id.toLowerCase().includes(search.toLowerCase()));
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelected(new Set(shown.filter((id) => !existing.has(id))));
  const clear = () => setSelected(new Set());

  const addSelected = async () => {
    setAdding(true);
    try {
      for (const id of selected) await api.addModel(inst.id, id, ['chat']);
      await reload();
      flash(`已添加 ${selected.size} 个模型（默认标记为文本能力，可在列表中开关多模态/生图）`, 'ok');
      onClose();
    } catch (e) { flash(`添加失败：${e.message}`, 'error'); setAdding(false); }
  };

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>从「{inst.name}」拉取模型</span>
          <span className="picker-count">{selected.size ? `已选 ${selected.size} 个` : ''}</span>
        </div>
        <input className="field-input" placeholder="搜索模型…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="picker-list">
          {loading ? <div className="picker-msg">正在拉取模型列表…</div>
            : err ? <div className="picker-msg error">{err}</div>
            : shown.length === 0 ? <div className="picker-msg">未匹配到模型</div>
            : shown.map((id) => {
              const added = existing.has(id);
              return (
                <label key={id} className={`picker-row${added ? ' added' : ''}`}>
                  <input type="checkbox" disabled={added} checked={added || selected.has(id)} onChange={() => toggle(id)} />
                  <span className="picker-row-id">{id}</span>
                  {added ? <span className="picker-added">已添加</span> : null}
                </label>
              );
            })}
        </div>
        <div className="picker-foot">
          <button className="btn btn-sm" onClick={selectAll}>全选</button>
          <button className="btn btn-sm" onClick={clear}>清空</button>
          <span className="picker-foot-spacer" />
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button className="btn btn-primary btn-sm" disabled={adding || selected.size === 0} onClick={addSelected}>
            {adding ? '添加中…' : '添加所选'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 测试模型：勾选可测模型（enabled 且含 chat/vision）→ 逐个 testModel，实时显示状态。
export function ModelTestDialog({ inst, reload, flash, onClose }) {
  const testable = (m) => m.enabled !== false && (m.caps.includes('chat') || m.caps.includes('vision'));
  const [selected, setSelected] = useState(() => new Set(inst.models.filter(testable).map((m) => m.id)));
  const [statuses, setStatuses] = useState({}); // id -> {state:'run'|'ok'|'fail', error?}
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const run = async () => {
    setRunning(true);
    for (const id of selected) {
      setStatuses((s) => ({ ...s, [id]: { state: 'run' } }));
      try {
        const r = await api.testModel(inst.id, id);
        setStatuses((s) => ({ ...s, [id]: r.ok ? { state: 'ok' } : { state: 'fail', error: r.error } }));
      } catch (e) {
        setStatuses((s) => ({ ...s, [id]: { state: 'fail', error: e.message } }));
      }
    }
    await reload();
    setRunning(false); setDone(true);
    flash('模型测试完成', 'ok');
  };

  const stLabel = (st) => st?.state === 'run' ? '⟳ 测试中…' : st?.state === 'ok' ? '✓ 通过' : st?.state === 'fail' ? '✕ 失败' : '';

  return (
    <div className="picker-overlay" onClick={() => !running && onClose()}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head"><span>测试「{inst.name}」的模型</span></div>
        <div className="picker-list">
          {inst.models.length === 0 ? <div className="picker-msg">暂无模型可测试</div>
            : inst.models.map((m) => {
              const ok = testable(m);
              const st = statuses[m.id];
              return (
                <label key={m.id} className={`picker-row${ok ? '' : ' added'}`}>
                  <input type="checkbox" disabled={!ok || running} checked={ok && selected.has(m.id)} onChange={() => toggle(m.id)} />
                  <span className="picker-row-id">{m.id}</span>
                  <span className={`picker-test-status ${st?.state || ''}`} title={st?.error || ''}>
                    {ok ? stLabel(st) : (m.enabled === false ? '已停用' : '生图模型不参与实测')}
                  </span>
                </label>
              );
            })}
        </div>
        <div className="picker-foot">
          <span className="picker-foot-spacer" />
          <button className="btn btn-sm" disabled={running} onClick={onClose}>{done ? '完成' : '取消'}</button>
          <button className="btn btn-primary btn-sm" disabled={running || selected.size === 0} onClick={run}>
            {running ? '测试中…' : '开始测试'}
          </button>
        </div>
      </div>
    </div>
  );
}
