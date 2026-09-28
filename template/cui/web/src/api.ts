const base = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export const api = {
  overview: () => req<any>('/overview'),
  milestones: () => req<any[]>('/milestones'),
  milestone: (key: string) => req<any>(`/milestones/${encodeURIComponent(key)}`),
  commits: (q = '', limit = 100) =>
    req<any[]>(`/commits?q=${encodeURIComponent(q)}&limit=${limit}`),
  commit: (sha: string) => req<any>(`/commits/${sha}`),
  fileAt: (sha: string, path: string) =>
    req<{ path: string; content: string }>(`/commits/${sha}/file?path=${encodeURIComponent(path)}`),
  walkthrough: (sha: string) => req<any>(`/commits/${sha}/walkthrough`),
  generateWalkthrough: (sha: string, force = false) =>
    req<any>(`/commits/${sha}/walkthrough`, { method: 'POST', body: JSON.stringify({ force }) }),
  questions: (sha: string) => req<any[]>(`/commits/${sha}/questions`),
  ask: (sha: string, payload: Record<string, unknown>) =>
    req<any>(`/commits/${sha}/questions`, { method: 'POST', body: JSON.stringify(payload) }),
  structure: () => req<any>('/structure'),
  commands: (q = '') => req<any[]>(`/commands?q=${encodeURIComponent(q)}`),
  search: (q: string) => req<any[]>(`/search?q=${encodeURIComponent(q)}`),
  health: () => req<any>('/health'),
  sync: () => req<any>('/sync', { method: 'POST' }),
}

export const demoFileUrl = (path: string) => `${base}/demo-file?path=${encodeURIComponent(path)}`
