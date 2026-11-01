import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';

import { PhotoPicker } from '@/components/attachments';
import { Checkbox } from '@/components/auth-card';
import { Body, Button, Card, Choice, Field, Heading, Loading, Notice, Screen } from '@/components/ui';
import { api, ApiError, errorMessage, newOperationId, type UploadFile } from '@/lib/api';
import { action, perform } from '@/lib/offline';
import { useSession } from '@/lib/session';
import { PRIORITY_LABELS } from '@/lib/asset-display';
import type { Asset, Priority } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { CONDITION_LABELS, CONDITIONS, type Condition } from '@shared/asset-codes';

/** Update an asset's condition, optionally reporting damage with photos and opening a maintenance request. */
export default function UpdateCondition() {
  const { id, damage } = useLocalSearchParams<{ id: string; damage?: string }>();
  const { user } = useSession();
  const asset = useQuery(`asset:${id}`, () => api<Asset>(`/assets/${id}`));
  const [condition, setCondition] = useState<Condition | null>(null);
  const [isDamage, setIsDamage] = useState(damage === '1');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<UploadFile[]>([]);
  const [request, setRequest] = useState(false);
  const [problem, setProblem] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationId = useRef(newOperationId());

  const a = asset.data;
  if (asset.error && !a) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!a) return <Screen><Loading /></Screen>;
  if (!a.can.recordCondition) return <Screen><Notice kind="error">You cannot record the condition of this asset.</Notice></Screen>;
  const chosen = condition ?? (isDamage ? 'damaged' : null);

  const submit = async () => {
    setError(null);
    const errs: Record<string, string> = {};
    if (!chosen) errs.condition = 'Choose the condition.';
    if (isDamage && description.trim().length < 5) errs.damageDescription = 'Describe the damage or fault (at least 5 characters).';
    if (!isDamage && chosen === a.condition) errs.condition = `It is already recorded as ${CONDITION_LABELS[a.condition].toLowerCase()}.`;
    if (request && problem.trim().length < 5) errs.problem = 'Describe what needs doing (at least 5 characters).';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      // The report first, then each photo attached to it. Without a connection all of them are saved on the
      // phone and sent in that order later; photos wait for the report to be accepted.
      const report = action({
        id: operationId.current,
        kind: 'condition',
        label: `${isDamage ? 'Damage report' : 'Condition update'} for ${a.institutionalId}`,
        method: 'POST',
        path: `/assets/${a.id}/condition`,
        assetRef: a.id,
        body: {
          condition: chosen,
          notes: notes.trim() || undefined,
          damageDescription: isDamage ? description.trim() : undefined,
          requestMaintenance: request ? { problem: problem.trim(), priority } : undefined,
          eventTime: new Date().toISOString(),
        },
      });
      const uploads = photos.map((p) =>
        action({
          kind: 'photo',
          label: `Photo ${p.name} for ${a.institutionalId}`,
          method: 'POST',
          path: `/condition-events/{{op:${report.id}.conditionEventId}}/attachments`,
          file: { uri: p.uri, name: p.name, type: p.type },
          dependsOn: [report.id],
          assetRef: a.id,
        }),
      );
      const r = await perform(user!.id, [report, ...uploads]);
      if (r.status !== 'done') {
        router.replace({ pathname: '/inventory/[id]', params: { id: a.id, savedOffline: '1' } });
        return;
      }
      // The record is saved; a photo that failed does not undo it, and stays in "Waiting to sync" to retry.
      const failed = r.ops.slice(1).filter((o) => o.status !== 'synced');
      if (failed.length) {
        setError(
          `The condition was saved, but ${failed.length} photo(s) were not uploaded yet — ${failed.map((o) => o.lastError?.message ?? 'waiting').join('; ')}. They will be retried from “Waiting to sync”.`,
        );
        operationId.current = newOperationId();
        setBusy(false);
        return;
      }
      const res = r.result as { conditionEventId: string; maintenanceRequestId: string | null };
      if (res.maintenanceRequestId) router.replace({ pathname: '/maintenance/[id]', params: { id: res.maintenanceRequestId, created: '1' } });
      else router.replace({ pathname: '/inventory/[id]', params: { id: a.id } });
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>{isDamage ? 'Report damage' : 'Update condition'}</Heading>
      <Body muted>
        {a.institutionalId} — {a.name}. Currently recorded as {CONDITION_LABELS[a.condition].toLowerCase()}. The change is added to its condition history.
      </Body>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        <Checkbox label="There is damage or a fault" checked={isDamage} onChange={setIsDamage} />
        <Choice
          label="Condition now"
          value={chosen}
          options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))}
          onChange={(v) => {
            setCondition(v);
            setErrors((e) => ({ ...e, condition: '' }));
          }}
          error={errors.condition}
        />
        {isDamage ? (
          <Field
            label="What is damaged or not working?"
            value={description}
            onChangeText={(v) => {
              setDescription(v);
              setErrors((e) => ({ ...e, damageDescription: '' }));
            }}
            error={errors.damageDescription}
            multiline
            style={{ minHeight: 72, textAlignVertical: 'top' }}
            placeholder="e.g. Screen cracked in the top corner after a fall"
          />
        ) : null}
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
        <PhotoPicker photos={photos} onChange={setPhotos} />
      </Card>
      {a.can.requestMaintenance ? (
        <Card>
          <Checkbox label="Also request maintenance or repair" checked={request} onChange={setRequest} />
          {request ? (
            <>
              <Field
                label="What needs doing?"
                value={problem}
                onChangeText={(v) => {
                  setProblem(v);
                  setErrors((e) => ({ ...e, problem: '' }));
                }}
                error={errors.problem}
                multiline
                style={{ minHeight: 64, textAlignVertical: 'top' }}
                placeholder="e.g. Replace the screen"
              />
              <Choice label="Priority" value={priority} options={(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} onChange={setPriority} />
              <Body muted>Your department manages the request. External contractors can be recorded on it later.</Body>
            </>
          ) : null}
        </Card>
      ) : null}
      <Button title={isDamage ? 'Save damage report' : 'Save condition'} onPress={submit} loading={busy} />
    </Screen>
  );
}
