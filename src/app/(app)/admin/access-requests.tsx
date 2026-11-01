import { useState } from 'react';

import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen, SearchableChoice, formatDateTime } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { confirmAction } from '@/lib/confirm';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';
import { ROLE_LABELS, type AccessRequest, type Paged, type Role } from '@/lib/types';

type Filter = 'pending' | 'approved' | 'rejected';

export default function AccessRequests() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [notice, setNotice] = useState<string | null>(null);
  const departments = useDepartments();
  const { data, error, reload } = useQuery(`requests:${filter}`, () =>
    api<Paged<AccessRequest>>('/access-requests', { query: { status: filter } }),
  );

  return (
    <Screen wide>
      <Heading>Access requests</Heading>
      <Choice
        label="Show"
        value={filter}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'approved', label: 'Approved' },
          { value: 'rejected', label: 'Rejected' },
        ]}
        onChange={setFilter}
      />
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && data.items.length === 0 ? <Body muted>No {filter} requests.</Body> : null}
      {data?.items.map((r) => (
        <RequestCard
          key={r.id}
          request={r}
          departments={departments.active.map((d) => ({ value: d.id, label: d.name }))}
          onDone={(msg) => {
            setNotice(msg);
            reload();
          }}
        />
      ))}
    </Screen>
  );
}

function RequestCard({
  request: r,
  departments,
  onDone,
}: {
  request: AccessRequest;
  departments: { value: string; label: string }[];
  onDone: (msg: string) => void;
}) {
  const [role, setRole] = useState<Role>(r.requestedRole);
  const [departmentId, setDepartmentId] = useState<string | null>(r.department.id);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setError(null);
    if (role === 'DEPARTMENT_STAFF' && !departmentId) return setError('Choose a department for department staff.');
    const deptName = departments.find((d) => d.value === departmentId)?.label;
    const ok = await confirmAction(
      'Approve access?',
      `${r.fullName} will be able to sign in as ${ROLE_LABELS[role]}${role === 'DEPARTMENT_STAFF' ? ` in ${deptName}` : ''}.`,
      'Approve',
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/access-requests/${r.id}/approve`, { body: { role, departmentId } });
      onDone(`Approved ${r.fullName}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setError(null);
    if (reason.trim().length < 3) return setError('Enter a reason for rejecting this request.');
    if (!(await confirmAction('Reject request?', `${r.fullName} will not be given access.`, 'Reject'))) return;
    setBusy(true);
    try {
      await api(`/access-requests/${r.id}/reject`, { body: { reason: reason.trim() } });
      onDone(`Rejected ${r.fullName}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const tone = r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'warn';
  return (
    <Card>
      <Row>
        <Heading level={2}>{r.fullName}</Heading>
        <Badge label={r.status[0].toUpperCase() + r.status.slice(1)} tone={tone} />
      </Row>
      <Body muted>{r.email}</Body>
      <Body>
        Requested: {ROLE_LABELS[r.requestedRole]} · {r.department.name}
      </Body>
      <Body>Reason: {r.justification}</Body>
      <Body muted>Submitted {formatDateTime(r.createdAt)}</Body>
      {r.status !== 'pending' ? (
        <Body muted>
          {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.reviewedBy ?? 'unknown'} on {formatDateTime(r.reviewedAt)}
          {r.decisionNote ? ` — ${r.decisionNote}` : ''}
        </Body>
      ) : (
        <>
          {error ? <Notice kind="error">{error}</Notice> : null}
          <Choice
            label="Grant role"
            value={role}
            options={(Object.keys(ROLE_LABELS) as Role[]).map((k) => ({ value: k, label: ROLE_LABELS[k] }))}
            onChange={setRole}
          />
          <SearchableChoice label="School / department" value={departmentId} options={departments} onChange={setDepartmentId} />
          <Row>
            <Button title="Approve" onPress={approve} loading={busy} />
          </Row>
          <Field label="Reason for rejection" value={reason} onChangeText={setReason} placeholder="Required to reject" />
          <Row>
            <Button title="Reject" variant="danger" onPress={reject} disabled={busy} />
          </Row>
        </>
      )}
    </Card>
  );
}
