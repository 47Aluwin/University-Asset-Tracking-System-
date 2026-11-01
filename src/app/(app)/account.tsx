import { useState } from 'react';

import { Body, Button, Card, Field, Heading, Notice, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { confirmAction } from '@/lib/confirm';
import { useOffline } from '@/lib/offline/provider';
import { useSession } from '@/lib/session';
import { ROLE_LABELS } from '@/lib/types';

export default function Account() {
  const { user, signOut } = useSession();
  const { ops } = useOffline();
  const unsent = ops.filter((o) => o.status !== 'synced').length;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const change = async () => {
    setMsg(null);
    if (next.length < 12) return setMsg({ kind: 'error', text: 'New password must be at least 12 characters.' });
    if (next !== confirm) return setMsg({ kind: 'error', text: 'New passwords do not match.' });
    setBusy(true);
    try {
      await api('/auth/change-password', { body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({ kind: 'success', text: 'Password changed. Your other devices have been signed out.' });
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>My account</Heading>
      <Card>
        <Body>{user.fullName}</Body>
        <Body muted>{user.email}</Body>
        <Body muted>
          {ROLE_LABELS[user.role]}
          {user.department ? ` · ${user.department.name}` : ''}
        </Body>
        {user.grants.map((g) => (
          <Body key={g.departmentId} muted>
            Extra access: {g.level === 'operate' ? 'work in' : 'view'} {g.departmentName}
            {g.expiresAt ? ` until ${new Date(g.expiresAt).toLocaleDateString()}` : ''}
          </Body>
        ))}
      </Card>

      <Heading level={2}>Change password</Heading>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <Card>
        <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" />
        <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" hint="At least 12 characters." />
        <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" />
        <Button title="Change password" onPress={change} loading={busy} />
      </Card>

      {unsent ? <Notice kind="warning">{unsent} item(s) on this phone have not been accepted by the server yet. Signing out deletes them.</Notice> : null}
      <Button
        title="Sign out"
        variant="secondary"
        onPress={async () => {
          if (unsent && !(await confirmAction('Delete unsent work?', `${unsent} item(s) have not been sent. Signing out removes them from this phone. Connect and send them first if you can.`, 'Sign out anyway'))) return;
          await signOut();
        }}
      />
    </Screen>
  );
}
