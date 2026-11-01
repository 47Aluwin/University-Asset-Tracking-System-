import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { AssetReviewCard } from '@/components/asset-review-card';

import { AttachmentList } from '@/components/attachments';
import { QrCode } from '@/components/qr-code';
import { Badge, Body, Button, Card, Field, Heading, Loading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import {
  CONDITION_SOURCE_LABELS,
  MAINTENANCE_STATUS_LABELS,
  MISSING_LABELS,
  PRIORITY_LABELS,
  VERIFICATION_LABELS,
  maintenanceTone,
  conditionTone,
  describeAction,
  describeChanges,
  describeContext,
  verificationTone,
} from '@/lib/asset-display';
import { confirmAction } from '@/lib/confirm';
import type { Asset, AssetHistory, Category, ConditionEvent, Location, MaintenanceRequest, Movement, Paged, Verification } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';
import {
  ACQUISITION_METHOD_LABELS,
  CONDITION_LABELS,
  COST_STATUS_LABELS,
  REGISTRATION_STATUS_LABELS,
  USAGE_STATUS_LABELS,
  formatMoney,
} from '@shared/asset-codes';

function Detail({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Text style={{ color: t.textSecondary, minWidth: 170, fontSize: 15 }}>{label}</Text>
      <Text selectable style={{ color: t.text, fontSize: 15, flexShrink: 1, fontFamily: mono ? 'monospace' : undefined }}>
        {value || '—'}
      </Text>
    </View>
  );
}

export default function AssetDetail() {
  const t = useTheme();
  const { id, moved, savedOffline } = useLocalSearchParams<{ id: string; moved?: string; savedOffline?: string }>();
  const asset = useQuery(`asset:${id}`, () => api<Asset>(`/assets/${id}`));
  const history = useQuery(`asset-history:${id}`, () => api<AssetHistory>(`/assets/${id}/history`));
  const verifications = useQuery(`asset-verifications:${id}`, () => api<{ items: Verification[] }>(`/assets/${id}/verifications`));
  const movements = useQuery(`asset-movements:${id}`, () => api<{ items: Movement[] }>(`/assets/${id}/movements`));
  const conditions = useQuery(`asset-conditions:${id}`, () => api<{ items: ConditionEvent[] }>(`/assets/${id}/condition-history`));
  const maintenance = useQuery(`asset-maintenance:${id}`, () =>
    api<Paged<MaintenanceRequest>>('/maintenance', { query: { assetId: id, pageSize: 50 } }).catch(() => ({ items: [], total: 0, page: 1, pageSize: 50 })),
  );
  const [missingNote, setMissingNote] = useState('');
  const categories = useQuery('categories', () => api<{ items: Category[] }>('/categories'));
  const deptId = asset.data?.department.id;
  const locations = useQuery(`locations-all:${deptId ?? ''}`, () =>
    deptId ? api<{ items: Location[] }>('/locations', { query: { departmentId: deptId, includeInactive: 'true' } }) : Promise.resolve({ items: [] }),
  );
  const departments = useDepartments();
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const { reload: reloadAsset } = asset;
  const { reload: reloadHistory } = history;
  const { reload: reloadVerifications } = verifications;
  const { reload: reloadMovements } = movements;
  const { reload: reloadConditions } = conditions;
  const { reload: reloadMaintenance } = maintenance;
  const reloadAll = useCallback(() => {
    reloadAsset();
    reloadHistory();
    reloadVerifications();
    reloadMovements();
    reloadConditions();
    reloadMaintenance();
  }, [reloadAsset, reloadHistory, reloadVerifications, reloadMovements, reloadConditions, reloadMaintenance]);
  useFocusEffect(reloadAll);

  const names = useMemo(() => {
    const n: Record<string, string> = {};
    categories.data?.items.forEach((c) => (n[c.id] = c.name));
    locations.data?.items.forEach((l) => (n[l.id] = `${l.building} · ${l.room}`));
    departments.items?.forEach((d) => (n[d.id] = d.name));
    return n;
  }, [categories.data, locations.data, departments.items]);

  if (asset.error && !asset.data) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!asset.data) return <Screen><Loading /></Screen>;
  const a = asset.data;
  const fin = a.financial;

  const archiveOrRestore = async (kind: 'archive' | 'restore') => {
    setMsg(null);
    if (reason.trim().length < 3) return setMsg({ kind: 'error', text: `Give a reason for ${kind === 'archive' ? 'archiving' : 'restoring'} (at least 3 characters).` });
    const ok =
      kind === 'archive'
        ? await confirmAction('Archive this asset?', `${a.institutionalId} will be removed from the current asset list. The record and its full history are kept and an administrator can restore it.`, 'Archive')
        : await confirmAction('Restore this asset?', `${a.institutionalId} will return to the current asset list.`, 'Restore');
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/assets/${a.id}/${kind}`, { body: { reason: reason.trim() } });
      setReason('');
      setMsg({ kind: 'success', text: kind === 'archive' ? 'Asset archived.' : 'Asset restored.' });
      reloadAll();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  // Report / confirm / clear "missing". Each needs a short explanation that goes into the audit log.
  const missingAction = async (action: 'report-missing' | 'confirm-missing' | 'clear-missing') => {
    setMsg(null);
    const text = missingNote.trim();
    if (text.length < (action === 'report-missing' ? 5 : 3)) {
      return setMsg({ kind: 'error', text: action === 'report-missing' ? 'Say where it was last seen or why it is missing.' : 'Add a short note explaining the decision.' });
    }
    const titles = {
      'report-missing': ['Report this asset missing?', 'The Asset Management Team will be asked to review it.', 'Report missing'],
      'confirm-missing': ['Confirm this asset is missing?', 'Use this only after it has been searched for.', 'Confirm missing'],
      'clear-missing': ['Clear the missing status?', 'The asset will no longer be shown as missing.', 'Clear'],
    } as const;
    const [title, detail, label] = titles[action];
    if (!(await confirmAction(title, detail, label))) return;
    setBusy(true);
    try {
      await api(`/assets/${a.id}/${action}`, { body: action === 'report-missing' ? { reason: text } : { note: text } });
      setMissingNote('');
      setMsg({ kind: 'success', text: action === 'report-missing' ? 'Reported missing.' : action === 'confirm-missing' ? 'Confirmed missing.' : 'Missing status cleared.' });
      reloadAll();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const v = a.verification;

  return (
    <Screen wide>
      <Row style={{ alignItems: 'flex-start', gap: 24 }}>
        <View style={{ flexGrow: 1, flexBasis: 300, gap: 8 }}>
          <Heading>{a.name}</Heading>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: '700', color: t.text }}>
            {a.institutionalId}
          </Text>
          <Row>
            <Badge label={REGISTRATION_STATUS_LABELS[a.registrationStatus]} tone={a.registrationStatus === 'registered' ? 'good' : 'warn'} />
            <Badge label={`Condition: ${CONDITION_LABELS[a.condition]}`} tone={conditionTone(a.condition)} />
            {a.usageStatus !== 'in_use' ? <Badge label={USAGE_STATUS_LABELS[a.usageStatus]} tone="neutral" /> : null}
            {a.archived ? <Badge label="Archived" tone="neutral" /> : null}
            {v.status !== 'not_applicable' ? <Badge label={VERIFICATION_LABELS[v.status]} tone={verificationTone(v.status)} /> : null}
            {a.missing.status !== 'none' ? <Badge label={MISSING_LABELS[a.missing.status]} tone="bad" /> : null}
          </Row>
          <Body muted>
            {a.faculty?.name ?? 'Central administration'} · {a.department.name} · {a.location.building}, {a.location.room}
          </Body>
        </View>
        <QrCode payload={a.qrPayload} size={140} label={`QR code for asset ${a.institutionalId}`} />
      </Row>

      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {moved ? <Notice kind="success">Relocation recorded. The previous location is kept in the movement history.</Notice> : null}
      {savedOffline ? (
        <Notice kind="info">
          Saved on this phone with the time it happened. It will be sent automatically when you are back online; until then this page shows the
          last details received from the server. See “Waiting to sync” on the home screen.
        </Notice>
      ) : null}
      {a.openFlags > 0 ? (
        <Notice kind="warning">
          {a.openFlags} open review {a.openFlags === 1 ? 'flag' : 'flags'} for this asset.{' '}
          <Text style={{ textDecorationLine: 'underline' }} accessibilityRole="link" onPress={() => router.push({ pathname: '/review', params: { assetId: a.id } })}>
            See {a.openFlags === 1 ? 'it' : 'them'}
          </Text>
        </Notice>
      ) : null}
      {a.archived ? (
        <Notice kind="warning">
          Archived {formatDateTime(a.archived.at)} by {a.archived.by}: {a.archived.reason}
        </Notice>
      ) : null}
      {!a.archived && a.registrationStatus === 'awaiting_label' ? (
        <Notice kind="warning">
          Registration is not complete. {a.labelPrintCount === 0 ? 'Print the QR label, attach it to the asset, then confirm it.' : 'Attach the printed label to the asset, then confirm it.'}
        </Notice>
      ) : null}

      <Row>
        {a.can.printLabel || a.can.confirmLabel ? (
          <Button
            title={a.registrationStatus === 'awaiting_label' ? 'Label: print and confirm' : a.labelPrintCount ? 'Reprint label' : 'Print label'}
            onPress={() => router.push({ pathname: '/inventory/[id]/label', params: { id: a.id } })}
          />
        ) : null}
        {a.can.verify ? (
          <Button title="Verify (seen it)" onPress={() => router.push({ pathname: '/inventory/[id]/verify', params: { id: a.id, method: 'manual' } })} />
        ) : null}
        {a.can.move ? <Button title="Relocate" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]/move', params: { id: a.id } })} /> : null}
        {a.can.edit ? <Button title="Edit details" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]/edit', params: { id: a.id } })} /> : null}
      </Row>
      {a.can.recordCondition || a.can.requestMaintenance ? (
        <Row>
          {a.can.recordCondition ? (
            <Button title="Report damage" variant="danger" onPress={() => router.push({ pathname: '/inventory/[id]/condition', params: { id: a.id, damage: '1' } })} />
          ) : null}
          {a.can.recordCondition ? (
            <Button title="Update condition" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]/condition', params: { id: a.id } })} />
          ) : null}
          {a.can.requestMaintenance ? (
            <Button title="Request maintenance" variant="secondary" onPress={() => router.push({ pathname: '/maintenance/new', params: { assetId: a.id } })} />
          ) : null}
        </Row>
      ) : null}

      {a.registrationStatus === 'registered' ? (
        <Card>
          <Heading level={2}>Physical verification</Heading>
          <Row>
            <Badge label={VERIFICATION_LABELS[v.status]} tone={verificationTone(v.status)} />
            {v.status === 'overdue' && v.overdueDays != null ? <Body>{v.overdueDays} {v.overdueDays === 1 ? 'day' : 'days'} overdue</Body> : null}
          </Row>
          <Detail
            label="Last seen"
            value={
              v.lastVerifiedAt
                ? `${formatDateTime(v.lastVerifiedAt)} by ${v.lastVerifiedBy}${v.lastVerifiedLocation ? ` at ${v.lastVerifiedLocation.building}, ${v.lastVerifiedLocation.room}` : ''}`
                : 'Never verified'
            }
          />
          <Detail label="Next verification due" value={v.dueDate ?? 'No schedule applies'} />
          <Detail label="Schedule" value={v.intervalDays ? `Every ${v.intervalDays} days` : 'None — an administrator can add one'} />
          <Body muted>A verification shows the asset was seen at that time and place. Overdue does not mean missing.</Body>
        </Card>
      ) : null}

      {a.registrationStatus === 'registered' && (a.missing.status !== 'none' || a.can.reportMissing) ? (
        <Card>
          <Heading level={2}>Missing</Heading>
          {a.missing.status !== 'none' ? (
            <>
              <Badge label={MISSING_LABELS[a.missing.status]} tone="bad" />
              <Detail label="Reported" value={`${formatDateTime(a.missing.reportedAt)} by ${a.missing.reportedBy}`} />
              <Detail label="Reason" value={a.missing.reason} />
              {a.missing.confirmedAt ? <Detail label="Confirmed" value={`${formatDateTime(a.missing.confirmedAt)} by ${a.missing.confirmedBy}`} /> : null}
              <Body muted>Scanning the asset’s label marks it as found automatically.</Body>
            </>
          ) : (
            <Body muted>Report the asset missing only after looking for it. The Asset Management Team reviews every report.</Body>
          )}
          {a.can.reportMissing || a.can.confirmMissing || a.can.clearMissing ? (
            <>
              <Field
                label={a.can.reportMissing ? 'Where was it last seen?' : 'Note'}
                value={missingNote}
                onChangeText={setMissingNote}
                placeholder={a.can.reportMissing ? 'e.g. Not in Lab 101 at the October stock-take' : 'e.g. Searched all labs with the department'}
              />
              <Row>
                {a.can.reportMissing ? <Button title="Report missing" variant="danger" onPress={() => missingAction('report-missing')} loading={busy} /> : null}
                {a.can.confirmMissing ? <Button title="Confirm missing" variant="danger" onPress={() => missingAction('confirm-missing')} loading={busy} /> : null}
                {a.can.clearMissing ? <Button title="Clear missing status" variant="secondary" onPress={() => missingAction('clear-missing')} disabled={busy} /> : null}
              </Row>
            </>
          ) : null}
        </Card>
      ) : null}

      <AssetReviewCard asset={a} onChanged={reloadAll} />

      <Card>
        <Heading level={2}>Identification</Heading>
        <Detail label="Asset ID" value={a.institutionalId} mono />
        <Detail label="QR content" value={a.qrPayload} mono />
        <Detail label="Category" value={a.category.name} />
        <Detail label="Manufacturer" value={a.manufacturer} />
        <Detail label="Model" value={a.model} />
        <Detail label="Serial number" value={a.serialNumber} mono />
        <Detail label="Manufacturer barcode" value={a.manufacturerBarcode} mono />
        <Detail label="Description" value={a.description} />
      </Card>

      <Card>
        <Heading level={2}>Ownership and custody</Heading>
        <Detail label="Faculty" value={a.faculty?.name ?? 'Central administration (no faculty)'} />
        <Detail label="School / department" value={a.department.name} />
        <Detail label="Building / location" value={a.location.building} />
        <Detail label="Room number" value={a.location.room} />
        <Detail label="Assigned staff member" value={a.assignedTo ?? 'Not assigned'} />
        <Detail label="Asset status" value={USAGE_STATUS_LABELS[a.usageStatus]} />
      </Card>

      <Card>
        <Heading level={2}>Acquisition</Heading>
        <Detail label="Date" value={a.acquisitionDate} />
        <Detail label="Method" value={ACQUISITION_METHOD_LABELS[a.acquisitionMethod]} />
        {fin ? (
          <>
            <Detail
              label="Recorded acquisition cost"
              value={fin.costStatus === 'unknown_exception' ? `Unknown (${fin.costExceptionReason}) · ${fin.currency}` : formatMoney(fin.acquisitionCost, fin.currency)}
            />
            <Detail label="Cost basis" value={COST_STATUS_LABELS[fin.costStatus]} />
            <Detail label="Supplier" value={fin.supplier} />
            <Detail label="PO / invoice" value={fin.purchaseOrderRef} />
          </>
        ) : (
          <Body muted>Financial details are not shown to you for this department.</Body>
        )}
        <Detail label="Warranty expiry" value={a.warrantyExpiry} />
      </Card>

      <Card>
        <Heading level={2}>Record</Heading>
        <Detail label="Created" value={`${formatDateTime(a.createdAt)} by ${a.createdBy}`} />
        <Detail label="Registered" value={a.registeredAt ? `${formatDateTime(a.registeredAt)} by ${a.registeredBy}` : 'Not yet'} />
        <Detail label="Labels printed" value={a.labelPrintCount ? `${a.labelPrintCount} time(s), last ${formatDateTime(a.lastPrintedAt)}` : 'Never'} />
        <Detail label="Notes" value={a.notes} />
      </Card>

      {a.can.archive || a.can.restore ? (
        <Card>
          <Heading level={2}>{a.can.archive ? 'Archive (remove from current list)' : 'Restore'}</Heading>
          <Body muted>
            {a.can.archive
              ? 'Archiving removes the asset from the current list. Nothing is deleted: the record, its ID and its history are kept.'
              : 'Restoring returns the asset to the current list.'}
          </Body>
          <Field label="Reason" value={reason} onChangeText={setReason} placeholder={a.can.archive ? 'e.g. Entered twice by mistake' : 'e.g. Archived in error'} />
          <Row>
            {a.can.archive ? (
              <Button title="Archive asset" variant="danger" onPress={() => archiveOrRestore('archive')} loading={busy} />
            ) : (
              <Button title="Restore asset" onPress={() => archiveOrRestore('restore')} loading={busy} />
            )}
          </Row>
        </Card>
      ) : null}

      {maintenance.data?.items.length ? (
        <Card>
          <Heading level={2}>Maintenance</Heading>
          {maintenance.data.items.map((mr) => (
            <View key={mr.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Row>
                <Text accessibilityRole="link" onPress={() => router.push({ pathname: '/maintenance/[id]', params: { id: mr.id } })} style={{ color: t.primary, fontWeight: '700', textDecorationLine: 'underline' }}>
                  {mr.reference}
                </Text>
                <Badge label={MAINTENANCE_STATUS_LABELS[mr.status]} tone={maintenanceTone(mr.status)} />
                <Body muted>Priority {PRIORITY_LABELS[mr.priority].toLowerCase()}</Body>
              </Row>
              <Body>{mr.problem}</Body>
              <Body muted>
                Reported {formatDateTime(mr.reportedAt)} by {mr.reportedBy}
              </Body>
            </View>
          ))}
        </Card>
      ) : null}

      {conditions.data?.items.length ? (
        <Card>
          <Heading level={2}>Condition history</Heading>
          {conditions.data.items.map((c) => (
            <View key={c.id} style={{ gap: 4, paddingVertical: 4 }}>
              <Body style={{ fontWeight: '700' }}>
                {CONDITION_SOURCE_LABELS[c.source]}: {CONDITION_LABELS[c.previousCondition]} → {CONDITION_LABELS[c.newCondition]}
              </Body>
              {c.damageDescription ? <Body>{c.damageDescription}</Body> : null}
              {c.notes ? <Body muted>Note: {c.notes}</Body> : null}
              <Body muted>
                {formatDateTime(c.eventTime)} · {c.recordedBy}
                {c.maintenance ? ` · ${c.maintenance.reference}` : ''}
              </Body>
              <AttachmentList items={c.attachments} />
            </View>
          ))}
        </Card>
      ) : null}

      {a.registrationStatus === 'registered' ? (
        <Card>
          <Heading level={2}>Verification history</Heading>
          {verifications.data?.items.length === 0 ? <Body muted>Not verified yet.</Body> : null}
          {verifications.data?.items.slice(0, 20).map((ve) => (
            <View key={ve.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Row>
                <Body style={{ fontWeight: '700' }}>
                  Seen at {ve.observedLocation.building}, {ve.observedLocation.room}
                </Body>
                {ve.outcome === 'location_discrepancy' ? <Badge label="Different location" tone="warn" /> : null}
              </Row>
              <Body muted>
                {formatDateTime(ve.eventTime)} · {ve.verifiedBy} · {ve.method === 'scan' ? 'QR scanned' : 'code typed'}
                {Math.abs(new Date(ve.receivedAt).getTime() - new Date(ve.eventTime).getTime()) > 5 * 60_000
                  ? ` · received ${formatDateTime(ve.receivedAt)}`
                  : ''}
              </Body>
              {ve.notes ? <Body muted>Note: {ve.notes}</Body> : null}
            </View>
          ))}
        </Card>
      ) : null}

      {movements.data?.items.length ? (
        <Card>
          <Heading level={2}>Movement history</Heading>
          {movements.data.items.map((m) => (
            <View key={m.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Body style={{ fontWeight: '700' }}>
                {m.from.building}, {m.from.room} → {m.to.building}, {m.to.room}
              </Body>
              {m.from.department !== m.to.department ? (
                <Body>
                  Transferred from {m.from.department} to {m.to.department}
                </Body>
              ) : null}
              <Body muted>
                {formatDateTime(m.eventTime)} · {m.movedBy}
                {m.source === 'verification' ? ' · found there during verification' : ''}
                {m.reason ? ` · ${m.reason}` : ''}
              </Body>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <Heading level={2}>History</Heading>
        {history.error ? <Notice kind="error">{history.error}</Notice> : null}
        {!history.data && !history.error ? <Loading /> : null}
        {history.data?.events.map((e) => (
          <View key={e.id} style={{ gap: 2, paddingVertical: 6 }}>
            <Row>
              <Body style={{ fontWeight: '700' }}>{describeAction(e.action)}</Body>
              {e.outcome !== 'success' ? <Badge label={e.outcome} tone="bad" /> : null}
            </Row>
            <Body muted>
              {formatDateTime(e.occurredAt)} · {e.actor ?? 'System'}
            </Body>
            {describeChanges(e, names).map((line) => (
              <Body key={line}>{line}</Body>
            ))}
            {describeContext(e) ? <Body muted>{describeContext(e)}</Body> : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
