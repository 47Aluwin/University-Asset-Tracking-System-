import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Badge, Body, Button, Choice, Field, Heading, Loading, Notice, Row, Screen } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { ROLE_LABELS, type Paged, type UserSummary } from '@/lib/types';

type StatusFilter = 'active' | 'deactivated' | 'all';

export default function Users() {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<UserSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(
        await api<Paged<UserSummary>>('/users', {
          query: { q: q.trim() || undefined, status: status === 'all' ? undefined : status, page, pageSize: 25 },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [q, status, page]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Screen wide>
      <Row style={{ justifyContent: 'space-between' }}>
        <Heading>Users</Heading>
        <Button title="New user" onPress={() => router.push('/admin/users/new')} />
      </Row>
      <Field
        label="Search name or email"
        value={q}
        onChangeText={(v) => {
          setQ(v);
          setPage(1);
        }}
        autoCapitalize="none"
      />
      <Choice
        label="Status"
        value={status}
        options={[
          { value: 'active', label: 'Active' },
          { value: 'deactivated', label: 'Deactivated' },
          { value: 'all', label: 'All' },
        ]}
        onChange={(v) => {
          setStatus(v);
          setPage(1);
        }}
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && data.items.length === 0 ? <Body muted>No users match.</Body> : null}
      <View style={{ gap: 8 }}>
        {data?.items.map((u) => (
          <Pressable
            key={u.id}
            accessibilityRole="link"
            onPress={() => router.push({ pathname: '/admin/users/[id]', params: { id: u.id } })}
            style={({ pressed }) => ({
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.backgroundElement,
              borderRadius: 10,
              padding: 12,
              gap: 4,
              opacity: pressed ? 0.8 : 1,
            })}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{u.fullName}</Text>
            <Text style={{ color: t.textSecondary }}>{u.email}</Text>
            <Row>
              <Badge label={ROLE_LABELS[u.role]} tone="info" />
              {u.department ? <Badge label={u.department.name} /> : null}
              {u.status === 'deactivated' ? <Badge label="Deactivated" tone="bad" /> : null}
              {u.lockedUntil ? <Badge label="Locked" tone="warn" /> : null}
              {!u.passwordSet ? <Badge label="Password not set" tone="warn" /> : null}
            </Row>
          </Pressable>
        ))}
      </View>
      {data && pages > 1 ? (
        <Row>
          <Button title="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage(page - 1)} />
          <Body>
            Page {page} of {pages} ({data.total} users)
          </Body>
          <Button title="Next" variant="secondary" disabled={page >= pages} onPress={() => setPage(page + 1)} />
        </Row>
      ) : null}
    </Screen>
  );
}
