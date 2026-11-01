import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DateField } from '@/components/date-field';
import { Body, Button, Card, Choice, Heading, Loading, Notice, Row, Screen, SearchableChoice, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { exportReport } from '@/lib/report-files';
import type { ReportFormat } from '@/lib/report-download';
import { useSession } from '@/lib/session';
import type { Category, Report, ReportColumn, ReportKind, ReportTable } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useFaculties } from '@/lib/use-faculties';
import { useQuery } from '@/lib/use-query';
import { CONDITION_LABELS, CONDITIONS, isValidDate } from '@shared/asset-codes';

type Def = {
  title: string;
  detail: string;
  dateLabel: string;
  statuses?: { value: string; label: string }[];
  condition: boolean;
};

const REPORTS: Record<ReportKind, Def> = {
  'asset-register': {
    title: '1. Complete asset register',
    detail: 'Every asset with its IDs, location, condition, acquisition cost and status.',
    dateLabel: 'Acquired',
    statuses: [
      { value: 'registered', label: 'Registered' },
      { value: 'awaiting_label', label: 'Awaiting label' },
    ],
    condition: true,
  },
  'department-summary': {
    title: '2. Faculty and department inventory and asset value',
    detail:
      'Totals per faculty and per school / department: asset counts, condition breakdown, registration status, recorded value per currency, and counts by category.',
    dateLabel: 'Acquired',
    condition: true,
  },
  verification: {
    title: '3. Verification and overdue assets',
    detail: 'Status, last scan and who did it, schedule and due date, days overdue, location discrepancies, missing status.',
    dateLabel: 'Due date',
    statuses: [
      { value: 'due_or_overdue', label: 'Due or overdue' },
      { value: 'overdue', label: 'Overdue' },
      { value: 'due', label: 'Due' },
      { value: 'not_yet_verified', label: 'Not yet verified' },
      { value: 'verified', label: 'Verified' },
      { value: 'missing', label: 'Missing' },
      { value: 'discrepancy', label: 'Location discrepancy' },
    ],
    condition: true,
  },
  maintenance: {
    title: '4. Damaged assets, repairs and maintenance costs',
    detail: 'Requests and their status, providers, outcomes, condition confirmation, repair history and costs per currency.',
    dateLabel: 'Reported',
    statuses: [
      { value: 'open', label: 'Open requests' },
      { value: 'closed', label: 'Closed requests' },
    ],
    condition: false,
  },
};
const KINDS = Object.keys(REPORTS) as ReportKind[];

function cell(v: string | number | null, col: ReportColumn): string {
  if (v === null || v === '') return col.kind === 'money' ? 'Restricted' : '—';
  if (col.kind === 'money') {
    const [w, f = '00'] = String(v).split('.');
    return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0')}`;
  }
  if (col.kind === 'int') return Number(v).toLocaleString();
  return String(v);
}

function PreviewTable({ table }: { table: ReportTable }) {
  const t = useTheme();
  const widths = table.columns.map((c) => Math.round((c.width ?? 1) * 120));
  const right = (c: ReportColumn) => (c.kind === 'money' || c.kind === 'int' ? 'right' : 'left');
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.tableTitle, { color: t.heading }]}>{table.title}</Text>
      <Text style={{ color: t.textSecondary }}>
        {table.rows.length < table.totalRows
          ? `Showing the first ${table.rows.length} of ${table.totalRows.toLocaleString()} rows. The PDF and Excel files contain all rows.`
          : `${table.totalRows.toLocaleString()} ${table.totalRows === 1 ? 'row' : 'rows'}`}
      </Text>
      {table.rows.length ? (
        <ScrollView horizontal accessibilityLabel={`${table.title} table`}>
          <View>
            <View style={[styles.tr, { backgroundColor: t.header }]}>
              {table.columns.map((c, i) => (
                <Text key={c.label} style={[styles.th, { width: widths[i], color: t.onHeader, textAlign: right(c) }]}>
                  {c.label}
                </Text>
              ))}
            </View>
            {table.rows.map((r, ri) => (
              <View key={ri} style={[styles.tr, { borderColor: t.border, backgroundColor: ri % 2 ? t.backgroundElement : 'transparent' }]}>
                {r.map((v, i) => (
                  <Text key={i} style={[styles.td, { width: widths[i], color: t.text, textAlign: right(table.columns[i]) }]}>
                    {cell(v, table.columns[i])}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      ) : (
        <Body muted>{table.emptyText ?? 'No records.'}</Body>
      )}
    </View>
  );
}

export default function Reports() {
  const t = useTheme();
  const { can } = useSession();
  const params = useLocalSearchParams<{ kind?: string }>();
  const departments = useDepartments();
  const faculties = useFaculties();
  const categories = useQuery('categories', () => api<{ items: Category[] }>('/categories'));
  const [kind, setKind] = useState<ReportKind>(KINDS.find((k) => k === params.kind) ?? 'asset-register');
  const [departmentId, setDepartmentId] = useState('all');
  const [facultyId, setFacultyId] = useState('all');
  const [categoryId, setCategoryId] = useState('all');
  const [condition, setCondition] = useState('all');
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const def = REPORTS[kind];
  const fromError = from && !isValidDate(from) ? 'Use the form YYYY-MM-DD.' : undefined;
  const toError = to && !isValidDate(to) ? 'Use the form YYYY-MM-DD.' : from && to && !fromError && to < from ? 'Must be on or after the start date.' : undefined;
  const datesOk = !fromError && !toError;
  const query: Record<string, string | undefined> = {
    departmentId: departmentId === 'all' ? undefined : departmentId,
    facultyId: facultyId === 'all' ? undefined : facultyId,
    categoryId: categoryId === 'all' ? undefined : categoryId,
    condition: def.condition && condition !== 'all' ? condition : undefined,
    status: def.statuses && status !== 'all' ? status : undefined,
    from: datesOk && from ? from : undefined,
    to: datesOk && to ? to : undefined,
  };
  const preview = useQuery(`report:${kind}:${JSON.stringify(query)}`, () => api<Report>(`/reports/${kind}`, { query }));

  if (!can('reports.generate')) {
    return (
      <Screen>
        <Notice kind="error">You do not have access to reports.</Notice>
      </Screen>
    );
  }
  const readable = departments.active.filter((d) => can('reports.generate', d.id));
  const hasFaculty = new Set(readable.map((d) => d.faculty?.id ?? 'central'));
  const facultyOptions = (faculties.items ?? []).filter((f) => hasFaculty.has(f.id)).map((f) => ({ value: f.id, label: f.name }));
  if (hasFaculty.has('central')) facultyOptions.push({ value: 'central', label: 'Central administration' });
  const schoolsShown = facultyId === 'all' ? readable : readable.filter((d) => (d.faculty?.id ?? 'central') === facultyId);

  const run = async (format: ReportFormat, action: 'save' | 'print') => {
    setExportError(null);
    setExported(null);
    setBusy(`${format}-${action}`);
    try {
      await exportReport(`/reports/${kind}`, query, format, action);
      if (action === 'save') setExported(Platform.OS === 'web' ? `The ${format === 'pdf' ? 'PDF' : 'Excel file'} has been downloaded.` : 'File ready.');
    } catch (e) {
      setExportError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen wide>
      <Heading>Reports and exports</Heading>
      <Body muted>Reports use live records you are allowed to see. Amounts are always shown with their currency and totalled per currency.</Body>

      <Choice<ReportKind>
        label="Report"
        value={kind}
        options={KINDS.map((k) => ({ value: k, label: REPORTS[k].title }))}
        onChange={(k) => {
          setKind(k);
          setStatus('all');
        }}
      />
      <Body muted>{def.detail}</Body>

      <Card>
        <Heading level={2}>Filters</Heading>
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
            options={[{ value: 'all', label: facultyId === 'all' ? 'All departments' : 'All in this faculty' }, ...schoolsShown.map((d) => ({ value: d.id, label: d.name }))]}
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
        {def.condition ? (
          <Choice
            label="Condition"
            value={condition}
            options={[{ value: 'all', label: 'Any condition' }, ...CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))]}
            onChange={setCondition}
          />
        ) : null}
        {def.statuses ? <Choice label="Status" value={status} options={[{ value: 'all', label: 'All' }, ...def.statuses]} onChange={setStatus} /> : null}
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={{ flexGrow: 1, flexBasis: 180 }}>
            <DateField label={`${def.dateLabel} from`} value={from} onChangeText={setFrom} error={fromError} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 180 }}>
            <DateField label={`${def.dateLabel} to`} value={to} onChangeText={setTo} error={toError} />
          </View>
        </Row>
      </Card>

      <Row>
        <Button title="Download PDF" onPress={() => run('pdf', 'save')} loading={busy === 'pdf-save'} disabled={!!busy || !datesOk} />
        <Button title="Download Excel" variant="secondary" onPress={() => run('xlsx', 'save')} loading={busy === 'xlsx-save'} disabled={!!busy || !datesOk} />
        <Button title="Print" variant="secondary" onPress={() => run('pdf', 'print')} loading={busy === 'pdf-print'} disabled={!!busy || !datesOk} />
      </Row>
      {exportError ? <Notice kind="error">{exportError}</Notice> : null}
      {exported ? <Notice kind="success">{exported}</Notice> : null}

      {preview.error ? <Notice kind="error">{preview.error}</Notice> : null}
      {!preview.data && !preview.error ? <Loading label="Preparing preview…" /> : null}
      {preview.data ? (
        <Card>
          <Heading level={2}>{preview.data.title}</Heading>
          <Body muted>
            Generated {formatDateTime(preview.data.generatedAt)} · {preview.data.filters.map(([k, v]) => `${k}: ${v}`).join(' · ')}
          </Body>
          {preview.data.notes.map((n) => (
            <Text key={n} style={{ color: t.textSecondary }}>
              • {n}
            </Text>
          ))}
          {preview.data.tables.map((tb) => (
            <PreviewTable key={tb.title} table={tb} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tableTitle: { fontSize: 17, fontWeight: '700', marginTop: 8 },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  th: { padding: 6, fontWeight: '700', fontSize: 13 },
  td: { padding: 6, fontSize: 13 },
});
