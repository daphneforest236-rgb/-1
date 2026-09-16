/**
 * Small client for a compatible NetEase Cloud Music API service.
 * This copy is intentionally kept inside this project so the connector does
 * not import code from a user-specific Desktop path.
 */
export class ApiClient {
  constructor({ baseURL = 'http://localhost:3000', cookie = '' } = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.cookie = cookie;
  }

  async get(endpoint, params = {}) {
    const url = new URL(endpoint, this.baseURL);
    const finalParams = { ...params, timestamp: Date.now() };
    if (this.cookie) finalParams.cookie = this.cookie;
    for (const [key, value] of Object.entries(finalParams)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error(`无法连接网易云 API 服务（${this.baseURL}）。请先启动 npm run api。`);
    }
    if (!res.ok) throw new Error(`网易云 API 返回 HTTP ${res.status}：${url.pathname}`);
    const data = await res.json();
    if (data?.code === 301) throw new Error('网易云 API 要求重新登录。请重新扫码。');
    return data;
  }
}
