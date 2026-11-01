import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Body, Button, Card, Choice, FilterPanel, Heading, Loading, Notice, Row, Screen, SearchableChoice, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { MAINTENANCE_STATUS_LABELS } from '@/lib/asset-display';
import { useSession } from '@/lib/session';
import type { Category, CurrencyTotal, Dashboard as DashboardData } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useFaculties } from '@/lib/use-faculties';
import { useQuery } from '@/lib/use-query';
import { CONDITION_LABELS, CONDITIONS, formatMoney } from '@shared/asset-codes';

const PERIODS = ['30', '90', '180', '365'] as const;
type Period = (typeof PERIODS)[number];

/** Money totals, one line per currency (different currencies are never added together). */
function MoneyList({ items, empty = 'No recorded amounts' }: { items: CurrencyTotal[]; empty?: string }) {
  const t = useTheme();
  if (!items.length) return <Text style={{ color: t.textSecondary }}>{empty}</Text>;
  return (
    <View style={{ gap: 2 }}>
      {items.map((v) => (
        <Text key={v.currency} style={[styles.money, { color: t.text }]}>
          {formatMoney(v.total, v.currency)}
        </Text>
      ))}
    </View>
  );
}

/** A headline number that opens the matching filtered list. */
function Stat({ label, value, detail, href }: { label: string; value: number | string; detail?: string; href?: Href }) {
  const t = useTheme();
  const body = (
    <>
      <Text style={[styles.statValue, { color: t.text }]}>{typeof value === 'number' ? value.toLocaleString() : value}</Text>
      <Text style={[styles.statLabel, { color: t.text }]}>{label}</Text>
      {detail ? <Text style={{ color: t.textSecondary, fontSize: 13 }}>{detail}</Text> : null}
      {href ? <Text style={{ color: t.primary, fontSize: 13, fontWeight: '600' }}>View list ›</Text> : null}
    </>
  );
  const style = [styles.stat, { borderColor: t.border, backgroundColor: t.backgroundElement }];
  if (!href) return <View style={style}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${label}: ${value}${detail ? `. ${detail}` : ''}. View list`}
      onPress={() => router.push(href)}
      style={({ pressed }) => [...style, { opacity: pressed ? 0.8 : 1 }]}>
      {body}
    </Pressable>
  );
}

/** One labelled count with a thin bar showing its share of `of`. The number is always written out. */
function ShareRow({ label, n, of, href }: { label: string; n: number; of: number; href?: Href }) {
  const t = useTheme();
  const pct = of > 0 ? Math.round((n / of) * 100) : 0;
  const content = (
    <View style={{ gap: 4 }}>
      <View style={styles.shareHead}>
        <Text style={{ color: t.text, flexShrink: 1 }}>{label}</Text>
        <Text style={{ color: t.text, fontWeight: '700' }}>
          {n.toLocaleString()} <Text style={{ color: t.textSecondary, fontWeight: '400' }}>({pct}%)</Text>
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: t.border }]}>
        <View style={[styles.bar, { width: `${pct}%`, backgroundColor: t.secondary }]} />
      </View>
    </View>
  );
  if (!href || n === 0) return content;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${label}: ${n} of ${of}. View list`} onPress={() => router.push(href)}>
      {content}
    </Pressable>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <Heading level={2}>{`${n}. ${title}`}</Heading>
      {children}
    </Card>
  );
}

export default function DashboardScreen() {
  const t = useTheme();
  const { can, user } = useSession();
  const departments = useDepartments();
  const faculties = useFaculties();
  const categories = useQuery('categories', () => api<{ items: Category[] }>('/categories'));
  const [departmentId, setDepartmentId] = useState('all');
  const [facultyId, setFacultyId] = useState('all');
  const [categoryId, setCategoryId] = useState('all');
  const [condition, setCondition] = useState('all');
  const [period, setPeriod] = useState<Period>('90');

  const query = {
    departmentId: departmentId === 'all' ? undefined : departmentId,
    facultyId: facultyId === 'all' ? undefined : facultyId,
    categoryId: categoryId === 'all' ? undefined : categoryId,
    condition: condition === 'all' ? undefined : condition,
    periodDays: period,
  };
  const dash = useQuery(`dashboard:${JSON.stringify(query)}`, () => api<DashboardData>('/dashboard', { query }));
  const { reload } = dash;
  useFocusEffect(useCallback(() => reload(), [reload]));

  if (!can('dashboard.read')) {
    return (
      <Screen>
        <Notice kind="error">You do not have access to the dashboard.</Notice>
      </Screen>
    );
  }

  const readable = departments.active.filter((d) => can('dashboard.read', d.id));
  const hasFaculty = new Set(readable.map((x) => x.faculty?.id ?? 'central'));
  const facultyOptions = (faculties.items ?? []).filter((x) => hasFaculty.has(x.id)).map((x) => ({ value: x.id, label: x.name }));
  if (hasFaculty.has('central')) facultyOptions.push({ value: 'central', label: 'Central administration' });
  const schoolsShown = facultyId === 'all' ? readable : readable.filter((x) => (x.faculty?.id ?? 'central') === facultyId);
  // Filters carried into the lists that the dashboard links to.
  const listParams = {
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.facultyId ? { facultyId: query.facultyId } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.condition ? { condition: query.condition } : {}),
  };
  const assets = (extra: Record<string, string> = {}): Href => ({ pathname: '/inventory', params: { ...listParams, ...extra } });
  const d = dash.data;

  return (
    <Screen wide>
      <Row style={{ justifyContent: 'space-between' }}>
        <Heading>Dashboard</Heading>
        {can('reports.generate') ? <Button title="Reports and exports" variant="secondary" onPress={() => router.push('/reports')} /> : null}
      </Row>
      <Body muted>
        {user?.role === 'DEPARTMENT_STAFF' ? `Figures for ${user.department?.name}${user.grants.length ? ' and departments you have been given access to' : ''}. ` : ''}
        Live figures from records accepted by the central server{d ? ` · updated ${formatDateTime(d.generatedAt)}` : ''}.
      </Body>

      <FilterPanel
        active={[facultyId, departmentId, categoryId, condition].filter((v) => v !== 'all').length}
        onClear={() => {
          setFacultyId('all');
          setDepartmentId('all');
          setCategoryId('all');
          setCondition('all');
        }}>
      {facultyOptions.length > 1 ? (
        <Choice
          label="Faculty"
          value={facultyId}
          options={[{ value: 'all', label: 'All faculties' }, ...facultyOptions]}
          onChange={(v) => {
            setFacultyId(v);
            setDepartmentId('all');
          }}
        />
      ) : null}
      {readable.length > 1 ? (
        <SearchableChoice
          label="School / department"
          value={departmentId}
          options={[{ value: 'all', label: facultyId === 'all' ? 'All departments' : 'All in this faculty' }, ...schoolsShown.map((x) => ({ value: x.id, label: x.name }))]}
          onChange={setDepartmentId}
        />
      ) : null}
      {categories.data?.items.length ? (
        <Choice
          label="Category"
          value={categoryId}
          options={[{ value: 'all', label: 'All categories' }, ...categories.data.items.filter((c) => c.isActive).map((c) => ({ value: c.id, label: c.name }))]}
          onChange={setCategoryId}
        />
      ) : null}
      <Choice
        label="Condition"
        value={condition}
        options={[{ value: 'all', label: 'Any condition' }, ...CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))]}
        onChange={setCondition}
      />
      </FilterPanel>

      {dash.error ? (
        <Notice kind="error">
          {dash.error} <Text onPress={reload} style={{ textDecorationLine: 'underline' }}>Try again</Text>
        </Notice>
      ) : null}
      {!d && !dash.error ? <Loading label="Loading dashboard…" /> : null}

      {d ? (
        <>
          {d.totals.assets === 0 ? <Notice kind="info">No assets match these filters yet.</Notice> : null}

          <Section n={1} title="Total assets and asset value">
            <View style={styles.grid}>
              <Stat label="Total assets" value={d.totals.assets} detail="All records that are not archived" href={assets()} />
              <Stat label="Registered" value={d.totals.registered} detail="Label attached and confirmed" href={assets({ status: 'registered' })} />
              <Stat label="Awaiting label" value={d.totals.awaitingLabel} detail="Recorded, label not yet confirmed" href={assets({ status: 'awaiting_label' })} />
            </View>
            <Text style={[styles.sub, { color: t.text }]}>Recorded acquisition value</Text>
            {d.totals.value.length ? (
              d.totals.value.map((v) => (
                <View key={v.currency} style={[styles.valueRow, { borderColor: t.border }]}>
                  <Text style={[styles.money, { color: t.text }]}>{formatMoney(v.total, v.currency)}</Text>
                  <Text style={{ color: t.textSecondary }}>
                    {v.recorded} with a recorded cost · {v.verifiedZero} verified zero cost · {v.unknownCost} unknown cost (exception)
                  </Text>
                </View>
              ))
            ) : (
              <Body muted>No values to show.</Body>
            )}
            <Body muted>Each currency is totalled separately; amounts in different currencies are never added together.</Body>
            {d.totals.valueRestricted ? (
              <Notice kind="info">
                {d.totals.valueRestricted} asset{d.totals.valueRestricted === 1 ? ' is' : 's are'} in departments where you do not have financial access and
                {d.totals.valueRestricted === 1 ? ' is' : ' are'} not included in these values.
              </Notice>
            ) : null}
          </Section>

          <Section n={2} title="Verified, due and overdue assets">
            <Body muted>Registered assets only ({d.verification.registered}). Each asset is in exactly one of these four groups.</Body>
            <View style={{ gap: 12 }}>
              <ShareRow label="Verified (checked within its schedule)" n={d.verification.verified} of={d.verification.registered} href={assets({ verification: 'verified' })} />
              <ShareRow label="Not yet verified" n={d.verification.notYetVerified} of={d.verification.registered} href={assets({ verification: 'not_yet_verified' })} />
              <ShareRow label="Due (inside the warning window)" n={d.verification.due} of={d.verification.registered} href={assets({ verification: 'due' })} />
              <ShareRow label="Overdue (past the due date)" n={d.verification.overdue} of={d.verification.registered} href={assets({ verification: 'overdue' })} />
            </View>
            <View style={styles.grid}>
              <Stat label="Reported missing" value={d.verification.reportedMissing} detail="Reported by department staff, not yet confirmed" href={assets({ missing: 'reported_missing' })} />
              <Stat label="Confirmed missing" value={d.verification.confirmedMissing} detail="Confirmed by the Asset Management Team" href={assets({ missing: 'confirmed_missing' })} />
              <Stat label={`Verified in the last ${d.verification.periodDays} days`} value={d.verification.verifiedInPeriod} detail="Assets with a successful scan in this period" />
            </View>
            <Choice<Period> label="Verification period" value={period} options={PERIODS.map((p) => ({ value: p, label: `${p} days` }))} onChange={setPeriod} />
            <Body muted>
              Overdue is not the same as missing: missing is only recorded when someone reports it.
              {d.verification.noSchedule ? ` ${d.verification.noSchedule} registered asset${d.verification.noSchedule === 1 ? ' has' : 's have'} no verification schedule, so never become due.` : ''}
            </Body>
          </Section>

          <Section n={3} title="Damaged assets and outstanding maintenance">
            <View style={{ gap: 12 }}>
              {CONDITIONS.map((c) => (
                <ShareRow key={c} label={CONDITION_LABELS[c]} n={d.condition.byCondition[c] ?? 0} of={d.totals.assets} href={assets({ condition: c })} />
              ))}
            </View>
            {d.condition.maintenance ? (
              <>
                <View style={styles.grid}>
                  <Stat
                    label="Open maintenance requests"
                    value={d.condition.maintenance.open}
                    detail={`${d.condition.maintenance.byPriority.urgent} urgent · ${d.condition.maintenance.byPriority.high} high priority`}
                    href={{ pathname: '/maintenance', params: { open: 'true', ...(query.departmentId ? { departmentId: query.departmentId } : {}) } }}
                  />
                  <Stat label="Damaged or unusable without an open request" value={d.condition.maintenance.damagedWithoutRequest} detail="May need a maintenance request" />
                  <Stat label="Repaired, condition not yet confirmed" value={d.condition.maintenance.awaitingConfirmation} detail="Completed requests waiting for a condition check" />
                </View>
                {Object.keys(d.condition.maintenance.byStatus).length ? (
                  <Body muted>
                    Open by status:{' '}
                    {Object.entries(d.condition.maintenance.byStatus)
                      .map(([s, n]) => `${MAINTENANCE_STATUS_LABELS[s as keyof typeof MAINTENANCE_STATUS_LABELS] ?? s} ${n}`)
                      .join(' · ')}
                  </Body>
                ) : null}
                <Text style={[styles.sub, { color: t.text }]}>Costs recorded on open requests</Text>
                <MoneyList items={d.condition.maintenance.openCosts} empty="No costs recorded on open requests." />
                {d.condition.maintenance.openCostsRestricted ? <Body muted>Costs from departments where you do not have financial access are not included.</Body> : null}
              </>
            ) : null}
          </Section>

          <Section n={4} title="Faculty and department summaries">
            <Text style={[styles.sub, { color: t.text }]}>Asset distribution across faculties</Text>
            {d.faculties.length ? (
              d.faculties.map((f) => (
                <View key={f.id ?? 'central'} style={[styles.dept, { borderColor: t.border }]}>
                  <ShareRow
                    label={`${f.name} (${f.departments} ${f.departments === 1 ? 'unit' : 'schools / units'})`}
                    n={f.assets}
                    of={d.totals.assets}
                    href={{ pathname: '/inventory', params: { facultyId: f.id ?? 'central' } }}
                  />
                  <View style={styles.facts}>
                    <Fact label="Registered" value={f.registered} />
                    <Fact label="Overdue" value={f.overdue} />
                    <Fact label="Missing" value={f.missing} />
                    {CONDITIONS.map((c) => (
                      <Fact key={c} label={CONDITION_LABELS[c]} value={f.byCondition[c]} />
                    ))}
                  </View>
                  <View style={{ gap: 2 }}>
                    <Text style={{ color: t.textSecondary }}>Recorded value{f.valuePartial ? ' (excludes departments whose money you may not see)' : ''}</Text>
                    <MoneyList items={f.value} />
                  </View>
                </View>
              ))
            ) : (
              <Body muted>No faculties to show.</Body>
            )}
            <Text style={[styles.sub, { color: t.text }]}>Schools and departments</Text>
            {d.departments.length ? (
              d.departments.map((x) => (
                <View key={x.id} style={[styles.dept, { borderColor: t.border }]}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View style={{ flexShrink: 1 }}>
                      <Text style={[styles.deptName, { color: t.text }]}>{x.name}</Text>
                      <Text style={{ color: t.textSecondary }}>{x.faculty?.name ?? 'Central administration'}</Text>
                    </View>
                    <Button title="Assets" variant="secondary" onPress={() => router.push({ pathname: '/inventory', params: { departmentId: x.id } })} />
                  </Row>
                  <View style={styles.facts}>
                    <Fact label="Assets" value={x.assets} />
                    <Fact label="Verified" value={x.verified} />
                    <Fact label="Not yet verified" value={x.notYetVerified} />
                    <Fact label="Due" value={x.due} />
                    <Fact label="Overdue" value={x.overdue} />
                    <Fact label="Missing" value={x.missing} />
                    <Fact label="Damaged / unusable" value={x.damaged} />
                    {x.openMaintenance !== null ? <Fact label="Open repairs" value={x.openMaintenance} /> : null}
                  </View>
                  <View style={{ gap: 2 }}>
                    <Text style={{ color: t.textSecondary }}>Recorded value</Text>
                    {x.value ? <MoneyList items={x.value} /> : <Text style={{ color: t.textSecondary }}>Restricted (no financial access)</Text>}
                  </View>
                </View>
              ))
            ) : (
              <Body muted>No departments to show.</Body>
            )}
          </Section>

          <Section n={5} title="Pending staff access requests">
            {d.accessRequests.restricted ? (
              <Body muted>Only System Administrators review access requests.</Body>
            ) : (
              <View style={styles.grid}>
                <Stat
                  label="Pending requests"
                  value={d.accessRequests.pending}
                  detail={d.accessRequests.oldestAt ? `Oldest waiting since ${formatDateTime(d.accessRequests.oldestAt)}` : 'Nothing waiting'}
                  href="/admin/access-requests"
                />
              </View>
            )}
          </Section>

          <Card>
            <Heading level={2}>How these figures are calculated</Heading>
            <Body muted>• Archived records are never counted. Values use the recorded acquisition cost; there is no currency conversion.</Body>
            <Body muted>• Due date = last successful verification (or registration date) + the schedule interval. “Due” begins the set number of days before it; “Overdue” starts the day after.</Body>
            <Body muted>• Missing is a separate status: an asset can be overdue and missing at the same time, so missing counts are shown on their own.</Body>
            <Body muted>• Open maintenance = any status other than Completed, Rejected or Cancelled.</Body>
            <Body muted>• Changes recorded on a phone that has not synchronised yet are not included until the server accepts them. Times are in {d.timeZone}.</Body>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Fact({ label, value }: { label: string; value: number }) {
  const t = useTheme();
  return (
    <View style={styles.fact}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{value.toLocaleString()}</Text>
      <Text style={{ color: t.textSecondary, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: { flexGrow: 1, flexBasis: 200, borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  statValue: { fontSize: 28, fontWeight: '700' },
  statLabel: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  money: { fontSize: 18, fontWeight: '700' },
  valueRow: { borderTopWidth: 1, paddingVertical: 8, gap: 2 },
  shareHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  bar: { height: 6, borderRadius: 3 },
  dept: { borderTopWidth: 1, paddingVertical: 12, gap: 8 },
  deptName: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  fact: { minWidth: 88 },
});
