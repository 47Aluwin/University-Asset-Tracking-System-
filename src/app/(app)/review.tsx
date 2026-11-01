import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { FLAG_LABELS } from '@/lib/asset-display';
import { useSession } from '@/lib/session';
import type { Flag, FlagKind, Paged } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

type StatusFilter = 'open' | 'resolved' | 'all';

/** Things that need a person to look at them: discrepancies, transfers, missing reports, late records. */
export default function Review() {
  const params = useLocalSearchParams<{ assetId?: string }>();
  const assetId = typeof params.assetId === 'string' ? params.assetId : undefined;
  const { can } = useSession();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [kind, setKind] = useState<FlagKind | 'all'>('all');
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const query = { status, kind: kind === 'all' ? undefined : kind, assetId, page, pageSize: 25 };
  const list = useQuery(`flags:${JSON.stringify(query)}`, () => api<Paged<Flag>>('/flags', { query }));
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <Screen wide>
      <Heading>Review flags</Heading>
      <Body muted>
        {can('flags.review')
          ? 'Check each item and record what you found. Resolving a flag never changes the asset; use the asset’s own actions for that.'
          : 'Items flagged in your department. The Asset Management Team reviews and resolves them.'}
      </Body>
      {assetId ? (
        <Row>
          <Body muted>Showing one asset only.</Body>
          <Button title="Show all" variant="secondary" onPress={() => router.replace('/review')} />
        </Row>
      ) : null}
      <Choice<StatusFilter>
        label="Show"
        value={status}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
          { value: 'all', label: 'All' },
        ]}
        onChange={(v) => {
          setStatus(v);
          setPage(1);
        }}
      />
      <Choice
        label="Type"
        value={kind}
        options={[{ value: 'all' as const, label: 'All' }, ...(Object.keys(FLAG_LABELS) as FlagKind[]).map((k) => ({ value: k, label: FLAG_LABELS[k] }))]}
        onChange={(v) => {
          setKind(v);
          setPage(1);
        }}
      />
      {msg ? <Notice kind="success">{msg}</Notice> : null}
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data?.items.length === 0 ? <Body muted>Nothing to review.</Body> : null}
      {list.data?.items.map((f) => (
        <FlagCard
          key={f.id}
          flag={f}
          onResolved={() => {
            setMsg('Flag resolved.');
            list.reload();
          }}
        />
      ))}
      {list.data && pages > 1 ? (
        <Row>
          <Button title="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage(page - 1)} />
          <Body>
            Page {page} of {pages}
          </Body>
          <Button title="Next" variant="secondary" disabled={page >= pages} onPress={() => setPage(page + 1)} />
        </Row>
      ) : null}
    </Screen>
  );
}

function describe(f: Flag): string | null {
  const d = f.details as Record<string, unknown>;
  if (f.kind === 'location_discrepancy') return `Recorded at ${d.expected}, seen at ${d.observed}.${d.movedHere ? ' The location was updated to where it was seen.' : ''}`;
  if (f.kind === 'reported_missing' || f.kind === 'found_after_missing') return typeof d.reason === 'string' ? `Reason given: ${d.reason}` : null;
  if (f.kind === 'cross_department_move') return typeof d.reason === 'string' ? `Reason given: ${d.reason}` : null;
  if (f.kind === 'late_event') return typeof d.note === 'string' ? d.note : null;
  return null;
}

function FlagCard({ flag: f, onResolved }: { flag: Flag; onResolved: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resolve = async () => {
    setError(null);
    if (note.trim().length < 3) return setError('Say what was checked or done.');
    setBusy(true);
    try {
      await api(`/flags/${f.id}/resolve`, { body: { note: note.trim() } });
      onResolved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Row>
        <Heading level={2}>{FLAG_LABELS[f.kind]}</Heading>
        <Badge label={f.status === 'open' ? 'Open' : 'Resolved'} tone={f.status === 'open' ? 'warn' : 'good'} />
      </Row>
      <Body>
        {f.asset.institutionalId} — {f.asset.name} ({f.asset.department})
      </Body>
      {describe(f) ? <Body muted>{describe(f)}</Body> : null}
      <Body muted>
        Flagged {formatDateTime(f.createdAt)}
        {f.createdBy ? ` · ${f.createdBy}` : ''}
      </Body>
      {f.status === 'resolved' ? (
        <Body muted>
          Resolved {formatDateTime(f.resolvedAt)} by {f.resolvedBy}: {f.resolutionNote}
        </Body>
      ) : null}
      <Row>
        <Button title="Open asset" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: f.asset.id } })} />
      </Row>
      {f.canResolve ? (
        <>
          {error ? <Notice kind="error">{error}</Notice> : null}
          <Field label="What did you check or do?" value={note} onChangeText={setNote} placeholder="e.g. Confirmed with the lab manager" />
          <Row>
            <Button title="Resolve" onPress={resolve} loading={busy} />
          </Row>
        </>
      ) : null}
    </Card>
  );
}
