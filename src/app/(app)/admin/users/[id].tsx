import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen, SearchableChoice, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { confirmAction } from '@/lib/confirm';
import { useSession } from '@/lib/session';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';
import { ROLE_LABELS, type Grant, type Role, type UserSummary } from '@/lib/types';

export default function UserDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user: me } = useSession();
  const departments = useDepartments();
  const q = useQuery(`user:${id}`, () => api<{ user: UserSummary; grants: Grant[] }>(`/users/${id}`));
  const user = q.data?.user ?? null;
  const grants = q.data?.grants ?? [];
  const error = !q.data ? q.error : null;
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  // Editable fields
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('DEPARTMENT_STAFF');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [grantDept, setGrantDept] = useState<string | null>(null);
  const [grantLevel, setGrantLevel] = useState<'read' | 'operate'>('read');
  const [grantReason, setGrantReason] = useState('');

  // Reset the form whenever fresh data for this user arrives.
  const [formFor, setFormFor] = useState<UserSummary | null>(null);
  if (user && user !== formFor) {
    setFormFor(user);
    setFullName(user.fullName);
    setRole(user.role);
    setDepartmentId(user.department?.id ?? null);
  }

  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    setBusy(true);
    try {
      const text = await fn();
      setMsg({ kind: 'success', text });
      q.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Screen><Notice kind="error">{error}</Notice></Screen>;
  if (!user) return <Screen><Loading /></Screen>;
  const isSelf = me?.id === user.id;
  const accessChanging = role !== user.role || departmentId !== (user.department?.id ?? null);

  const save = async () => {
    if (accessChanging && !(await confirmAction('Change access?', `${user.fullName}'s role or department will change and they will be signed out of all devices.`, 'Change'))) return;
    run(async () => {
      const r = await api<{ changed: boolean }>(`/users/${user.id}`, { method: 'PATCH', body: { fullName: fullName.trim(), role, departmentId } });
      return r.changed ? 'Saved.' : 'No changes.';
    });
  };

  const deactivate = async () => {
    if (reason.trim().length < 3) return setMsg({ kind: 'error', text: 'Enter a reason for deactivating.' });
    if (!(await confirmAction('Deactivate account?', `${user.fullName} will be signed out everywhere and cannot sign in. Their records are kept.`, 'Deactivate'))) return;
    run(async () => {
      await api(`/users/${user.id}/deactivate`, { body: { reason: reason.trim() } });
      setReason('');
      return 'Account deactivated.';
    });
  };

  const issueLink = () =>
    run(async () => {
      const r = await api<{ link: string }>(`/users/${user.id}/reset-link`, { method: 'POST' });
      setLink(r.link);
      return 'One-time link created. Pass it on through a secure channel.';
    });

  const addGrant = async () => {
    if (!grantDept) return setMsg({ kind: 'error', text: 'Choose a department for the grant.' });
    if (grantReason.trim().length < 5) return setMsg({ kind: 'error', text: 'Give a reason for the exception (at least 5 characters).' });
    run(async () => {
      await api(`/users/${user.id}/grants`, { body: { departmentId: grantDept, accessLevel: grantLevel, reason: grantReason.trim() } });
      setGrantReason('');
      return 'Cross-department access granted.';
    });
  };

  return (
    <Screen>
      <Heading>{user.fullName}</Heading>
      <Body muted>{user.email}</Body>
      <Row>
        <Badge label={user.status === 'active' ? 'Active' : 'Deactivated'} tone={user.status === 'active' ? 'good' : 'bad'} />
        {user.lockedUntil ? <Badge label={`Locked until ${formatDateTime(user.lockedUntil)}`} tone="warn" /> : null}
        {!user.passwordSet ? <Badge label="Password not set yet" tone="warn" /> : null}
      </Row>
      <Body muted>Last sign-in: {formatDateTime(user.lastLoginAt)}</Body>
      {user.status === 'deactivated' ? <Body muted>Deactivated {formatDateTime(user.deactivatedAt)}: {user.deactivationReason}</Body> : null}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}

      <Heading level={2}>Details and access</Heading>
      <Card>
        <Field label="Full name" value={fullName} onChangeText={setFullName} />
        {isSelf ? <Notice kind="info">You cannot change your own role.</Notice> : null}
        <Choice
          label="Role"
          value={role}
          options={(Object.keys(ROLE_LABELS) as Role[]).map((k) => ({ value: k, label: ROLE_LABELS[k] }))}
          onChange={(v) => !isSelf && setRole(v)}
        />
        <SearchableChoice
          label="School / department"
          value={departmentId}
          options={departments.active.map((d) => ({ value: d.id, label: d.name }))}
          onChange={setDepartmentId}
        />
        <Button title="Save changes" onPress={save} loading={busy} />
      </Card>

      <Heading level={2}>Sign-in</Heading>
      <Card>
        {user.lockedUntil ? (
          <Button title="Unlock account" variant="secondary" disabled={busy} onPress={() => run(async () => (await api(`/users/${user.id}/unlock`, { method: 'POST' }), 'Account unlocked.'))} />
        ) : null}
        <Button title="Create password reset link" variant="secondary" disabled={busy || user.status !== 'active'} onPress={issueLink} />
        {link ? (
          <Text selectable style={{ color: t.text, fontFamily: 'monospace' }}>
            {link}
          </Text>
        ) : null}
      </Card>

      <Heading level={2}>Cross-department access</Heading>
      <Card>
        {grants.length === 0 ? <Body muted>No exceptions.</Body> : null}
        {grants.map((g) => (
          <Card key={g.id}>
            <Row>
              <Body>
                {g.accessLevel === 'operate' ? 'Work in' : 'View'} {g.department.name}
              </Body>
              <Badge label={g.active ? 'Active' : g.revokedAt ? 'Revoked' : 'Expired'} tone={g.active ? 'good' : 'neutral'} />
            </Row>
            <Body muted>
              {g.reason} — granted by {g.grantedBy}, {formatDateTime(g.grantedAt)}
              {g.expiresAt ? `, expires ${formatDateTime(g.expiresAt)}` : ''}
            </Body>
            {g.active ? (
              <Button
                title="Revoke"
                variant="danger"
                disabled={busy}
                onPress={async () => {
                  if (await confirmAction('Revoke access?', `Remove access to ${g.department.name}?`, 'Revoke'))
                    run(async () => (await api(`/users/${user.id}/grants/${g.id}/revoke`, { method: 'POST' }), 'Access revoked.'));
                }}
              />
            ) : null}
          </Card>
        ))}
        {user.role === 'DEPARTMENT_STAFF' ? (
          <>
            <Choice
              label="Add access to department"
              value={grantDept}
              options={departments.active.filter((d) => d.id !== user.department?.id).map((d) => ({ value: d.id, label: d.name }))}
              onChange={setGrantDept}
            />
            <Choice
              label="Level"
              value={grantLevel}
              options={[
                { value: 'read', label: 'View only' },
                { value: 'operate', label: 'View and work' },
              ]}
              onChange={setGrantLevel}
            />
            <Field label="Reason (recorded in audit log)" value={grantReason} onChangeText={setGrantReason} />
            <Button title="Grant access" variant="secondary" onPress={addGrant} disabled={busy} />
          </>
        ) : (
          <Body muted>Only department staff need exceptions; other roles already cover all departments.</Body>
        )}
      </Card>

      {!isSelf ? (
        <>
          <Heading level={2}>Account status</Heading>
          <Card>
            {user.status === 'active' ? (
              <>
                <Field label="Reason for deactivation" value={reason} onChangeText={setReason} placeholder="e.g. Left the university" />
                <Button title="Deactivate account" variant="danger" onPress={deactivate} disabled={busy} />
              </>
            ) : (
              <Button
                title="Reactivate account"
                onPress={async () => {
                  if (await confirmAction('Reactivate account?', `${user.fullName} will be able to sign in again.`, 'Reactivate'))
                    run(async () => (await api(`/users/${user.id}/activate`, { method: 'POST' }), 'Account reactivated.'));
                }}
                disabled={busy}
              />
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
