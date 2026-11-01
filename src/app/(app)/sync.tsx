import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { Badge, Body, Button, Card, Field, Heading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { confirmAction } from '@/lib/confirm';
import { offlineCapable, type QueuedOp } from '@/lib/offline';
import { useOffline } from '@/lib/offline/provider';
import { useSession } from '@/lib/session';
import { useQuery } from '@/lib/use-query';

const STATUS: Record<QueuedOp['status'], { label: string; tone: 'neutral' | 'good' | 'bad' | 'warn' | 'info' }> = {
  pending: { label: 'Saved on this phone — waiting to send', tone: 'warn' },
  syncing: { label: 'Sending…', tone: 'info' },
  synced: { label: 'Sent and accepted', tone: 'good' },
  failed: { label: 'Server problem — will retry', tone: 'warn' },
  rejected: { label: 'Not accepted', tone: 'bad' },
  conflict: { label: 'Conflict — needs review', tone: 'bad' },
};

type ServerConflict = {
  id: string;
  asset: { id: string; institutionalId: string; name: string };
  department: { name: string };
  submittedBy: string;
  receivedAt: string;
  proposed: Record<string, unknown>;
  serverValues: Record<string, unknown>;
  can: { resolve: boolean };
};

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

function OpRow({ op }: { op: QueuedOp }) {
  const t = useTheme();
  const { retry, discard } = useOffline();
  const s = STATUS[op.status];
  const duplicate = op.lastError?.code === 'POSSIBLE_DUPLICATE';
  return (
    <View style={{ borderTopWidth: 1, borderColor: t.border, paddingVertical: 10, gap: 4 }}>
      <Text style={{ color: t.text, fontWeight: '600' }}>{op.label}</Text>
      <Row>
        <Badge label={s.label} tone={s.tone} />
        <Body muted>Happened {formatDateTime(op.eventTime)}</Body>
      </Row>
      {op.lastError && op.status !== 'synced' && op.lastError.code !== 'NETWORK' ? <Text style={{ color: op.status === 'rejected' ? t.danger : t.textSecondary }}>{op.lastError.message}</Text> : null}
      {op.status === 'rejected' || op.status === 'failed' || op.status === 'conflict' ? (
        <Row>
          {duplicate ? (
            <Button title="It is a different item — send anyway" onPress={() => retry(op.id, { ...(op.body as object), confirmNotDuplicate: true })} />
          ) : op.status !== 'conflict' ? (
            <Button title="Try again" variant="secondary" onPress={() => retry(op.id)} />
          ) : null}
          <Button
            title="Remove from this phone"
            variant="danger"
            onPress={async () => {
              if (await confirmAction('Remove this item?', `“${op.label}” has not been accepted by the server. Removing it deletes it from this phone (and anything that depends on it).`, 'Remove')) await discard(op.id);
            }}
          />
        </Row>
      ) : null}
    </View>
  );
}

export default function SyncScreen() {
  const t = useTheme();
  const { can } = useSession();
  const { ops, waiting, problems, online, syncing, last, syncNow } = useOffline();
  const conflicts = useQuery('sync-conflicts', () => api<{ items: ServerConflict[] }>('/sync-conflicts'));
  const { reload } = conflicts;
  useFocusEffect(useCallback(() => reload(), [reload]));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const attention = ops.filter((o) => o.status === 'rejected' || o.status === 'conflict');
  const queued = ops.filter((o) => o.status === 'pending' || o.status === 'failed' || o.status === 'syncing');
  const sent = ops.filter((o) => o.status === 'synced').slice(-20).reverse();

  const resolve = async (c: ServerConflict, how: 'apply' | 'discard') => {
    setMsg(null);
    try {
      await api(`/sync-conflicts/${c.id}/resolve`, { body: { action: how, note: notes[c.id]?.trim() || undefined } });
      setMsg({ kind: 'success', text: how === 'apply' ? `The field edit was applied to ${c.asset.institutionalId}.` : `The field edit for ${c.asset.institutionalId} was discarded.` });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  return (
    <Screen>
      <Heading>Waiting to sync</Heading>
      {offlineCapable ? (
        <Body muted>
          Work done without a connection is saved on this phone with the time it happened, and sent automatically when the phone is back online. Nothing
          here counts as recorded until the server accepts it.
        </Body>
      ) : (
        <Body muted>The web version works online only. Offline work is done in the phone app; conflicts from phones can be reviewed here.</Body>
      )}

      {offlineCapable ? (
        <Card>
          <Row>
            <Badge label={online ? 'Online' : 'No connection'} tone={online ? 'good' : 'warn'} />
            <Body muted>
              {waiting} waiting · {problems} need attention{last ? ` · last checked ${formatDateTime(last.at)}` : ''}
            </Body>
          </Row>
          {last?.summary.signInNeeded ? <Notice kind="warning">Your sign-in has expired. Sign out and sign in again to send the saved items; they are kept.</Notice> : null}
          <Button title="Send now" onPress={syncNow} loading={syncing} disabled={!waiting} />
        </Card>
      ) : null}

      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}

      {conflicts.data?.items.length ? (
        <Card>
          <Heading level={2}>Edits that clashed with newer changes</Heading>
          <Body muted>
            These edits were made offline, but someone changed the same details before they arrived. Nothing was overwritten. Compare and decide.
          </Body>
          {conflicts.data.items.map((c) => (
            <View key={c.id} style={{ borderTopWidth: 1, borderColor: t.border, paddingVertical: 10, gap: 6 }}>
              <Text style={{ color: t.text, fontWeight: '700' }}>
                {c.asset.institutionalId} — {c.asset.name}
              </Text>
              <Body muted>
                Edited offline by {c.submittedBy}, arrived {formatDateTime(c.receivedAt)} · {c.department.name}
              </Body>
              {Object.keys(c.proposed).map((k) => (
                <Text key={k} style={{ color: t.text }}>
                  {k}: now “{show(c.serverValues[k])}” · field edit “{show(c.proposed[k])}”
                </Text>
              ))}
              {c.can.resolve ? (
                <>
                  <Field label="Note (optional)" value={notes[c.id] ?? ''} onChangeText={(v) => setNotes({ ...notes, [c.id]: v })} />
                  <Row>
                    <Button title="Apply the field edit" onPress={() => resolve(c, 'apply')} />
                    <Button title="Keep current values" variant="secondary" onPress={() => resolve(c, 'discard')} />
                  </Row>
                </>
              ) : (
                <Body muted>Someone in the asset’s department decides this.</Body>
              )}
            </View>
          ))}
        </Card>
      ) : null}

      {attention.length ? (
        <Card>
          <Heading level={2}>Needs your attention</Heading>
          {attention.map((o) => (
            <OpRow key={o.id} op={o} />
          ))}
        </Card>
      ) : null}

      {offlineCapable ? (
        <Card>
          <Heading level={2}>Waiting to send</Heading>
          {queued.length ? queued.map((o) => <OpRow key={o.id} op={o} />) : <Body muted>Nothing waiting. Everything on this phone has been sent.</Body>}
        </Card>
      ) : null}

      {sent.length ? (
        <Card>
          <Heading level={2}>Recently sent</Heading>
          {sent.map((o) => (
            <OpRow key={o.id} op={o} />
          ))}
        </Card>
      ) : null}
      {!can('assets.read') ? null : conflicts.error ? <Notice kind="error">{conflicts.error}</Notice> : null}
    </Screen>
  );
}
