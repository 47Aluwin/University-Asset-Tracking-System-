import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { Body, Button, Card, Choice, Field, Heading, Loading, Notice, Screen, SearchableChoice } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { DepartmentRef } from '@/lib/types';

type Role = 'DEPARTMENT_STAFF' | 'ASSET_MANAGER';

export default function RequestAccess() {
  const [departments, setDepartments] = useState<DepartmentRef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', justification: '', password: '', confirm: '' });
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('DEPARTMENT_STAFF');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: DepartmentRef[] }>('/public/departments')
      .then((r) => setDepartments(r.items))
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  };

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (form.fullName.trim().length < 2) errs.fullName = 'Enter your full name.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = 'Enter your institutional email.';
    if (!departmentId) errs.departmentId = 'Choose your department.';
    if (form.justification.trim().length < 5) errs.justification = 'Briefly say why you need access.';
    if (form.password.length < 12) errs.password = 'At least 12 characters.';
    if (form.password !== form.confirm) errs.confirm = 'Passwords do not match.';
    setErrors(errs);
    setError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api('/access-requests', {
        body: {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          departmentId,
          requestedRole: role,
          justification: form.justification.trim(),
          password: form.password,
        },
      });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <Heading>Request submitted</Heading>
        <Notice kind="success">
          An administrator will review your request. You will be able to sign in with the password you chose once it is approved.
        </Notice>
        <Button title="Back to sign in" onPress={() => router.replace('/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>Request access</Heading>
      <Body muted>
        Requests are reviewed by a system administrator. Submitting this form does not give access until it is approved.
      </Body>
      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        <Field label="Full name" value={form.fullName} onChangeText={set('fullName')} error={errors.fullName} autoComplete="name" />
        <Field
          label="Institutional email"
          value={form.email}
          onChangeText={set('email')}
          error={errors.email}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        {departments ? (
          departments.length ? (
            <SearchableChoice
              label="School / department"
              value={departmentId}
              options={departments.map((d) => ({ value: d.id, label: d.name }))}
              onChange={setDepartmentId}
              error={errors.departmentId}
            />
          ) : (
            <Notice kind="warning">No departments have been set up yet. Contact a system administrator.</Notice>
          )
        ) : !loadError ? (
          <Loading label="Loading departments…" />
        ) : null}
        <Choice
          label="Access needed"
          value={role}
          options={[
            { value: 'DEPARTMENT_STAFF', label: 'Department Staff' },
            { value: 'ASSET_MANAGER', label: 'Asset Management Team' },
          ]}
          onChange={setRole}
        />
        <Field
          label="Reason for access"
          value={form.justification}
          onChangeText={set('justification')}
          error={errors.justification}
          multiline
          style={{ minHeight: 80, textAlignVertical: 'top' }}
        />
        <Field
          label="Choose a password"
          value={form.password}
          onChangeText={set('password')}
          error={errors.password}
          hint="At least 12 characters. Must not contain your email name."
          secureTextEntry
          autoComplete="new-password"
        />
        <Field label="Confirm password" value={form.confirm} onChangeText={set('confirm')} error={errors.confirm} secureTextEntry autoComplete="new-password" />
        <Button title="Submit request" onPress={submit} loading={busy} disabled={!departments?.length} />
      </Card>
    </Screen>
  );
}
