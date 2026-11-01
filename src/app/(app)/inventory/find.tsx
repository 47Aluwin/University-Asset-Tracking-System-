import { router } from 'expo-router';
import { useState } from 'react';

import { Body, Button, Card, Field, Heading, Notice, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { Asset } from '@/lib/types';
import { parseScannedCode } from '@shared/asset-codes';

/** Open an asset from the code on its label. Camera scanning is added in Phase 3; this is the typed fallback. */
export default function FindAsset() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const find = async () => {
    setError(null);
    if (!parseScannedCode(code)) return setError('Enter an asset ID like UAT-2026-000123 (printed under the QR code).');
    setBusy(true);
    try {
      const a = await api<Asset>('/assets/lookup', { query: { code } });
      router.replace({ pathname: '/inventory/[id]', params: { id: a.id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>Find by asset code</Heading>
      <Body muted>Type the asset ID printed under the QR code on the label.</Body>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        <Field label="Asset ID" value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="UAT-2026-000123" onSubmitEditing={find} />
        <Button title="Open asset" onPress={find} loading={busy} />
      </Card>
    </Screen>
  );
}
