import { useState } from 'react';

import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { confirmAction } from '@/lib/confirm';
import { useDepartments } from '@/lib/use-departments';
import { useFaculties } from '@/lib/use-faculties';
import type { Department } from '@/lib/types';

/** Choice value for a unit outside the faculties (e.g. the Library). */
const CENTRAL = 'central';

export default function Departments() {
  const { items, error, reload } = useDepartments();
  const faculties = useFaculties();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('PGK');
  const [facultyId, setFacultyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [facCode, setFacCode] = useState('');
  const [facName, setFacName] = useState('');
  const [facErrors, setFacErrors] = useState<Record<string, string>>({});
  const [moving, setMoving] = useState<string | null>(null); // department whose faculty is being changed
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const facultyChoices = [
    ...(faculties.items ?? []).filter((f) => f.isActive).map((f) => ({ value: f.id, label: f.name })),
    { value: CENTRAL, label: 'Central administration (no faculty)' },
  ];

  const create = async () => {
    setMsg(null);
    setErrors({});
    if (!facultyId) {
      setErrors({ facultyId: 'Choose the faculty, or Central administration for units outside the faculties.' });
      return;
    }
    setBusy(true);
    try {
      await api('/departments', {
        body: { code: code.trim(), name: name.trim(), defaultCurrency: currency.trim(), facultyId: facultyId === CENTRAL ? null : facultyId },
      });
      setCode('');
      setName('');
      setFacultyId(null);
      setMsg({ kind: 'success', text: 'School / department added.' });
      await reload();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const createFaculty = async () => {
    setMsg(null);
    setFacErrors({});
    try {
      await api('/faculties', { body: { code: facCode.trim(), name: facName.trim() } });
      setFacCode('');
      setFacName('');
      setMsg({ kind: 'success', text: 'Faculty added.' });
      faculties.reload();
    } catch (e) {
      if (e instanceof ApiError) setFacErrors(e.fieldErrors);
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  const changeFaculty = async (d: Department, value: string) => {
    setMoving(null);
    try {
      await api(`/departments/${d.id}`, { method: 'PATCH', body: { facultyId: value === CENTRAL ? null : value } });
      setMsg({ kind: 'success', text: `${d.name} now belongs to ${facultyChoices.find((c) => c.value === value)?.label}. Its assets follow it in reports.` });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  const toggle = async (d: Department) => {
    const verb = d.isActive ? 'Deactivate' : 'Reactivate';
    const detail = d.isActive
      ? 'It will no longer be offered for new access requests or assignments. Existing records are kept.'
      : 'It will be available again.';
    if (!(await confirmAction(`${verb} ${d.name}?`, detail, verb))) return;
    try {
      await api(`/departments/${d.id}`, { method: 'PATCH', body: { isActive: !d.isActive } });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  // Applies to new maintenance requests only; existing ones keep the rule they started with.
  const setApproval = async (d: Department) => {
    try {
      await api(`/departments/${d.id}`, { method: 'PATCH', body: { maintenanceRequiresApproval: !d.maintenanceRequiresApproval } });
      setMsg({ kind: 'success', text: `${d.name}: maintenance approval ${d.maintenanceRequiresApproval ? 'no longer required' : 'now required'} for new requests.` });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  // Group the list by faculty, in the university's order, with central units last.
  const groups = [
    ...(faculties.items ?? []).map((f) => ({ key: f.id, title: f.name, inactive: !f.isActive, items: (items ?? []).filter((d) => d.faculty?.id === f.id) })),
    { key: CENTRAL, title: 'Central administration (no faculty)', inactive: false, items: (items ?? []).filter((d) => !d.faculty) },
  ].filter((g) => g.items.length || g.key !== CENTRAL);

  return (
    <Screen wide>
      <Heading>Faculties and departments</Heading>
      <Body muted>
        Each school or department belongs to a faculty; units outside the faculties (for example the Library) are central administration. An
        asset&apos;s faculty always follows its school.
      </Body>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {faculties.error ? <Notice kind="error">{faculties.error}</Notice> : null}

      <Card>
        <Heading level={2}>Add school / department</Heading>
        <Choice label="Faculty" value={facultyId} options={facultyChoices} onChange={setFacultyId} error={errors.facultyId} />
        <Field label="Code" value={code} onChangeText={setCode} autoCapitalize="characters" hint="2–12 letters or digits, e.g. CHEM" error={errors.code} />
        <Field label="Name" value={name} onChangeText={setName} error={errors.name} hint="e.g. School of Chemical Engineering, or a research centre" />
        <Field
          label="Default currency"
          value={currency}
          onChangeText={setCurrency}
          autoCapitalize="characters"
          maxLength={3}
          hint="PGK (kina) for PNG Unitech units. Another 3-letter code (e.g. AUD, USD) only if needed. Each asset still records its own currency."
          error={errors.defaultCurrency}
        />
        <Button title="Add school / department" onPress={create} loading={busy} />
      </Card>

      <Card>
        <Heading level={2}>Add faculty</Heading>
        <Row>
          <Field label="Faculty code" value={facCode} onChangeText={setFacCode} autoCapitalize="characters" hint="e.g. FMED" error={facErrors.code} />
          <Field label="Faculty name" value={facName} onChangeText={setFacName} hint="e.g. Faculty of Medicine" error={facErrors.name} />
        </Row>
        <Row>
          <Button title="Add faculty" variant="secondary" onPress={createFaculty} />
        </Row>
      </Card>

      {!items && !error ? <Loading /> : null}
      {items?.length === 0 ? <Body muted>No departments yet.</Body> : null}
      {items
        ? groups.map((g) => (
            <Card key={g.key}>
              <Row>
                <Heading level={2}>{g.title}</Heading>
                {g.inactive ? <Badge label="Inactive faculty" tone="neutral" /> : null}
              </Row>
              {g.items.length === 0 ? <Body muted>No schools or units yet.</Body> : null}
              {g.items.map((d) => (
                <Card key={d.id}>
                  <Row>
                    <Body>{d.name}</Body>
                    <Badge label={d.code} tone="info" />
                    <Badge label={d.isActive ? 'Active' : 'Inactive'} tone={d.isActive ? 'good' : 'neutral'} />
                  </Row>
                  <Body muted>Default currency: {d.defaultCurrency}</Body>
                  <Body muted>
                    Maintenance approval: {d.maintenanceRequiresApproval ? 'required — someone other than the reporter must approve before work starts' : 'not required'}
                  </Body>
                  {moving === d.id ? (
                    <Choice label={`Faculty for ${d.name}`} value={d.faculty?.id ?? CENTRAL} options={facultyChoices} onChange={(v) => changeFaculty(d, v)} />
                  ) : null}
                  <Row>
                    <Button title={d.isActive ? 'Deactivate' : 'Reactivate'} variant="secondary" onPress={() => toggle(d)} />
                    <Button
                      title={d.maintenanceRequiresApproval ? 'Stop requiring approval' : 'Require maintenance approval'}
                      variant="secondary"
                      onPress={() => setApproval(d)}
                    />
                    <Button title={moving === d.id ? 'Cancel' : 'Change faculty'} variant="secondary" onPress={() => setMoving(moving === d.id ? null : d.id)} />
                  </Row>
                </Card>
              ))}
            </Card>
          ))
        : null}
    </Screen>
  );
}
