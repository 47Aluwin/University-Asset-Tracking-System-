import { router, useLocalSearchParams } from 'expo-router';

import { AssetForm } from '@/components/asset-form';
import { Body, Heading, Loading, Notice, Screen } from '@/components/ui';
import { api, newOperationId } from '@/lib/api';
import { action, perform } from '@/lib/offline';
import { useSession } from '@/lib/session';
import type { Asset } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

export default function EditAsset() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const asset = useQuery(`asset:${id}`, () => api<Asset>(`/assets/${id}`));
  const { user } = useSession();

  if (asset.error && !asset.data) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!asset.data) return <Screen><Loading /></Screen>;
  const a = asset.data;
  if (!a.can.edit) {
    return (
      <Screen>
        <Notice kind="error">You cannot edit this asset{a.archived ? ' because it is archived' : ''}.</Notice>
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>Edit {a.institutionalId}</Heading>
      <Body muted>Every change is recorded in the asset history with the old and new values. The asset ID and QR code never change.</Body>
      <AssetForm
        key={a.version}
        initial={a}
        submitLabel="Save changes"
        onSubmit={async (body) => {
          const changed = Object.keys(body).filter((k) => !['version', 'baseValues', 'confirmNotDuplicate'].includes(k));
          if (!changed.length) {
            router.back();
            return;
          }
          // Offline, the edit is saved and sent later; if someone changed the same fields meanwhile, it is kept
          // for review instead of overwriting their change.
          const r = await perform(user!.id, [
            action({ id: newOperationId(), kind: 'edit', label: `Edit ${a.institutionalId} (${changed.join(', ')})`, method: 'PATCH', path: `/assets/${a.id}`, body, assetRef: a.id }),
          ]);
          if (r.status === 'done') router.back();
          else router.replace({ pathname: '/inventory/[id]', params: { id: a.id, savedOffline: '1' } });
        }}
      />
    </Screen>
  );
}
