import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';

import { PhotoPicker } from '@/components/attachments';
import { Body, Button, Card, Choice, Field, Heading, Loading, Notice, Screen } from '@/components/ui';
import { api, ApiError, errorMessage, newOperationId, type UploadFile } from '@/lib/api';
import { action, perform } from '@/lib/offline';
import { useSession } from '@/lib/session';
import { PRIORITY_LABELS } from '@/lib/asset-display';
import type { Asset, MaintenanceRequest, Priority } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { CONDITION_LABELS } from '@shared/asset-codes';

/** Open a maintenance request for an asset (managed by the asset's own department). */
export default function NewMaintenance() {
  const { assetId } = useLocalSearchParams<{ assetId: string }>();
  const { user } = useSession();
  const asset = useQuery(`asset:${assetId}`, () => api<Asset>(`/assets/${assetId}`));
  const [problem, setProblem] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [photos, setPhotos] = useState<UploadFile[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationId = useRef(newOperationId());

  const a = asset.data;
  if (asset.error && !a) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!a) return <Screen><Loading /></Screen>;
  if (!a.can.requestMaintenance) return <Screen><Notice kind="error">You cannot request maintenance for this asset.</Notice></Screen>;

  const submit = async () => {
    setError(null);
    if (problem.trim().length < 5) return setErrors({ problem: 'Describe the problem (at least 5 characters).' });
    setBusy(true);
    try {
      const req = action({
        id: operationId.current,
        kind: 'maintenance',
        label: `Maintenance request for ${a.institutionalId}`,
        method: 'POST',
        path: '/maintenance',
        assetRef: a.id,
        body: { assetId: a.id, problem: problem.trim(), priority, eventTime: new Date().toISOString() },
      });
      const uploads = photos.map((p) =>
        action({
          kind: 'photo',
          label: `Photo ${p.name} for ${a.institutionalId}`,
          method: 'POST',
          path: `/maintenance/{{op:${req.id}.id}}/attachments`,
          file: { uri: p.uri, name: p.name, type: p.type },
          dependsOn: [req.id],
          assetRef: a.id,
        }),
      );
      const r = await perform(user!.id, [req, ...uploads]);
      if (r.status !== 'done') {
        router.replace({ pathname: '/inventory/[id]', params: { id: a.id, savedOffline: '1' } });
        return;
      }
      const failed = r.ops.slice(1).filter((o) => o.status !== 'synced').length;
      const created = r.result as MaintenanceRequest;
      router.replace({ pathname: '/maintenance/[id]', params: { id: created.id, created: '1', ...(failed ? { uploadFailed: String(failed) } : {}) } });
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>Request maintenance</Heading>
      <Body muted>
        {a.institutionalId} — {a.name} ({a.department.name}). Current condition: {CONDITION_LABELS[a.condition].toLowerCase()}. To record new damage, use
        “Report damage” instead so the condition history is updated too.
      </Body>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        <Field
          label="What is the problem?"
          value={problem}
          onChangeText={(v) => {
            setProblem(v);
            setErrors({});
          }}
          error={errors.problem}
          multiline
          style={{ minHeight: 80, textAlignVertical: 'top' }}
          placeholder="e.g. Annual calibration due"
        />
        <Choice label="Priority" value={priority} options={(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} onChange={setPriority} />
        <PhotoPicker photos={photos} onChange={setPhotos} />
        <Button title="Submit request" onPress={submit} loading={busy} />
      </Card>
    </Screen>
  );
}
