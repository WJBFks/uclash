// 用户偏好（localStorage 共享 + 跨组件事件同步）
export const TEST_URL_KEY = 'cw_test_url';
export const PrefsEvent = 'cw-prefs-changed';
export const DEFAULT_TEST_URL = 'https://www.google.com/generate_204';

export function getTestUrl(): string {
  return localStorage.getItem(TEST_URL_KEY) || DEFAULT_TEST_URL;
}

export function setTestUrl(url: string) {
  localStorage.setItem(TEST_URL_KEY, url);
  window.dispatchEvent(new CustomEvent(PrefsEvent));
}

// ---- 代理组「显示组」筛选（单选/多选 + 勾选的组名列表）----
export const GROUP_FILTER_KEY = 'cw_group_filter';
export interface GroupFilterPref {
  mode: 'single' | 'multi';
  selected: string[];
}

export function getGroupFilter(): GroupFilterPref | null {
  try {
    const raw = localStorage.getItem(GROUP_FILTER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as GroupFilterPref;
    if (p && (p.mode === 'single' || p.mode === 'multi') && Array.isArray(p.selected)) return p;
    return null;
  } catch {
    return null;
  }
}

export function setGroupFilter(p: GroupFilterPref) {
  localStorage.setItem(GROUP_FILTER_KEY, JSON.stringify(p));
}
