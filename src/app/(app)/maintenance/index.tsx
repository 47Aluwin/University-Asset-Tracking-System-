import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Badge, Body, Button, Choice, Heading, Loading, Notice, Row, Screen, SearchableChoice, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { MAINTENANCE_STATUS_LABELS, PRIORITY_LABELS, maintenanceTone, priorityTone } from '@/lib/asset-display';
import { useSession } from '@/lib/session';
import type { MaintenanceRequest, Paged } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';

type OpenFilter = 'true' | 'false' | 'all';

/** Maintenance requests: a department's own work list, or oversight across departments. */
export default function MaintenanceList() {
  const t = useTheme();
  const { can, user } = useSession();
  const departments = useDepartments();
  const params = useLocalSearchParams<{ open?: string; departmentId?: string }>();
  const [open, setOpen] = useState<OpenFilter>(params.open === 'false' || params.open === 'all' ? params.open : 'true');
  const [departmentId, setDepartmentId] = useState(params.departmentId || 'all');
  const [page, setPage] = useState(1);
  const query = { open: open === 'all' ? undefined : open, departmentId: departmentId === 'all' ? undefined : departmentId, page, pageSize: 25 };
  const list = useQuery(`maintenance:${JSON.stringify(query)}`, () => api<Paged<MaintenanceRequest>>('/maintenance', { query }));
  const { reload } = list;
  useFocusEffect(useCallback(() => reload(), [reload]));
  const readable = departments.active.filter((d) => can('maintenance.read', d.id));
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <Screen wide>
      <Heading>Maintenance</Heading>
      <Body muted>
        {user?.role === 'DEPARTMENT_STAFF'
          ? `Requests for ${user.department?.name}. Your department manages its own repairs.`
          : 'Requests across departments. Each department manages its own repairs; this view is for oversight.'}
      </Body>
      <Choice<OpenFilter>
        label="Show"
        value={open}
        options={[
          { value: 'true', label: 'Open' },
          { value: 'false', label: 'Closed' },
          { value: 'all', label: 'All' },
        ]}
        onChange={(v) => {
          setOpen(v);
          setPage(1);
        }}
      />
      {readable.length > 1 ? (
        <SearchableChoice
          label="School / department"
          value={departmentId}
          options={[{ value: 'all', label: 'All' }, ...readable.map((d) => ({ value: d.id, label: d.name }))]}
          onChange={(v) => {
            setDepartmentId(v);
            setPage(1);
          }}
        />
      ) : null}
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data ? <Body muted>{list.data.total} {list.data.total === 1 ? 'request' : 'requests'}</Body> : null}
      {list.data?.items.length === 0 ? <Body muted>No requests.</Body> : null}
      <View style={{ gap: 8 }}>
        {list.data?.items.map((m) => (
          <Pressable
            key={m.id}
            accessibilityRole="link"
            accessibilityLabel={`${m.reference}, ${m.asset.name}, ${MAINTENANCE_STATUS_LABELS[m.status]}`}
            onPress={() => router.push({ pathname: '/maintenance/[id]', params: { id: m.id } })}
            style={({ pressed }) => ({ borderWidth: 1, borderColor: t.border, backgroundColor: t.backgroundElement, borderRadius: 10, padding: 12, gap: 4, opacity: pressed ? 0.8 : 1 })}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>
              {m.reference} · {m.asset.name}
            </Text>
            <Text style={{ color: t.textSecondary }} numberOfLines={2}>
              {m.problem}
            </Text>
            <Text style={{ color: t.textSecondary }}>
              {m.asset.institutionalId} · {m.department.name} · reported {formatDateTime(m.reportedAt)} by {m.reportedBy}
            </Text>
            <Row>
              <Badge label={MAINTENANCE_STATUS_LABELS[m.status]} tone={maintenanceTone(m.status)} />
              <Badge label={`Priority: ${PRIORITY_LABELS[m.priority]}`} tone={priorityTone(m.priority)} />
              {m.status === 'completed' && !m.conditionConfirmedAt ? <Badge label="Condition to confirm" tone="warn" /> : null}
            </Row>
          </Pressable>
        ))}
      </View>
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
