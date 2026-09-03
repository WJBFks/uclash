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
