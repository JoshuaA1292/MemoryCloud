const rawBase = (import.meta.env.VITE_API_BASE_URL || '').trim();
const normalizedBase = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase;

const apiBase = normalizedBase
  ? normalizedBase.endsWith('/api')
    ? normalizedBase
    : `${normalizedBase}/api`
  : 'http://127.0.0.1:8080/api';

export const API_BASE = apiBase;
