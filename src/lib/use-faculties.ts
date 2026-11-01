import { api } from './api';
import type { Faculty } from './types';
import { useQuery } from './use-query';

/** Faculties in the university's order (administrators also see inactive ones). */
export function useFaculties() {
  const q = useQuery('faculties', () => api<{ items: Faculty[] }>('/faculties'));
  const items = q.data?.items ?? null;
  return { items, error: q.error, reload: q.reload, active: items?.filter((f) => f.isActive) ?? [] };
}
