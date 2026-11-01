import { api } from './api';
import type { Department } from './types';
import { useQuery } from './use-query';

export function useDepartments() {
  const q = useQuery('departments', () => api<{ items: Department[] }>('/departments'));
  const items = q.data?.items ?? null;
  return { items, error: q.error, reload: q.reload, active: items?.filter((d) => d.isActive) ?? [] };
}
