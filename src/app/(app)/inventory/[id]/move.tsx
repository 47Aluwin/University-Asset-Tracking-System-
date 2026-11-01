import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';

import { Body, Button, Card, Choice, Field, Heading, Loading, Notice, Screen, SearchableChoice } from '@/components/ui';
import { api, ApiError, errorMessage, newOperationId } from '@/lib/api';
import { action, perform } from '@/lib/offline';
import { useSession } from '@/lib/session';
import type { Asset, Location } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useQuery } from '@/lib/use-query';

/** Relocate an asset. The previous location is kept in its movement history. */
export default function MoveAsset() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can, user } = useSession();
  const asset = useQuery(`asset:${id}`, () => api<Asset>(`/assets/${id}`));
  const departments = useDepartments();
  const [deptId, setDeptId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationId = useRef(newOperationId());
  const a = asset.data;
  const dept = deptId ?? a?.department.id ?? null;
  const locations = useQuery(`locations:${dept ?? ''}`, () =>
    dept ? api<{ items: Location[] }>('/locations', { query: { departmentId: dept } }) : Promise.resolve({ items: [] as Location[] }),
  );

  if (asset.error && !a) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!a) return <Screen><Loading /></Screen>;
  if (!a.can.move) return <Screen><Notice kind="error">You cannot relocate this asset.</Notice></Screen>;

  const crossDepartment = dept !== a.department.id;
  const targets = departments.active.filter((d) => can('movement.record', d.id));
  const choices = (locations.data?.items ?? []).filter((l) => l.id !== a.location.id);

  const submit = async () => {
    setError(null);
    const errs: Record<string, string> = {};
    if (!toId) errs.toLocationId = 'Choose where the asset is going.';
    if (crossDepartment && reason.trim().length < 3) errs.reason = 'Give a reason for moving it to another department.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const to = locations.data?.items.find((l) => l.id === toId);
      const r = await perform(user!.id, [
        action({
          id: operationId.current,
          kind: 'move',
          label: `Move ${a.institutionalId} to ${to ? `${to.building}, ${to.room}` : 'a new location'}`,
          method: 'POST',
          path: `/assets/${a.id}/movements`,
          assetRef: a.id,
          body: { toLocationId: toId, reason: reason.trim() || undefined, eventTime: new Date().toISOString() },
        }),
      ]);
      router.replace({ pathname: '/inventory/[id]', params: { id: a.id, ...(r.status === 'done' ? { moved: '1' } : { savedOffline: '1' }) } });
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>Relocate {a.institutionalId}</Heading>
      <Body muted>
        {a.name} is recorded at {a.location.building}, {a.location.room} ({a.department.name}). The move is added to its history; the old location is kept.
      </Body>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        {targets.length > 1 ? (
          <SearchableChoice
            label="School / department"
            value={dept}
            options={targets.map((d) => ({ value: d.id, label: d.name }))}
            onChange={(v) => {
              setDeptId(v);
              setToId(null);
            }}
          />
        ) : null}
        {crossDepartment ? (
          <Notice kind="warning">Moving to another department transfers ownership. A reason is required and the move is flagged for review.</Notice>
        ) : null}
        {locations.data ? (
          choices.length ? (
            <Choice
              label="New location"
              value={toId}
              options={choices.map((l) => ({ value: l.id, label: `${l.building} · ${l.room}` }))}
              onChange={(v) => {
                setToId(v);
                setErrors((e) => ({ ...e, toLocationId: '' }));
              }}
              error={errors.toLocationId}
            />
          ) : (
            <Body muted>No other locations in this department. Add one from the asset registration form first.</Body>
          )
        ) : (
          <Loading label="Loading locations…" />
        )}
        <Field
          label={crossDepartment ? 'Reason' : 'Reason (optional)'}
          value={reason}
          onChangeText={(v) => {
            setReason(v);
            setErrors((e) => ({ ...e, reason: '' }));
          }}
          error={errors.reason}
          placeholder="e.g. Lab reorganised"
        />
        <Body muted>Relocating does not count as verifying the asset; scan it at its new location to verify it.</Body>
        <Button title="Relocate asset" onPress={submit} loading={busy} />
      </Card>
    </Screen>
  );
}
