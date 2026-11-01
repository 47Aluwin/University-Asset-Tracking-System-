import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';

import { QrScanner } from '@/components/qr-scanner';
import { Badge, Body, Button, Card, Field, Heading, Notice, Row, Screen } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { MISSING_LABELS, VERIFICATION_LABELS, verificationTone } from '@/lib/asset-display';
import type { Asset } from '@/lib/types';
import { parseScannedCode } from '@shared/asset-codes';

/** Scan (or type) an asset code, check it is the right asset, then verify, relocate or open it. */
export default function Scan() {
  const t = useTheme();
  const [focused, setFocused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ asset: Asset; method: 'scan' | 'manual' } | null>(null);

  // Only one camera preview can run at a time: stop it when this screen is not showing.
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const lookup = async (id: string, method: 'scan' | 'manual') => {
    setError(null);
    setBusy(true);
    try {
      setFound({ asset: await api<Asset>('/assets/lookup', { query: { code: id } }), method });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const typed = () => {
    const id = parseScannedCode(code);
    if (!id) return setError('Enter an asset ID like UAT-2026-000123 (printed under the QR code).');
    lookup(id, 'manual');
  };

  if (found) {
    const a = found.asset;
    return (
      <Screen>
        <Heading>Is this the asset?</Heading>
        <Card>
          <Heading level={2}>{a.name}</Heading>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 17, fontWeight: '700', color: t.text }}>
            {a.institutionalId}
          </Text>
          <Body muted>
            Recorded at {a.location.building}, {a.location.room} · {a.department.name}
          </Body>
          <Body muted>
            {a.category.name}
            {a.manufacturer ? ` · ${a.manufacturer}` : ''}
            {a.model ? ` ${a.model}` : ''} {a.serialNumber ? ` · Serial ${a.serialNumber}` : ''}
          </Body>
          <Row>
            <Badge label={VERIFICATION_LABELS[a.verification.status]} tone={verificationTone(a.verification.status)} />
            {a.missing.status !== 'none' ? <Badge label={MISSING_LABELS[a.missing.status]} tone="bad" /> : null}
            {a.archived ? <Badge label="Archived" tone="neutral" /> : null}
          </Row>
        </Card>
        {a.registrationStatus !== 'registered' && !a.archived ? (
          <Notice kind="info">This asset’s registration is not complete yet, so it cannot be verified. Open it to finish the label step.</Notice>
        ) : null}
        <Row>
          {a.can.verify ? (
            <Button
              title="Yes — record that I can see it"
              onPress={() => router.push({ pathname: '/inventory/[id]/verify', params: { id: a.id, method: found.method } })}
            />
          ) : null}
          {a.can.move ? <Button title="Relocate" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]/move', params: { id: a.id } })} /> : null}
          <Button title="Open details" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: a.id } })} />
        </Row>
        <Row>
          <Button
            title="Scan a different asset"
            variant="secondary"
            onPress={() => {
              setFound(null);
              setCode('');
            }}
          />
        </Row>
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>Scan asset</Heading>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <QrScanner active={focused && !busy} onAssetCode={(id) => lookup(id, 'scan')} />
      <Card>
        <Field
          label="Or type the asset ID"
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          placeholder="UAT-2026-000123"
          onSubmitEditing={typed}
        />
        <Button title="Find asset" variant="secondary" onPress={typed} loading={busy} />
      </Card>
    </Screen>
  );
}
