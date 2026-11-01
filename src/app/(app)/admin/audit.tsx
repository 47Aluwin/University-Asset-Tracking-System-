import { useState } from 'react';
import { Text } from 'react-native';

import { Badge, Body, Button, Card, Field, Heading, Loading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/use-query';
import type { Paged } from '@/lib/types';

type AuditItem = {
  id: string;
  occurredAt: string;
  actor: { id: string; name: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: 'success' | 'denied' | 'failure';
  before: unknown;
  after: unknown;
  context: unknown;
};

export default function Audit() {
  const t = useTheme();
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const filter = action.trim();
  const { data, error } = useQuery(`audit:${filter}:${page}`, () =>
    api<Paged<AuditItem>>('/audit-events', { query: { action: filter || undefined, page, pageSize: 50 } }),
  );

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

  return (
    <Screen wide>
      <Heading>Audit log</Heading>
      <Body muted>Read-only. Entries cannot be edited or deleted.</Body>
      <Field
        label="Filter by exact action"
        value={action}
        onChangeText={(v) => {
          setAction(v);
          setPage(1);
        }}
        autoCapitalize="none"
        placeholder="e.g. user.deactivate, auth.login"
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data?.items.length === 0 ? <Body muted>No entries.</Body> : null}
      {data?.items.map((a) => (
        <Card key={a.id}>
          <Row>
            <Text style={{ color: t.text, fontWeight: '700' }}>{a.action}</Text>
            <Badge label={a.outcome} tone={a.outcome === 'success' ? 'good' : a.outcome === 'denied' ? 'bad' : 'warn'} />
          </Row>
          <Body muted>
            {formatDateTime(a.occurredAt)} · {a.actor ? a.actor.name : 'System / anonymous'} · {a.entityType}
            {a.entityId ? ` ${a.entityId}` : ''}
          </Body>
          {json(a.before) ? <Body muted>Before: {json(a.before)}</Body> : null}
          {json(a.after) ? <Body muted>After: {json(a.after)}</Body> : null}
          {json(a.context) ? <Body muted>Details: {json(a.context)}</Body> : null}
        </Card>
      ))}
      {data && pages > 1 ? (
        <Row>
          <Button title="Newer" variant="secondary" disabled={page <= 1} onPress={() => setPage(page - 1)} />
          <Body>
            Page {page} of {pages}
          </Body>
          <Button title="Older" variant="secondary" disabled={page >= pages} onPress={() => setPage(page + 1)} />
        </Row>
      ) : null}
    </Screen>
  );
}
