import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { AttachmentList, PhotoPicker } from '@/components/attachments';
import { Badge, Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { api, ApiError, errorMessage, uploadFile, type UploadFile } from '@/lib/api';
import {
  COST_KIND_LABELS,
  MAINTENANCE_STATUS_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  STATUS_ACTIONS,
  maintenanceTone,
  priorityTone,
} from '@/lib/asset-display';
import { confirmAction } from '@/lib/confirm';
import type { MaintenanceDetail, MaintenanceStatus, Outcome } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { CONDITION_LABELS, CONDITIONS, formatMoney, type Condition } from '@shared/asset-codes';

type Msg = { kind: 'success' | 'error' | 'warning'; text: string } | null;

export default function MaintenanceDetailScreen() {
  const { id, created, uploadFailed } = useLocalSearchParams<{ id: string; created?: string; uploadFailed?: string }>();
  const q = useQuery(`maintenance:${id}`, () => api<MaintenanceDetail>(`/maintenance/${id}`));
  const { reload } = q;
  useFocusEffect(useCallback(() => reload(), [reload]));
  const [msg, setMsg] = useState<Msg>(null);

  // Status change
  const [to, setTo] = useState<MaintenanceStatus | null>(null);
  const [note, setNote] = useState('');
  const [providerName, setProviderName] = useState('');
  const [providerContact, setProviderContact] = useState('');
  // Completion
  const [work, setWork] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Condition confirmation
  const [resulting, setResulting] = useState<Condition | null>(null);
  const [confirmNote, setConfirmNote] = useState('');
  // Costs
  const [costKind, setCostKind] = useState('parts');
  const [costDesc, setCostDesc] = useState('');
  const [costAmount, setCostAmount] = useState('');
  const [costCurrency, setCostCurrency] = useState('PGK'); // kina unless the invoice is in another currency
  const [invoice, setInvoice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Photos
  const [photos, setPhotos] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const m = q.data;
  if (q.error && !m) return <Screen><Notice kind="error">{q.error}</Notice></Screen>;
  if (!m) return <Screen><Loading /></Screen>;

  /** Runs an action; on success reloads and clears the form, on failure shows field errors. */
  const run = async (key: string, fn: () => Promise<unknown>, done: string, reset?: () => void) => {
    setMsg(null);
    setErrors({});
    setBusy(key);
    try {
      await fn();
      reset?.();
      setMsg({ kind: 'success', text: done });
      reload();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const options = m.can.nextStatuses.filter((s) => s !== 'approved' || m.can.approve);
  const needsReason = to === 'rejected' || to === 'cancelled';

  const changeStatus = async () => {
    if (!to) return setMsg({ kind: 'error', text: 'Choose what happens next.' });
    if (needsReason && note.trim().length < 3) return setErrors({ note: `Give a reason for ${to === 'rejected' ? 'rejecting' : 'cancelling'}.` });
    if (needsReason && !(await confirmAction(to === 'rejected' ? 'Reject this request?' : 'Cancel this request?', 'This closes the request. It cannot be reopened.', 'Yes'))) return;
    run(
      'status',
      () =>
        api(`/maintenance/${m.id}/status`, {
          body: {
            to,
            version: m.version,
            note: note.trim() || undefined,
            provider: to === 'awaiting_external' && providerName.trim() ? { type: 'external', name: providerName.trim(), contact: providerContact.trim() || undefined } : undefined,
          },
        }),
      `Status changed to “${MAINTENANCE_STATUS_LABELS[to]}”.`,
      () => {
        setTo(null);
        setNote('');
      },
    );
  };

  const complete = () =>
    run(
      'complete',
      () =>
        api(`/maintenance/${m.id}/complete`, {
          body: {
            version: m.version,
            workPerformed: work.trim(),
            outcome,
            provider: providerName.trim() && !m.provider ? { type: 'external', name: providerName.trim(), contact: providerContact.trim() || undefined } : undefined,
          },
        }),
      'Marked completed. Now confirm the asset’s condition after the work.',
      () => setWork(''),
    );

  const confirmCondition = () => {
    if (!resulting) return setErrors({ condition: 'Choose the condition the asset is in now.' });
    run(
      'confirm',
      () => api(`/maintenance/${m.id}/confirm-condition`, { body: { version: m.version, condition: resulting, note: confirmNote.trim() || undefined } }),
      'Condition confirmed and added to the asset’s history.',
    );
  };

  const addCost = () =>
    run(
      'cost',
      () =>
        api(`/maintenance/${m.id}/costs`, {
          body: { kind: costKind, description: costDesc.trim(), amount: costAmount.trim(), currency: costCurrency.trim(), invoiceRef: invoice.trim() || undefined },
        }),
      'Cost added.',
      () => {
        setCostDesc('');
        setCostAmount('');
        setInvoice('');
      },
    );

  const uploadPhotos = () =>
    run(
      'photos',
      async () => {
        for (const p of photos) await uploadFile(`/maintenance/${m.id}/attachments`, p);
      },
      'Photos added.',
      () => setPhotos([]),
    );

  return (
    <Screen>
      <Row>
        <Heading>{m.reference}</Heading>
        <Badge label={MAINTENANCE_STATUS_LABELS[m.status]} tone={maintenanceTone(m.status)} />
        <Badge label={`Priority: ${PRIORITY_LABELS[m.priority]}`} tone={priorityTone(m.priority)} />
      </Row>
      {created ? <Notice kind="success">Maintenance request {m.reference} created. Your department manages it from here.</Notice> : null}
      {uploadFailed ? <Notice kind="warning">{uploadFailed} photo(s) could not be uploaded. You can add them again below.</Notice> : null}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}

      <Card>
        <Body style={{ fontWeight: '700' }}>
          {m.asset.institutionalId} — {m.asset.name}
        </Body>
        <Body muted>
          {m.department.name} · condition now {CONDITION_LABELS[m.asset.condition].toLowerCase()} (was {CONDITION_LABELS[m.conditionAtReport].toLowerCase()} when reported)
        </Body>
        <Row>
          <Button title="Open asset" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: m.asset.id } })} />
        </Row>
      </Card>

      <Card>
        <Heading level={2}>Problem</Heading>
        <Body>{m.problem}</Body>
        <Body muted>
          Reported {formatDateTime(m.reportedAt)} by {m.reportedBy}
        </Body>
        {m.requiresApproval ? (
          <Body muted>{m.approvedAt ? `Approved ${formatDateTime(m.approvedAt)} by ${m.approvedBy}` : 'Needs approval by someone other than the reporter before work starts.'}</Body>
        ) : null}
        {m.provider ? (
          <Body muted>
            {m.provider.type === 'external' ? 'External service' : 'Internal'}: {m.provider.name}
            {m.provider.contact ? ` · ${m.provider.contact}` : ''}
          </Body>
        ) : null}
        {m.closingReason ? <Body>Reason: {m.closingReason}</Body> : null}
      </Card>

      {m.status === 'completed' ? (
        <Card>
          <Heading level={2}>Outcome</Heading>
          <Body>{m.outcome ? OUTCOME_LABELS[m.outcome] : ''}</Body>
          <Body>{m.workPerformed}</Body>
          <Body muted>
            Completed {formatDateTime(m.completedAt)} by {m.completedBy}
          </Body>
          {m.conditionConfirmedAt ? (
            <Body>
              Resulting condition confirmed as {CONDITION_LABELS[m.resultingCondition!].toLowerCase()} by {m.conditionConfirmedBy} on {formatDateTime(m.conditionConfirmedAt)}.
            </Body>
          ) : (
            <Notice kind="warning">Completed, but the asset’s resulting condition has not been confirmed yet.</Notice>
          )}
        </Card>
      ) : null}

      {m.can.confirmCondition ? (
        <Card>
          <Heading level={2}>Confirm the asset’s condition</Heading>
          <Body muted>Finishing the work does not by itself mean the asset is usable. Check it and record its condition now.</Body>
          <Choice label="Condition after the work" value={resulting} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} onChange={setResulting} error={errors.condition} />
          <Field label="Note (optional)" value={confirmNote} onChangeText={setConfirmNote} placeholder="e.g. Tested for 30 minutes, working normally" />
          <Button title="Confirm condition" onPress={confirmCondition} loading={busy === 'confirm'} />
        </Card>
      ) : null}

      {m.can.changeStatus && options.length ? (
        <Card>
          <Heading level={2}>Next step</Heading>
          <Choice label="What happens next?" value={to} options={options.map((s) => ({ value: s, label: STATUS_ACTIONS[s] }))} onChange={setTo} />
          {to === 'awaiting_external' && !m.provider ? (
            <Row>
              <View style={{ flexGrow: 1, flexBasis: 200 }}>
                <Field label="Service provider" value={providerName} onChangeText={setProviderName} error={errors.provider} placeholder="e.g. LabFix Ltd" />
              </View>
              <View style={{ flexGrow: 1, flexBasis: 200 }}>
                <Field label="Contact (optional)" value={providerContact} onChangeText={setProviderContact} />
              </View>
            </Row>
          ) : null}
          <Field label={needsReason ? 'Reason' : 'Note (optional)'} value={note} onChangeText={setNote} error={errors.note} />
          <Button title="Update status" onPress={changeStatus} loading={busy === 'status'} />
        </Card>
      ) : null}

      {m.can.complete ? (
        <Card>
          <Heading level={2}>Complete the request</Heading>
          <Field
            label="Work performed"
            value={work}
            onChangeText={setWork}
            error={errors.workPerformed}
            multiline
            style={{ minHeight: 72, textAlignVertical: 'top' }}
            placeholder="e.g. Replaced the drive belt and bearings"
          />
          <Choice label="Outcome" value={outcome} options={(Object.keys(OUTCOME_LABELS) as Outcome[]).map((o) => ({ value: o, label: OUTCOME_LABELS[o] }))} onChange={setOutcome} error={errors.outcome} />
          {!m.provider ? <Field label="External provider (optional)" value={providerName} onChangeText={setProviderName} placeholder="Leave empty if done by your department" /> : null}
          <Button title="Mark completed" onPress={complete} loading={busy === 'complete'} disabled={!outcome || work.trim().length < 5} />
        </Card>
      ) : null}

      <Card>
        <Heading level={2}>Costs</Heading>
        {m.costs === null ? (
          <Body muted>Cost details are not shown to you for this department.</Body>
        ) : m.costs.length === 0 ? (
          <Body muted>No costs recorded.</Body>
        ) : (
          <>
            {m.costs.map((c) => (
              <Body key={c.id}>
                {COST_KIND_LABELS[c.kind] ?? c.kind}: {c.description} — {formatMoney(c.amount, c.currency)}
                {c.invoiceRef ? ` (invoice ${c.invoiceRef})` : ''}
              </Body>
            ))}
            <Body style={{ fontWeight: '700' }}>
              Total: {m.costTotals?.map((t) => formatMoney(t.amount, t.currency)).join(' + ')}
              {m.costTotals && m.costTotals.length > 1 ? ' (different currencies are not added together)' : ''}
            </Body>
          </>
        )}
        {m.can.addCost ? (
          <>
            <Choice label="Add a cost" value={costKind} options={Object.entries(COST_KIND_LABELS).map(([value, label]) => ({ value, label }))} onChange={setCostKind} />
            <Field label="Description" value={costDesc} onChangeText={setCostDesc} error={errors.description} placeholder="e.g. Replacement bearings" />
            <Row>
              <View style={{ flexGrow: 1, flexBasis: 140 }}>
                <Field label="Amount" value={costAmount} onChangeText={setCostAmount} error={errors.amount} keyboardType="decimal-pad" placeholder="120.00" />
              </View>
              <View style={{ flexGrow: 1, flexBasis: 100 }}>
                <Field label="Currency" value={costCurrency} onChangeText={(v) => setCostCurrency(v.toUpperCase())} error={errors.currency} autoCapitalize="characters" maxLength={3} placeholder="PGK" hint="PGK = kina. Change only if the invoice is in another currency." />
              </View>
              <View style={{ flexGrow: 1, flexBasis: 140 }}>
                <Field label="Invoice no. (optional)" value={invoice} onChangeText={setInvoice} />
              </View>
            </Row>
            <Button title="Add cost" variant="secondary" onPress={addCost} loading={busy === 'cost'} />
          </>
        ) : null}
      </Card>

      <Card>
        <Heading level={2}>Photos and documents</Heading>
        {m.attachments.length ? <AttachmentList items={m.attachments} /> : <Body muted>None yet.</Body>}
        {m.can.attach ? (
          <>
            <PhotoPicker photos={photos} onChange={setPhotos} />
            {photos.length ? <Button title={`Upload ${photos.length} photo(s)`} variant="secondary" onPress={uploadPhotos} loading={busy === 'photos'} /> : null}
          </>
        ) : null}
      </Card>

      <Card>
        <Heading level={2}>Status history</Heading>
        {m.history.map((h, i) => (
          <View key={i} style={{ paddingVertical: 4 }}>
            <Body style={{ fontWeight: '700' }}>{MAINTENANCE_STATUS_LABELS[h.to]}</Body>
            <Body muted>
              {formatDateTime(h.at)} · {h.by}
              {h.note ? ` · ${h.note}` : ''}
            </Body>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
