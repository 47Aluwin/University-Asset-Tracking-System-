import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from './api';

type Loaded<T> = { key: string; request: string; data: T | null; error: string | null };

/**
 * Loads data whenever `key` changes, and again on reload().
 * - `data` is only returned for the current key, so switching filters never shows the old filter's rows.
 * - Responses that arrive after a newer request started are ignored.
 * - During a reload of the same key the previous data stays visible and `loading` is true.
 */
export function useQuery<T>(key: string, fetcher: () => Promise<T>) {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const request = `${key}#${nonce}`;

  useEffect(() => {
    let current = true;
    fetcherRef.current().then(
      (data) => current && setLoaded({ key, request, data, error: null }),
      (e) => current && setLoaded((prev) => ({ key, request, data: prev?.key === key ? prev.data : null, error: errorMessage(e) })),
    );
    return () => {
      current = false;
    };
  }, [key, request]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const sameKey = loaded?.key === key;
  return {
    data: sameKey ? loaded!.data : null,
    error: loaded?.request === request ? loaded.error : null,
    loading: loaded?.request !== request,
    reload,
  };
}
