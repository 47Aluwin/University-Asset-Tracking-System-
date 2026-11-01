import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Badge, Body, Button, Choice, Field, FilterPanel, Heading, Loading, Notice, Row, Screen, SearchableChoice } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { MISSING_LABELS, VERIFICATION_LABELS, conditionTone, verificationTone } from '@/lib/asset-display';
import { useSession } from '@/lib/session';
import type { Asset, Category, Paged } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useFaculties } from '@/lib/use-faculties';
import { useQuery } from '@/lib/use-query';
import { CONDITION_LABELS, CONDITIONS, REGISTRATION_STATUS_LABELS, USAGE_STATUS_LABELS, USAGE_STATUSES } from '@shared/asset-codes';

type StatusFilter = 'all' | 'awaiting_label' | 'registered';
type ArchivedFilter = 'exclude' | 'only';
type VerificationFilter = 'all' | 'due_or_overdue' | 'overdue' | 'due' | 'verified' | 'not_yet_verified';
type MissingFilter = 'all' | 'any' | 'reported_missing' | 'confirmed_missing';

export default function AssetList() {
  const t = useTheme();
  const { can, user } = useSession();
  const departments = useDepartments();
  const faculties = useFaculties();
  const [q, setQ] = useState('');
  // Links from the home screen and dashboard can open the list pre-filtered, e.g. /inventory?verification=overdue
  const params = useLocalSearchParams<{
    verification?: string;
    missing?: string;
    departmentId?: string;
    facultyId?: string;
    categoryId?: string;
    condition?: string;
    status?: string;
  }>();
  const [status, setStatus] = useState<StatusFilter>(params.status === 'registered' || params.status === 'awaiting_label' ? params.status : 'all');
  const [condition, setCondition] = useState<string>((CONDITIONS as readonly string[]).includes(params.condition ?? '') ? params.condition! : 'all');
  const [categoryId, setCategoryId] = useState<string>(params.categoryId || 'all');
  const [departmentId, setDepartmentId] = useState<string>(params.departmentId || 'all');
  const [facultyId, setFacultyId] = useState<string>(params.facultyId || 'all');
  const [usageStatus, setUsageStatus] = useState<string>('all');
  const [archived, setArchived] = useState<ArchivedFilter>('exclude');
  const [verification, setVerification] = useState<VerificationFilter>(
    (['due_or_overdue', 'overdue', 'due', 'verified', 'not_yet_verified'] as const).find((v) => v === params.verification) ?? 'all',
  );
  const [missing, setMissing] = useState<MissingFilter>(
    (['any', 'reported_missing', 'confirmed_missing'] as const).find((m) => m === params.missing) ?? 'all',
  );
  const [page, setPage] = useState(1);
  const categories = useQuery('categories', () => api<{ items: Category[] }>('/categories'));

  const query = {
    q: q.trim() || undefined,
    status: status === 'all' ? undefined : status,
    condition: condition === 'all' ? undefined : condition,
    categoryId: categoryId === 'all' ? undefined : categoryId,
    departmentId: departmentId === 'all' ? undefined : departmentId,
    facultyId: facultyId === 'all' ? undefined : facultyId,
    usageStatus: usageStatus === 'all' ? undefined : usageStatus,
    archived,
    verification: verification === 'all' ? undefined : verification,
    missing: missing === 'all' ? undefined : missing,
    sort: verification === 'overdue' || verification === 'due_or_overdue' ? 'most_overdue' : undefined,
    page,
    pageSize: 25,
  };
  const list = useQuery(`assets:${JSON.stringify(query)}`, () => api<Paged<Asset>>('/assets', { query }));
  const { reload } = list;
  useFocusEffect(useCallback(() => reload(), [reload]));

  const readable = departments.active.filter((d) => can('assets.read', d.id));
  // Faculty filter: only faculties that contain a school the user can see; then that faculty's schools.
  const facultyOptions = useMemo(() => {
    const has = new Set(readable.map((d) => d.faculty?.id ?? 'central'));
    const opts = (faculties.items ?? []).filter((x) => has.has(x.id)).map((x) => ({ value: x.id, label: x.name }));
    if (has.has('central')) opts.push({ value: 'central', label: 'Central administration' });
    return opts;
  }, [readable, faculties.items]);
  const schoolsShown = facultyId === 'all' ? readable : readable.filter((d) => (d.faculty?.id ?? 'central') === facultyId);
  const resetPage = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const activeFilters = [status, condition, categoryId, facultyId, departmentId, usageStatus, verification, missing].filter((v) => v !== 'all').length + (archived !== 'exclude' ? 1 : 0);
  const clearFilters = () => {
    setStatus('all');
    setCondition('all');
    setCategoryId('all');
    setFacultyId('all');
    setDepartmentId('all');
    setUsageStatus('all');
    setVerification('all');
    setMissing('all');
    setArchived('exclude');
    setPage(1);
  };

  return (
    <Screen wide>
      <Row style={{ justifyContent: 'space-between' }}>
        <Heading>Assets</Heading>
        {can('assets.register') ? <Button title="Register asset" onPress={() => router.push('/inventory/new')} /> : null}
      </Row>
      {user?.role === 'DEPARTMENT_STAFF' ? <Body muted>Showing assets for {user.department?.name}{user.grants.length ? ' and departments you have been given access to' : ''}.</Body> : null}

      <Field label="Search" value={q} onChangeText={resetPage(setQ)} placeholder="Name, asset ID, serial number, model, barcode or assigned staff member" autoCapitalize="none" />
      <Row>
        <Button title="Find by asset code" variant="secondary" onPress={() => router.push('/inventory/find')} />
      </Row>
      <FilterPanel active={activeFilters} onClear={clearFilters}>
      <Choice<StatusFilter>
        label="Registration"
        value={status}
        options={[
          { value: 'all', label: 'All' },
          { value: 'awaiting_label', label: 'Awaiting label' },
          { value: 'registered', label: 'Registered' },
        ]}
        onChange={resetPage(setStatus)}
      />
      <Choice
        label="Condition"
        value={condition}
        options={[{ value: 'all', label: 'All' }, ...CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))]}
        onChange={resetPage(setCondition)}
      />
      {categories.data?.items.length ? (
        <Choice
          label="Category"
          value={categoryId}
          options={[{ value: 'all', label: 'All' }, ...categories.data.items.map((c) => ({ value: c.id, label: c.name }))]}
          onChange={resetPage(setCategoryId)}
        />
      ) : null}
      {facultyOptions.length > 1 ? (
        <Choice
          label="Faculty"
          value={facultyId}
          options={[{ value: 'all', label: 'All' }, ...facultyOptions]}
          onChange={resetPage((v: string) => {
            setFacultyId(v);
            setDepartmentId('all'); // a school from another faculty would match nothing
          })}
        />
      ) : null}
      {readable.length > 1 ? (
        <SearchableChoice
          label="School / department"
          value={departmentId}
          options={[{ value: 'all', label: 'All' }, ...schoolsShown.map((d) => ({ value: d.id, label: d.name }))]}
          onChange={resetPage(setDepartmentId)}
        />
      ) : null}
      <Choice
        label="Asset status"
        value={usageStatus}
        options={[{ value: 'all', label: 'All' }, ...USAGE_STATUSES.map((u) => ({ value: u, label: USAGE_STATUS_LABELS[u] }))]}
        onChange={resetPage(setUsageStatus)}
      />
      <Choice<VerificationFilter>
        label="Verification"
        value={verification}
        options={[
          { value: 'all', label: 'All' },
          { value: 'due_or_overdue', label: 'Due or overdue' },
          { value: 'overdue', label: 'Overdue' },
          { value: 'not_yet_verified', label: 'Not yet verified' },
          { value: 'verified', label: 'Verified' },
        ]}
        onChange={resetPage(setVerification)}
      />
      <Choice<MissingFilter>
        label="Missing"
        value={missing}
        options={[
          { value: 'all', label: 'Any' },
          { value: 'any', label: 'Reported or confirmed missing' },
          { value: 'reported_missing', label: 'Reported missing' },
          { value: 'confirmed_missing', label: 'Confirmed missing' },
        ]}
        onChange={resetPage(setMissing)}
      />
      <Choice<ArchivedFilter>
        label="Show"
        value={archived}
        options={[
          { value: 'exclude', label: 'Current assets' },
          { value: 'only', label: 'Archived' },
        ]}
        onChange={resetPage(setArchived)}
      />
      </FilterPanel>

      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data ? <Body muted>{list.data.total} {list.data.total === 1 ? 'asset' : 'assets'}</Body> : null}
      {list.data && list.data.items.length === 0 ? (
        <Body muted>{q || status !== 'all' || condition !== 'all' || categoryId !== 'all' || verification !== 'all' || missing !== 'all' || facultyId !== 'all' || departmentId !== 'all' || usageStatus !== 'all' ? 'No assets match these filters.' : 'No assets have been registered yet.'}</Body>
      ) : null}

      <View style={{ gap: 8 }}>
        {list.data?.items.map((a) => (
          <Pressable
            key={a.id}
            accessibilityRole="link"
            accessibilityLabel={`${a.name}, ${a.institutionalId}`}
            onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: a.id } })}
            style={({ pressed }) => ({
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.backgroundElement,
              borderRadius: 10,
              padding: 12,
              gap: 4,
              opacity: pressed ? 0.8 : 1,
            })}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{a.name}</Text>
            <Text style={{ color: t.textSecondary, fontFamily: 'monospace' }}>{a.institutionalId}</Text>
            <Text style={{ color: t.textSecondary }}>
              {a.department.name} · {a.location.building}, {a.location.room} · {a.category.name}
            </Text>
            {a.faculty || a.assignedTo ? (
              <Text style={{ color: t.textSecondary }}>
                {[a.faculty?.name, a.assignedTo ? `Assigned to ${a.assignedTo}` : null].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
            <Row>
              <Badge label={REGISTRATION_STATUS_LABELS[a.registrationStatus]} tone={a.registrationStatus === 'registered' ? 'good' : 'warn'} />
              <Badge label={CONDITION_LABELS[a.condition]} tone={conditionTone(a.condition)} />
              {a.archived ? <Badge label="Archived" tone="neutral" /> : null}
              {a.verification.status !== 'not_applicable' ? (
                <Badge
                  label={a.verification.status === 'overdue' && a.verification.overdueDays != null ? `Overdue ${a.verification.overdueDays} d` : VERIFICATION_LABELS[a.verification.status]}
                  tone={verificationTone(a.verification.status)}
                />
              ) : null}
              {a.missing.status !== 'none' ? <Badge label={MISSING_LABELS[a.missing.status]} tone="bad" /> : null}
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
