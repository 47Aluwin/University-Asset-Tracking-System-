import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { QrCode } from '@/components/qr-code';
import { QrScanner } from '@/components/qr-scanner';
import { Badge, Body, Button, Card, Field, Heading, Loading, Notice, Row, Screen } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { printLabelHtml } from '@/lib/print-labels';
import type { Asset } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { labelSheetHtml, type LabelTemplate } from '@shared/labels';

export default function AssetLabel() {
  const t = useTheme();
  const { id, created } = useLocalSearchParams<{ id: string; created?: string }>();
  const asset = useQuery(`asset:${id}`, () => api<Asset>(`/assets/${id}`));
  const template = useQuery('label-template', () => api<{ template: LabelTemplate }>('/label-template'));
  const [copies, setCopies] = useState('1');
  const [start, setStart] = useState('1');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [printMsg, setPrintMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<'print' | 'confirm' | null>(null);
  const [scanning, setScanning] = useState(false);

  if (asset.error && !asset.data) return <Screen><Notice kind="error">{asset.error}</Notice></Screen>;
  if (!asset.data) return <Screen><Loading /></Screen>;
  const a = asset.data;
  const tpl = template.data?.template;
  const isReprint = a.labelPrintCount > 0;
  const perSheet = tpl ? tpl.columns * tpl.rows : 1;

  const print = async () => {
    setPrintMsg(null);
    if (!tpl) return;
    const n = Number(copies);
    if (!Number.isInteger(n) || n < 1 || n > 50) return setPrintMsg({ kind: 'error', text: 'Copies must be a whole number from 1 to 50.' });
    const pos = Number(start);
    if (tpl.layout === 'sheet' && (!Number.isInteger(pos) || pos < 1 || pos > perSheet)) {
      return setPrintMsg({ kind: 'error', text: `Start position must be between 1 and ${perSheet}.` });
    }
    if (isReprint && reason.trim().length < 3) return setPrintMsg({ kind: 'error', text: 'Say why the label is being reprinted (e.g. damaged, lost, printer jammed).' });
    setBusy('print');
    try {
      // Record the print first (the server never creates or changes an asset here), then print on this device.
      await api(`/assets/${a.id}/label-prints`, { body: { copies: n, layout: tpl.layout, reason: isReprint ? reason.trim() : undefined } });
      const html = labelSheetHtml(
        Array.from({ length: n }, () => ({ institutionalId: a.institutionalId, qrPayload: a.qrPayload, name: a.name, departmentCode: a.department.code })),
        tpl,
        tpl.layout === 'sheet' ? pos : 1,
      );
      try {
        await printLabelHtml(html, tpl);
        setPrintMsg({ kind: 'info', text: 'Print dialog opened. After printing, stick the label on the asset and confirm it below.' });
      } catch (e) {
        setPrintMsg({ kind: 'error', text: `Printing did not complete: ${errorMessage(e)} You can try again; give the reason "print failed".` });
      }
      setReason('');
      asset.reload();
    } catch (e) {
      setPrintMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  /** Scanned codes are sent as-is (the server checks they belong to this asset); typed ones are trimmed. */
  const confirm = async (scanned?: string) => {
    setConfirmMsg(null);
    const value = scanned ?? code.trim();
    if (!value) return setConfirmMsg('Scan the label you attached, or type the asset ID printed under its QR code.');
    setScanning(false);
    setBusy('confirm');
    try {
      await api(`/assets/${a.id}/confirm-label`, { body: { code: value, method: scanned ? 'scan' : 'manual' } });
      router.replace({ pathname: '/inventory/[id]', params: { id: a.id } });
    } catch (e) {
      setConfirmMsg(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Heading>QR label</Heading>
      {created ? <Notice kind="success">Saved. Asset ID {a.institutionalId} has been assigned. Next: print and attach its label.</Notice> : null}
      <Row>
        <Badge label={a.registrationStatus === 'registered' ? 'Registered' : 'Awaiting label'} tone={a.registrationStatus === 'registered' ? 'good' : 'warn'} />
        <Body muted>{a.labelPrintCount ? `Printed ${a.labelPrintCount} time(s)` : 'Not printed yet'}</Body>
      </Row>

      <Card>
        <Heading level={2}>Preview</Heading>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 6, alignSelf: 'flex-start' }}>
          <QrCode payload={a.qrPayload} size={120} label={`QR label for ${a.institutionalId}`} />
          <View style={{ maxWidth: 170, gap: 4 }}>
            <Text style={{ color: '#000', fontFamily: 'monospace', fontWeight: '700' }}>{a.institutionalId}</Text>
            {tpl?.showName ? <Text style={{ color: '#000', fontSize: 12 }} numberOfLines={3}>{a.name}</Text> : null}
            {tpl?.showDepartment ? <Text style={{ color: '#000', fontSize: 12, fontWeight: '700' }}>{a.department.code}</Text> : null}
            {tpl?.footerText ? <Text style={{ color: '#000', fontSize: 10 }}>{tpl.footerText}</Text> : null}
          </View>
        </View>
        <Body muted>Reprints always use this same ID and QR code. Printing never creates a new asset.</Body>
      </Card>

      {a.can.printLabel ? (
        <Card>
          <Heading level={2}>{isReprint ? 'Reprint label' : 'Print label'}</Heading>
          {template.error ? <Notice kind="error">{template.error}</Notice> : null}
          {tpl ? (
            <Body muted>
              Layout: {tpl.layout === 'sheet' ? `label sheet, ${tpl.columns} × ${tpl.rows} labels of ${tpl.labelWidthMm} × ${tpl.labelHeightMm} mm on ${tpl.pageWidthMm} × ${tpl.pageHeightMm} mm pages` : `label printer, ${tpl.labelWidthMm} × ${tpl.labelHeightMm} mm`}. In the print dialog choose 100% / actual size and turn off headers and footers.
            </Body>
          ) : null}
          {printMsg ? <Notice kind={printMsg.kind}>{printMsg.text}</Notice> : null}
          <Row>
            <View style={{ flexBasis: 120, flexGrow: 1 }}>
              <Field label="Copies" value={copies} onChangeText={setCopies} keyboardType="number-pad" maxLength={2} />
            </View>
            {tpl?.layout === 'sheet' ? (
              <View style={{ flexBasis: 160, flexGrow: 1 }}>
                <Field label={`Start at position (1–${perSheet})`} value={start} onChangeText={setStart} keyboardType="number-pad" hint="To reuse a part-used sheet. Positions run left to right, top to bottom." />
              </View>
            ) : null}
          </Row>
          {isReprint ? <Field label="Reason for reprint" value={reason} onChangeText={setReason} placeholder="e.g. Label damaged" /> : null}
          <Button title={isReprint ? 'Reprint label' : 'Print label'} onPress={print} loading={busy === 'print'} disabled={!tpl} />
        </Card>
      ) : null}

      {a.can.confirmLabel ? (
        <Card>
          <Heading level={2}>Confirm the label is attached</Heading>
          <Body>
            After sticking the label on the asset, scan it (or type the ID printed under the QR code). This checks the right label went on the right
            asset and that it can be read.
          </Body>
          {a.labelPrintCount === 0 ? <Notice kind="info">Print the label first.</Notice> : null}
          {confirmMsg ? <Notice kind="error">{confirmMsg}</Notice> : null}
          {a.labelPrintCount > 0 ? (
            scanning ? (
              <>
                <QrScanner active={busy !== 'confirm'} hint="Point the camera at the label you just attached." onAssetCode={(_id, raw) => confirm(raw)} />
                <Button title="Type the ID instead" variant="secondary" onPress={() => setScanning(false)} />
              </>
            ) : (
              <Button title="Scan the attached label" onPress={() => setScanning(true)} />
            )
          ) : null}
          <Field
            label="ID on the attached label"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            placeholder="UAT-2026-000123"
            onSubmitEditing={() => confirm()}
          />
          <Button title="Confirm label attached" variant={scanning ? 'secondary' : 'primary'} onPress={() => confirm()} loading={busy === 'confirm'} disabled={a.labelPrintCount === 0} />
        </Card>
      ) : null}

      <Row>
        <Button title="Back to asset" variant="secondary" onPress={() => router.replace({ pathname: '/inventory/[id]', params: { id: a.id } })} />
      </Row>
      <Text style={{ color: t.textSecondary, fontSize: 12 }}>QR content: {a.qrPayload}</Text>
    </Screen>
  );
}
