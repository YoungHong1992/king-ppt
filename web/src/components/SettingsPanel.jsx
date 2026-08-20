import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { NAV } from './settings/ui.jsx';
import { useAppDialog, AppDialogHost } from './AppDialog.jsx';
import ServicesView from './settings/ServicesView.jsx';
import DefaultsView from './settings/DefaultsView.jsx';

// 多供应商模型设置面板：左导航（模型服务 / 默认模型）+ 右内容区。
// 数据源单一：GET /api/providers 一次性拿 { capabilities, capabilityLabels, templates, instances, active }；
// 任何增删改后调 reload() 重新拉取并经 onProvidersChange 通知 App 刷新模型状态 / model-chip。
// 密钥「只出不进」：实例只回 hasKey + keyPreview 掩码，明文永不回传。
export default function SettingsPanel({ onClose, onProvidersChange, flash }) {
  const [data, setData] = useState(null);
  const [view, setView] = useState('services');
  const [loadErr, setLoadErr] = useState(null);
  const dialog = useAppDialog();

  const reload = useCallback(async () => {
    const d = await api.getProviders();
    setData(d);
    if (onProvidersChange) onProvidersChange(d);
    return d;
  }, [onProvidersChange]);

  useEffect(() => { reload().catch((e) => setLoadErr(e.message)); }, [reload]);

  const instances = data?.instances || [];
  const hasChat = !!data?.active?.chat;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-title">模型设置</div>
          <div className="settings-nav-items">
            {NAV.map((n) => (
              <button
                key={n.key}
                className={`nav-item${view === n.key ? ' active' : ''}`}
                onClick={() => setView(n.key)}
              >
                <span className="nav-item-ico">{n.icon}</span>
                <span className="nav-item-label">{n.label}</span>
                <span className={`nav-state${(n.key === 'services' ? instances.length > 0 : hasChat) ? ' configured' : ''}`} />
              </button>
            ))}
          </div>
          <div className="settings-nav-foot">API Key 仅保存在本机<br />配置自动保存</div>
        </aside>

        <div className="settings-main">
          <div className="settings-main-header">
            <h3>{NAV.find((n) => n.key === view)?.label}</h3>
            <button className="modal-x" title="关闭" onClick={onClose}>✕</button>
          </div>
          <div className="settings-body">
            {loadErr ? (
              <div className="settings-msg error">加载失败：{loadErr}</div>
            ) : !data ? (
              <div className="settings-msg">加载中…</div>
            ) : view === 'services' ? (
              <ServicesView data={data} reload={reload} flash={flash} ask={dialog.ask} />
            ) : (
              <DefaultsView data={data} reload={reload} flash={flash} onGoServices={() => setView('services')} />
            )}
          </div>
        </div>
      </div>
      <AppDialogHost dialog={dialog} />
    </div>
  );
}
