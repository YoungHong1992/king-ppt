import { useState, useEffect, useRef, useCallback } from 'react';

// 全站通用受控对话框（取代浏览器原生 confirm/prompt，统一风格、便于美化）。
// 用法：const dialog = useAppDialog(); const ok = await dialog.ask({ title, body?, okText?, cancelText?, danger?, input? });
//   - 确认模式：resolve(true) / resolve(false)
//   - 输入模式（传 input:{placeholder?,value?}）：resolve(trim 文本) / 取消 resolve(null)
// 在组件树顶层渲染一次 <AppDialogHost dialog={dialog} />。
export function useAppDialog() {
  const [state, setState] = useState(null);
  const resolveRef = useRef(null);
  const ask = useCallback((opts) => new Promise((resolve) => {
    resolveRef.current = resolve;
    setState({ okText: '确定', cancelText: '取消', danger: false, input: null, ...opts });
  }), []);
  const close = useCallback((val) => {
    setState(null);
    const r = resolveRef.current; resolveRef.current = null;
    if (r) r(val);
  }, []);
  return { state, ask, close };
}

export function AppDialogHost({ dialog }) {
  const { state, close } = dialog;
  const [val, setVal] = useState('');
  useEffect(() => { setVal(state?.input?.value || ''); }, [state]);
  if (!state) return null;
  const isInput = !!state.input;
  const cancelVal = isInput ? null : false;
  const submit = () => {
    if (isInput) { const t = val.trim(); if (!t) return; close(t); }
    else close(true);
  };
  return (
    <div className="dialog-overlay" onClick={() => close(cancelVal)}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{state.title}</div>
        {state.body ? <div className="dialog-msg">{state.body}</div> : null}
        {isInput ? (
          <input
            className="field-input" autoFocus
            placeholder={state.input.placeholder || ''}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(null); }}
          />
        ) : null}
        <div className="dialog-foot">
          <button className="btn" onClick={() => close(cancelVal)}>{state.cancelText}</button>
          <button className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} onClick={submit}>{state.okText}</button>
        </div>
      </div>
    </div>
  );
}
