// 全局 toast：轻量单例事件总线（无需 store 依赖）
export interface ToastItem {
  id: number;
  msg: string;
  err: boolean;
}

type Listener = (t: ToastItem) => void;
const listeners = new Set<Listener>();
let seq = 0;

/** 返回 push 函数：toast('消息', 是否错误) */
export function useToast() {
  return (msg: string, isErr = false) => {
    const t: ToastItem = { id: ++seq, msg, err: isErr };
    listeners.forEach((l) => l(t));
  };
}

/** ToastHost 内部使用：订阅 + 返回退订函数 */
export function onToast(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
