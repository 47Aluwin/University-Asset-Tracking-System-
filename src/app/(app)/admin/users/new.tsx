import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Body, Button, Card, Choice, Field, Heading, Notice, Screen } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useDepartments } from '@/lib/use-departments';
import { ROLE_LABELS, type Role } from '@/lib/types';

export default function NewUser() {
  const t = useTheme();
  const departments = useDepartments();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('DEPARTMENT_STAFF');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ setupLink: string; setupLinkExpiresAt: string; emailSent: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const errs: Record<string, string> = {};
    if (fullName.trim().length < 2) errs.fullName = 'Enter the full name.';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = 'Enter a valid email.';
    if (role === 'DEPARTMENT_STAFF' && !departmentId) errs.departmentId = 'Department staff need a department.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      setResult(await api('/users', { body: { fullName: fullName.trim(), email: email.trim(), role, departmentId } }));
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Screen>
        <Heading>Account created</Heading>
        <Notice kind="success">
          {result.emailSent
            ? 'A setup link has been emailed. You can also pass on the link below.'
            : 'Email is not configured. Give this one-time setup link to the person through a secure channel.'}
        </Notice>
        <Card>
          <Body muted>Setup link (shown once, expires {new Date(result.setupLinkExpiresAt).toLocaleString()}):</Body>
          <Text selectable style={{ color: t.text, fontFamily: 'monospace' }}>
            {result.setupLink}
          </Text>
        </Card>
        <Button title="Back to users" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>New user</Heading>
      <Body muted>The person sets their own password using a one-time link. You never see or choose it.</Body>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {departments.error ? <Notice kind="error">{departments.error}</Notice> : null}
      <Card>
        <Field label="Full name" value={fullName} onChangeText={setFullName} error={errors.fullName} />
        <Field label="Institutional email" value={email} onChangeText={setEmail} error={errors.email} autoCapitalize="none" keyboardType="email-address" />
        <Choice
          label="Role"
          value={role}
          options={(Object.keys(ROLE_LABELS) as Role[]).map((k) => ({ value: k, label: ROLE_LABELS[k] }))}
          onChange={setRole}
        />
        <Choice
          label={role === 'DEPARTMENT_STAFF' ? 'Department' : 'Home department (optional)'}
          value={departmentId}
          options={departments.active.map((d) => ({ value: d.id, label: d.name }))}
          onChange={setDepartmentId}
          error={errors.departmentId}
        />
        <Button title="Create account" onPress={submit} loading={busy} />
      </Card>
    </Screen>
  );
}
