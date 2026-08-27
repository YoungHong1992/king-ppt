import React, { useState } from 'react';
import { api } from '../../api.js';
import { Switch, CAP_META } from './ui.jsx';
import { ModelPickerDialog, ModelTestDialog } from './dialogs.jsx';

// 单个模型行：能力 chip（chat/vision/image）+ 验证状态 + 启用开关 + 删除。
function ModelRow({ instId, model, reload, flash, ask }) {
  const setCaps = async (caps, enabled) => {
    try { await api.addModel(instId, model.id, caps, enabled); await reload(); }
    catch (e) { flash(`操作失败：${e.message}`, 'error'); }
  };
  const toggleCap = (cap) => {
    const next = model.caps.includes(cap) ? model.caps.filter((c) => c !== cap) : [...model.caps, cap];
    if (next.length === 0) { flash('模型至少保留一种能力', 'error'); return; }
    setCaps(next, model.enabled);
  };
  const remove = async () => {
    const ok = await ask({ title: '删除模型', body: `确定删除模型「${model.id}」？`, okText: '删除', danger: true });
    if (!ok) return;
    try { await api.removeModel(instId, model.id); await reload(); }
    catch (e) { flash(`删除失败：${e.message}`, 'error'); }
  };

  let status = { cls: 'off', text: '○ 未验证', title: '尚未实测，点右上角「测试模型」验证' };
  if (model.enabled === false) status = { cls: 'off', text: '● 停用', title: '' };
  else if (model.lastTest === 'ok') status = { cls: 'ok', text: '● 已验证', title: '已通过真实收发测试' };
  else if (model.lastTest === 'fail') status = { cls: 'fail', text: '✕ 验证失败', title: model.lastError || '' };

  return (
    <div className={`models-tr${model.enabled === false ? ' disabled' : ''}`}>
      <div className="model-name">
        <span className="model-id" title={model.id}>{model.id}</span>
        <span className="model-attrs">
          {['chat', 'vision', 'image'].map((cap) => (
            <button
              key={cap}
              className={`cap-chip${model.caps.includes(cap) ? ' on' : ''}`}
              title={`点击开关「${CAP_META[cap]}」能力`}
              onClick={() => toggleCap(cap)}
            >{CAP_META[cap]}</button>
          ))}
        </span>
      </div>
      <div className="model-side">
        <span className={`model-status ${status.cls}`} title={status.title}>{status.text}</span>
        <Switch checked={model.enabled !== false} onChange={(v) => setCaps(model.caps, v)} />
        <button className="cap-toggle danger" title="删除模型" onClick={remove}>🗑</button>
      </div>
    </div>
  );
}

// 实例详情：名称/baseURL/apiKey 编辑（name/baseURL 失焦自动存；apiKey 只出不进，通过测试或点保存才落盘）
// + URL 补全建议 + 模型表 + 拉取/测试模型弹窗。以 key={inst.id} 挂载，故本地 state 直接取 inst 初值。
export default function InstanceDetail({ inst, tpl, reload, flash, ask, onDeleted }) {
  const locked = inst.preset !== 'custom'; // 官方渠道 name/baseURL 锁定
  const [name, setName] = useState(inst.name || '');
  const [baseURL, setBaseURL] = useState(inst.baseURL || '');
  const [apiKey, setApiKey] = useState(''); // 空=不改
  const [suggest, setSuggest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [showTest, setShowTest] = useState(false);

  const saveField = async (patch) => {
    try { await api.updateInstance(inst.id, patch); await reload(); }
    catch (e) { flash(`保存失败：${e.message}`, 'error'); }
  };

  const onNameBlur = () => { if (!locked && name.trim() && name !== inst.name) saveField({ name: name.trim() }); };
  const onBaseBlur = () => { if (!locked && baseURL.trim() && baseURL !== inst.baseURL) saveField({ baseURL: baseURL.trim() }); };

  const saveKey = async () => {
    if (!apiKey.trim()) { flash('请先填写 API Key', 'error'); return; }
    try { await api.updateInstance(inst.id, { apiKey: apiKey.trim() }); setApiKey(''); await reload(); flash('已保存 API Key', 'ok'); }
    catch (e) { flash(`保存失败：${e.message}`, 'error'); }
  };

  const doTest = async () => {
    setTesting(true); setSuggest(null);
    try {
      const override = {};
      if (baseURL.trim()) override.baseURL = baseURL.trim();
      if (apiKey.trim()) override.apiKey = apiKey.trim();
      const r = await api.testInstance(inst.id, override);
      if (r.suggestedBaseURL && r.suggestedBaseURL !== baseURL) setSuggest(r.suggestedBaseURL);
      // 通过且填了新 Key：落盘（「通过才存」）
      if (apiKey.trim()) { await api.updateInstance(inst.id, { apiKey: apiKey.trim() }); setApiKey(''); }
      await reload();
      flash('连接成功', 'ok');
    } catch (e) {
      flash(`连接失败：${e.message}`, 'error');
    } finally { setTesting(false); }
  };

  const adoptSuggest = async () => {
    try { await api.updateInstance(inst.id, { baseURL: suggest }); setBaseURL(suggest); setSuggest(null); await reload(); flash('服务地址已更新', 'ok'); }
    catch (e) { flash(`更新失败：${e.message}`, 'error'); }
  };

  const addModel = async () => {
    const id = newModel.trim();
    if (!id) return;
    try { await api.addModel(inst.id, id, ['chat']); setNewModel(''); await reload(); }
    catch (e) { flash(`添加失败：${e.message}`, 'error'); }
  };

  const removeInstance = async () => {
    const ok = await ask({ title: '删除供应商', body: `确定删除「${inst.name}」及其下所有模型？`, okText: '删除', danger: true });
    if (!ok) return;
    try { await api.deleteInstance(inst.id); if (onDeleted) onDeleted(); await reload(); flash('已删除', 'ok'); }
    catch (e) { flash(`删除失败：${e.message}`, 'error'); }
  };

  return (
    <div className="inst-detail">
      {suggest ? (
        <div className="url-suggest">
          实际可用地址为 <code>{suggest}</code>（已自动补全路径）
          <button className="btn btn-primary btn-sm" onClick={adoptSuggest}>一键采用</button>
          <button className="url-suggest-x" onClick={() => setSuggest(null)}>✕</button>
        </div>
      ) : null}

      <div className="field-row">
        <div>
          <label className="field-label">名称</label>
          <input className="field-input" value={name} disabled={locked} title={locked ? '官方渠道，不可更改' : ''}
            onChange={(e) => setName(e.target.value)} onBlur={onNameBlur} />
        </div>
        <div>
          <label className="field-label">服务地址（Base URL）</label>
          <input className="field-input" value={baseURL} disabled={locked} placeholder="https://..." title={locked ? '官方渠道，不可更改' : ''}
            onChange={(e) => setBaseURL(e.target.value)} onBlur={onBaseBlur} />
        </div>
        <div>
          <label className="field-label">
            API Key {inst.hasKey ? <span className="key-ok">✓</span> : null}
            {tpl?.keyUrl ? <a className="key-geturl" href={tpl.keyUrl} target="_blank" rel="noreferrer">获取 Key →</a> : null}
          </label>
          <div className="key-input-wrap">
            <input className="field-input key-secret" type="text" autoComplete="off" autoCorrect="off" spellCheck={false}
              placeholder={inst.noKey ? '本地服务，无需 Key' : (inst.hasKey ? `已保存 ${inst.keyPreview}（留空不改）` : 'sk-...')}
              disabled={inst.noKey} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            {apiKey.trim() ? <button className="key-save-btn" title="保存 Key" onClick={saveKey}>✓</button> : null}
          </div>
        </div>
      </div>

      <div className="inst-actions">
        <button className="btn btn-danger-ghost btn-sm" onClick={removeInstance}>删除供应商</button>
        <span className="inst-actions-spacer" />
        <button className="btn btn-sm" disabled={testing} onClick={doTest}>{testing ? '测试中…' : '测试连接'}</button>
      </div>

      <div className="models-header">
        <span className="models-title">模型列表（{inst.models.length}）</span>
        <span className="models-header-spacer" />
        <button className="btn btn-sm" onClick={() => setShowPicker(true)}>拉取模型</button>
        <button className="btn btn-sm" disabled={inst.models.length === 0} onClick={() => setShowTest(true)}>测试模型</button>
      </div>
      <div className="models-add">
        <input className="field-input" placeholder="输入模型名，如 deepseek-chat，回车添加" value={newModel}
          onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addModel(); }} />
        <button className="btn btn-sm" onClick={addModel}>＋ 添加</button>
      </div>
      <div className="models-table">
        <div className="models-th"><span>模型名称 / 能力（点击开关）</span><span>状态 · 启用 · 删除</span></div>
        {inst.models.length === 0 ? (
          <div className="models-empty">暂无模型，手动添加或从接口拉取</div>
        ) : (
          inst.models.map((m) => <ModelRow key={m.id} instId={inst.id} model={m} reload={reload} flash={flash} ask={ask} />)
        )}
      </div>

      {showPicker ? <ModelPickerDialog inst={inst} reload={reload} flash={flash} onClose={() => setShowPicker(false)} /> : null}
      {showTest ? <ModelTestDialog inst={inst} reload={reload} flash={flash} onClose={() => setShowTest(false)} /> : null}
    </div>
  );
}
