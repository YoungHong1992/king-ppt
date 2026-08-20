import React from 'react';

// 多供应商设置面板的公共件：常量、头像、开关、掩码。
// （受控对话框已提为全站通用组件，见 components/AppDialog.jsx）

// 左导航两视图
export const NAV = [
  { key: 'services', label: '模型服务', icon: '🗄️' },
  { key: 'defaults', label: '默认模型', icon: '🎯' },
];

// 能力标签（仅 chat/vision/image 三个真实能力；后端 CAPABILITIES 已砍 video/music）
export const CAP_META = { chat: '文本', vision: '视觉', image: '生图' };

// 空状态推荐卡挑这三个模板
export const REC_IDS = ['kimi', 'minimax', 'ollama'];

// 前 4 + **** + 后 4；过短全掩。与后端 maskKey 一致。
export function maskKeyText(s) {
  const str = String(s || '');
  return str.length > 8 ? `${str.slice(0, 4)}****${str.slice(-4)}` : '****';
}

// 品牌色 + 缩写头像
export function Avatar({ tpl, name, size = 34 }) {
  const bg = tpl?.color || '#64748b';
  const text = tpl?.short || (name || '?').slice(0, 1);
  return (
    <span
      className="pv-avatar"
      style={{ background: bg, width: size, height: size, borderRadius: Math.round(size * 0.29), fontSize: Math.round(size * 0.44) }}
    >{text}</span>
  );
}

// 受控开关
export function Switch({ checked, onChange, disabled }) {
  return (
    <label className="switch-wrap">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
    </label>
  );
}
