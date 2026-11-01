import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';

import { Checkbox } from '@/components/auth-card';
import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { api, errorMessage, newOperationId } from '@/lib/api';
import { action, perform } from '@/lib/offline';
import { useSession } from '@/lib/session';
import { VERIFICATION_LABELS, verificationTone } from '@/lib/asset-display';
import type { Asset, Location, Verification } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';

/** Record that an asset was physically seen: where, by whom, and when (now). */
export default function VerifyAsset() {
  const { id, method } = useLocalSearchParams<{ id: string; method?: string }>();
  const { user } = useSession();
  const [savedOffline, setSavedOffline] = useState(false);
  const asset = useQuery(`asset:${id}`, () => api<Asset>(`/assets/${id}`));
  const locations = useQuery('locations:readable', () => api<{ items: Location[] }>('/locations'));
  const departments = useDepartments();
  const [observed, setObserved] = useState<string | null>(null);
  const [alsoMove, setAlsoMove] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ verification: Verification; duplicate: boolean; asset: Asset } | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per attempt: if the connection drops after the server saved it, retrying does not record it twice.
  const operationId = useRef(newOperationId());

  const a = asset.data;
  const options = useMemo(() => {
    if (!a || !locations.data) return [];
    const deptName = (d: string) => departments.items?.find((x) => x.id === d)?.name ?? '';
    // The asset's own department first, then any other departments the user can see.
    return [...locations.data.items]
      .sort((x, y) => Number(y.departmentId === a.department.id) - Number(x.departmentId === a.department.id))
      .map((l) => ({
        value: l.id,
        label: `${l.building} · ${l.room}${l.departmentId !== a.department.id ? ` (${deptName(l.departmentId)})` : ''}${l.id === a.location.id ? ' — recorded location' : ''}`,
      }));
  }, [a, locations.data, departments.items]);

  if (asset.error && !a) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!a) return <Screen><Loading /></Screen>;
  const here = observed ?? a.location.id;
  const elsewhere = here !== a.location.id;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      // Sent now if there is a connection; otherwise saved on the phone with the time it happened, and sent later.
      const r = await perform(user!.id, [
        action({
          id: operationId.current,
          kind: 'verify',
          label: `Verify ${a.institutionalId} (${a.name})`,
          method: 'POST',
          path: `/assets/${a.id}/verifications`,
          assetRef: a.id,
          body: {
            method: method === 'scan' ? 'scan' : 'manual',
            observedLocationId: here,
            notes: notes.trim() || undefined,
            alsoMoveHere: elsewhere && alsoMove ? true : undefined,
            eventTime: new Date().toISOString(),
          },
        }),
      ]);
      if (r.status === 'done') setResult(r.result);
      else setSavedOffline(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (savedOffline) {
    return (
      <Screen>
        <Heading>Saved on this phone</Heading>
        <Notice kind="info">
          No connection. Seeing {a.institutionalId} here was saved with today’s date and time, and will be sent automatically when you are back
          online. It is not yet recorded on the server.
        </Notice>
        <Row>
          <Button title="Scan next asset" onPress={() => router.replace('/scan')} />
          <Button title="Waiting to sync" variant="secondary" onPress={() => router.push('/sync')} />
        </Row>
      </Screen>
    );
  }

  if (result) {
    const v = result.verification;
    return (
      <Screen>
        <Heading>{result.duplicate ? 'Already recorded' : 'Verification recorded'}</Heading>
        <Notice kind="success">
          {result.duplicate
            ? `You already recorded seeing ${a.institutionalId} here a moment ago, so it was not counted twice.`
            : `${a.institutionalId} seen at ${v.observedLocation.building}, ${v.observedLocation.room} on ${formatDateTime(v.eventTime)}.`}
        </Notice>
        {v.outcome === 'location_discrepancy' ? (
          <Notice kind="warning">
            It was recorded at {v.expectedLocation.building}, {v.expectedLocation.room}. This difference has been flagged for the Asset Management Team
            {result.asset.location.id === here ? ', and the asset’s location has been updated to where you found it.' : '. Its recorded location was not changed.'}
          </Notice>
        ) : null}
        <Row>
          <Badge label={VERIFICATION_LABELS[result.asset.verification.status]} tone={verificationTone(result.asset.verification.status)} />
          {result.asset.verification.dueDate ? <Body muted>Next verification due {result.asset.verification.dueDate}</Body> : null}
        </Row>
        <Row>
          <Button title="Scan next asset" onPress={() => router.replace('/scan')} />
          <Button title="View asset" variant="secondary" onPress={() => router.replace({ pathname: '/inventory/[id]', params: { id: a.id } })} />
        </Row>
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>Verify {a.institutionalId}</Heading>
      <Card>
        <Heading level={2}>{a.name}</Heading>
        <Body muted>
          Recorded at {a.location.building}, {a.location.room} · {a.department.name}
        </Body>
        <Body muted>
          Last verified: {a.verification.lastVerifiedAt ? `${formatDateTime(a.verification.lastVerifiedAt)} by ${a.verification.lastVerifiedBy}` : 'never'}
        </Body>
      </Card>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        {locations.data ? (
          <Choice label="Where are you now?" value={here} options={options} onChange={setObserved} />
        ) : locations.error ? (
          <Notice kind="error">{locations.error}</Notice>
        ) : (
          <Loading label="Loading locations…" />
        )}
        {elsewhere ? (
          <>
            <Notice kind="warning">This is not where the asset is recorded. The difference will be flagged for review.</Notice>
            {a.can.move ? <Checkbox label="Also update the asset’s location to here" checked={alsoMove} onChange={setAlsoMove} /> : null}
          </>
        ) : null}
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="e.g. Label slightly scratched" />
        <Body muted>The time recorded is now. {method === 'scan' ? 'Recorded as a QR scan.' : 'Recorded as a typed asset code.'}</Body>
        <Button title="Confirm I can see this asset" onPress={submit} loading={busy} />
      </Card>
    </Screen>
  );
}
