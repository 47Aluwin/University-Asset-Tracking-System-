// Fetches an exported report (PDF or Excel) with the user's token. Errors carry the server's message,
// e.g. "This report would contain 25,000 assets … Narrow the filters".
import { API_URL, ApiError, getApiToken } from './api';

export type ReportFormat = 'pdf' | 'xlsx';

const TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export async function fetchReportFile(path: string, query: Record<string, string | undefined>, format: ReportFormat) {
  const qs = Object.entries({ ...query, format })
    .filter(([, v]) => v)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const token = getApiToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? `Export failed (${res.status}).`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const today = new Date().toISOString().slice(0, 10);
  return { bytes, fileName: name ?? `${path.split('/').pop()}-${today}.${format}`, contentType: TYPES[format] };
}
