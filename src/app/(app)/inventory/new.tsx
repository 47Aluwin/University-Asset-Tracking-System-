import { router } from 'expo-router';
import { Platform } from 'react-native';
import { useRef } from 'react';

import { AssetForm } from '@/components/asset-form';
import { Body, Heading, Screen } from '@/components/ui';
import { newOperationId } from '@/lib/api';
import { action, offlineCapable, perform, returnReservedId, takeReservedId } from '@/lib/offline';
import { useSession } from '@/lib/session';
import type { Asset } from '@/lib/types';

export default function NewAsset() {
  const { user } = useSession();
  // One operation id per registration attempt: if the network drops after the server saved the asset,
  // pressing the button again returns the same asset instead of creating a second one.
  const operationId = useRef(newOperationId());

  return (
    <Screen>
      <Heading>Register asset</Heading>
      <Body muted>
        Scan the item’s barcode, confirm its details and save: the asset ID and its QR code are created for you. Then print the label and
        stick it on the item. Registration is complete once the attached label is scanned to confirm it.
        {offlineCapable ? ' Without a connection, it is saved on this phone with an ID reserved in advance, so the label can still be printed.' : ''}
      </Body>
      <AssetForm
        // Phones open the camera straight away; on the website the user chooses (many computers have no camera).
        startWithScan={Platform.OS !== 'web'}
        submitLabel="Save and generate QR code"
        onSubmit={async (body) => {
          // Phones use an ID reserved while online (if any is left), so the label is final even when offline.
          const reserved = await takeReservedId(user!.id);
          const create = action({
            id: operationId.current,
            kind: 'register',
            label: `Register ${String(body.name)}${reserved ? ` (${reserved})` : ''}`,
            method: 'POST',
            path: '/assets',
            body: { ...body, ...(reserved ? { institutionalId: reserved } : {}) },
          });
          let r;
          try {
            r = await perform(user!.id, [create]);
          } catch (e) {
            if (reserved) await returnReservedId(user!.id, reserved);
            throw e;
          }
          if (r.status === 'done') {
            router.replace({ pathname: '/inventory/[id]/label', params: { id: (r.result as Asset).id, created: '1' } });
          } else {
            router.replace({ pathname: '/offline-label', params: { op: create.id } });
          }
        }}
      />
    </Screen>
  );
}
