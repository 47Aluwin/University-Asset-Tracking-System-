import { useState } from 'react';

import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen, SearchableChoice } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Category, Schedule } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';

const PRESETS = [
  { label: 'Weekly', days: 7, window: 2 },
  { label: 'Monthly', days: 30, window: 7 },
  { label: 'Quarterly', days: 91, window: 14 },
  { label: 'Annually', days: 365, window: 30 },
];

/** How often assets must be physically verified, by department and/or category. */
export default function Schedules() {
  const list = useQuery('schedules', () => api<{ items: Schedule[] }>('/verification-schedules'));
  const departments = useDepartments();
  const categories = useQuery('categories', () => api<{ items: Category[] }>('/categories'));
  const [deptId, setDeptId] = useState<string>('any');
  const [catId, setCatId] = useState<string>('any');
  const [intervalText, setIntervalText] = useState('365');
  const [windowText, setWindowText] = useState('30');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setMsg(null);
    setErrors({});
    const intervalDays = Number(intervalText);
    const dueWindowDays = Number(windowText);
    if (!Number.isInteger(intervalDays) || !Number.isInteger(dueWindowDays)) {
      return setMsg({ kind: 'error', text: 'Use whole numbers of days.' });
    }
    setBusy(true);
    try {
      await api('/verification-schedules', {
        body: {
          departmentId: deptId === 'any' ? null : deptId,
          categoryId: catId === 'any' ? null : catId,
          intervalDays,
          dueWindowDays,
          notes: notes.trim() || null,
        },
      });
      setNotes('');
      setMsg({ kind: 'success', text: 'Schedule added. Due dates update immediately.' });
      list.reload();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: Schedule) => {
    try {
      await api(`/verification-schedules/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } });
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  const scope = (s: Schedule) =>
    `${s.department ? s.department.name : 'All departments'} · ${s.category ? s.category.name : 'all categories'}`;

  return (
    <Screen wide>
      <Heading>Verification schedules</Heading>
      <Body muted>
        Each registered asset must be physically verified within its interval, counted from its last verification (or its registration). It shows as
        “due” during the warning window and “overdue” after the due date. Overdue never marks an asset missing. Where several schedules apply, the most
        specific one wins: department + category, then department, then category, then the institution-wide rule.
      </Body>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <Card>
        <Heading level={2}>Add a schedule</Heading>
        <SearchableChoice
          label="School / department"
          value={deptId}
          options={[{ value: 'any', label: 'All departments' }, ...departments.active.map((d) => ({ value: d.id, label: d.name }))]}
          onChange={setDeptId}
        />
        <Choice
          label="Category"
          value={catId}
          options={[{ value: 'any', label: 'All categories' }, ...(categories.data?.items ?? []).filter((c) => c.isActive).map((c) => ({ value: c.id, label: c.name }))]}
          onChange={setCatId}
        />
        <Row>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              title={p.label}
              variant="secondary"
              onPress={() => {
                setIntervalText(String(p.days));
                setWindowText(String(p.window));
              }}
            />
          ))}
        </Row>
        <Row>
          <Field label="Verify every (days)" value={intervalText} onChangeText={setIntervalText} keyboardType="number-pad" error={errors.intervalDays} />
          <Field label="Warn this many days before" value={windowText} onChangeText={setWindowText} keyboardType="number-pad" error={errors.dueWindowDays} />
        </Row>
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="e.g. Annual stock-take policy" />
        <Button title="Add schedule" onPress={add} loading={busy} />
      </Card>

      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data?.items.length === 0 ? (
        <Notice kind="info">No schedules yet, so no asset is ever due or overdue. Add at least an institution-wide schedule.</Notice>
      ) : null}
      {list.data?.items.map((s) => (
        <Card key={s.id}>
          <Row>
            <Heading level={2}>{scope(s)}</Heading>
            <Badge label={s.isActive ? 'Active' : 'Inactive'} tone={s.isActive ? 'good' : 'neutral'} />
          </Row>
          <Body>
            Every {s.intervalDays} days · “due” {s.dueWindowDays} days before
          </Body>
          {s.notes ? <Body muted>{s.notes}</Body> : null}
          <Row>
            <Button title={s.isActive ? 'Deactivate' : 'Reactivate'} variant="secondary" onPress={() => toggle(s)} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
