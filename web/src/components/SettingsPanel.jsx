import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// 单 provider 模型设置面板：baseURL / apiKey / model + 测试连接 + 保存。
// 密钥「只出不进」：拉配置只得 hasKey + 掩码；apiKey 输入留空 = 保留原值（不重发 key）。
export default function SettingsPanel({ onClose, onSaved, flash }) {
  const [cfg, setCfg] = useState(null);      // publicView: {baseURL, model, hasKey, keyPreview, source}
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');  // 空 = 不修改
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggest, setSuggest] = useState(null); // suggestedBaseURL

  useEffect(() => {
    api.getConfig().then((v) => {
      setCfg(v);
      setBaseURL(v.baseURL || '');
      setModel(v.model || '');
    }).catch(() => {});
  }, []);

  const doTest = async () => {
    setTesting(true); setSuggest(null);
    try {
      const r = await api.testConfig({ baseURL, apiKey }); // 空 apiKey → 后端回退已存 key
      if (r.suggestedBaseURL && r.suggestedBaseURL !== baseURL) {
        setSuggest(r.suggestedBaseURL);
        flash && flash('连接成功（发现更合适的地址）', 'ok');
      } else {
        flash && flash('连接成功', 'ok');
      }
    } catch (e) {
      flash && flash(`连接失败：${e.message}`, 'error');
    } finally {
      setTesting(false);
    }
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const patch = { baseURL, model };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      const v = await api.saveConfig(patch);
      setCfg(v); setApiKey('');
      onSaved && onSaved(v);
      flash && flash('已保存', 'ok');
      onClose && onClose();
    } catch (e) {
      flash && flash(`保存失败：${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>模型设置</span>
          <button className="modal-x" title="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <label className="field-label">服务地址（Base URL）</label>
          <input
            className="field-input"
            placeholder="https://api.openai.com/v1"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
          />
          {suggest ? (
            <div className="field-hint">
              实际可用地址为 {suggest}
              <button className="link-btn" onClick={() => { setBaseURL(suggest); setSuggest(null); }}>一键采用</button>
            </div>
          ) : null}

          <label className="field-label">API Key</label>
          <input
            className="field-input"
            type="password"
            placeholder={cfg?.hasKey ? `已保存 ${cfg.keyPreview}（留空则不修改）` : 'sk-...'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {cfg?.source === 'env' ? <div className="field-hint">当前 Key 来自环境变量 OPENAI_API_KEY</div> : null}

          <label className="field-label">模型</label>
          <input
            className="field-input"
            placeholder="gpt-4o-mini"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />

          <div className="field-note">
            兼容任意 OpenAI 风格的 /chat/completions 端点。密钥仅保存在本机 config.json，绝不回传明文、不入库。
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" disabled={testing} onClick={doTest}>{testing ? '测试中…' : '测试连接'}</button>
          <button className="btn btn-primary" disabled={saving} onClick={doSave}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
