import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { QrCode } from '@/components/qr-code';
import { QrScanner } from '@/components/qr-scanner';
import { Badge, Button, Card, Field, Heading, Notice, Row, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { action, perform } from '@/lib/offline';
import { useOffline } from '@/lib/offline/provider';
import { printLabelHtml } from '@/lib/print-labels';
import { useSession } from '@/lib/session';
import type { Department } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { parseScannedCode, qrPayloadFor } from '@shared/asset-codes';
import { labelSheetHtml, type LabelTemplate } from '@shared/labels';

/**
 * Label for an asset registered offline. It uses the ID reserved on this phone, so the printed label is final.
 * The print and the label confirmation are saved here and sent after the registration itself.
 */
export default function OfflineLabel() {
  const { op: opId } = useLocalSearchParams<{ op: string }>();
  const { user } = useSession();
  const { ops } = useOffline();
  const template = useQuery('label-template', () => api<{ template: LabelTemplate }>('/label-template'));
  const departments = useQuery('departments', () => api<{ items: Department[] }>('/departments'));
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'info' | 'success'; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = ops.find((o) => o.id === opId);
  if (!create) return <Screen><Notice kind="error">This registration is no longer saved on this phone. Check the asset list.</Notice></Screen>;
  // Once the registration has reached the server, continue on the normal label screen.
  if (create.status === 'synced') return <Redirect href={{ pathname: '/inventory/[id]/label', params: { id: (create.result as { id: string }).id } }} />;

  const body = create.body as { name: string; departmentId: string; institutionalId?: string };
  const id = body.institutionalId;
  const tpl = template.data?.template;
  const deptCode = departments.data?.items.find((d) => d.id === body.departmentId)?.code ?? '';
  const printOp = ops.find((o) => o.kind === 'label-print' && o.dependsOn?.includes(create.id));
  const confirmOp = ops.find((o) => o.kind === 'confirm-label' && printOp && o.dependsOn?.includes(printOp.id));

  if (!id) {
    return (
      <Screen>
        <Heading>Saved on this phone</Heading>
        <Notice kind="info">
          “{body.name}” was saved without a connection, and no asset IDs were left reserved on this phone. It will receive its ID when it is sent;
          print and attach the label after that. It is not registered yet.
        </Notice>
        <Button title="Waiting to sync" onPress={() => router.push('/sync')} />
      </Screen>
    );
  }

  const print = async () => {
    if (!tpl) return setMsg({ kind: 'error', text: 'The label layout has not been saved on this phone yet. Connect once to download it.' });
    setBusy(true);
    setMsg(null);
    try {
      if (!printOp) {
        await perform(user!.id, [
          action({ kind: 'label-print', label: `Label printed for ${id}`, method: 'POST', path: `/assets/{{op:${create.id}.id}}/label-prints`, body: { layout: tpl.layout }, dependsOn: [create.id] }),
        ]);
      }
      const html = labelSheetHtml([{ institutionalId: id, qrPayload: qrPayloadFor(id), name: body.name, departmentCode: deptCode }], tpl, 1);
      await printLabelHtml(html, tpl);
      setMsg({ kind: 'info', text: 'Print dialog opened. Stick the label on the asset, then confirm it below.' });
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (scanned?: string) => {
    setScanning(false);
    const value = scanned ?? code.trim();
    // Checked here so mistakes are caught on the spot; the server checks again when it is sent.
    if (parseScannedCode(value) !== id) return setMsg({ kind: 'error', text: `That is not the label for ${id}. Check the right label is on this asset.` });
    if (!printOp) return;
    setBusy(true);
    try {
      await perform(user!.id, [
        action({ kind: 'confirm-label', label: `Label attached to ${id}`, method: 'POST', path: `/assets/{{op:${create.id}.id}}/confirm-label`, body: { code: value, method: scanned ? 'scan' : 'manual' }, dependsOn: [printOp.id] }),
      ]);
      setMsg({ kind: 'success', text: 'Label confirmed. The registration will be completed when this phone is back online.' });
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>QR label (saved offline)</Heading>
      <Notice kind="info">
        No connection. “{body.name}” is saved on this phone with the reserved ID {id}. Print and attach the label now; everything is sent when you
        are back online. It is not registered until the server accepts it.
      </Notice>
      <Row>
        <Badge label={confirmOp ? 'Label confirmed — waiting to sync' : printOp ? 'Printed — confirm the label' : 'Not printed yet'} tone="warn" />
      </Row>
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 6, alignSelf: 'flex-start' }}>
          <QrCode payload={qrPayloadFor(id)} size={120} label={`QR label for ${id}`} />
          <View style={{ maxWidth: 170, gap: 4 }}>
            <Text style={{ color: '#000', fontFamily: 'monospace', fontWeight: '700' }}>{id}</Text>
            {tpl?.showName ? <Text style={{ color: '#000', fontSize: 12 }}>{body.name}</Text> : null}
            {tpl?.showDepartment ? <Text style={{ color: '#000', fontSize: 12, fontWeight: '700' }}>{deptCode}</Text> : null}
          </View>
        </View>
        {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
        {!confirmOp ? <Button title={printOp ? 'Print again' : 'Print label'} onPress={print} loading={busy} /> : null}
      </Card>
      {printOp && !confirmOp ? (
        <Card>
          <Heading level={2}>Confirm the label is attached</Heading>
          {scanning ? (
            <>
              <QrScanner active={!busy} hint="Point the camera at the label you just attached." onAssetCode={(_id, raw) => confirm(raw)} />
              <Button title="Type the ID instead" variant="secondary" onPress={() => setScanning(false)} />
            </>
          ) : (
            <Button title="Scan the attached label" onPress={() => setScanning(true)} />
          )}
          <Field label="ID on the attached label" value={code} onChangeText={setCode} autoCapitalize="characters" placeholder={id} />
          <Button title="Confirm label attached" variant="secondary" onPress={() => confirm()} loading={busy} />
        </Card>
      ) : null}
      <Row>
        <Button title="Register another asset" variant="secondary" onPress={() => router.replace('/inventory/new')} />
        <Button title="Waiting to sync" variant="secondary" onPress={() => router.push('/sync')} />
      </Row>
    </Screen>
  );
}
