import { useState } from 'react';
import { View } from 'react-native';

import { Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { printLabelHtml } from '@/lib/print-labels';
import { useQuery } from '@/lib/use-query';
import { DEFAULT_LABEL_TEMPLATE, SINGLE_LABEL_PRESET, labelSheetHtml, templateProblems, type LabelTemplate } from '@shared/labels';

const NUMBER_FIELDS: { key: keyof LabelTemplate; label: string; int?: boolean }[] = [
  { key: 'pageWidthMm', label: 'Page width (mm)' },
  { key: 'pageHeightMm', label: 'Page height (mm)' },
  { key: 'columns', label: 'Columns', int: true },
  { key: 'rows', label: 'Rows', int: true },
  { key: 'labelWidthMm', label: 'Label width (mm)' },
  { key: 'labelHeightMm', label: 'Label height (mm)' },
  { key: 'marginTopMm', label: 'Top margin (mm)' },
  { key: 'marginLeftMm', label: 'Left margin (mm)' },
  { key: 'gapXMm', label: 'Gap between columns (mm)' },
  { key: 'gapYMm', label: 'Gap between rows (mm)' },
  { key: 'qrSizeMm', label: 'QR code size (mm)' },
  { key: 'paddingMm', label: 'Label padding (mm)' },
];

type Draft = Record<string, string | boolean>;
const toDraft = (t: LabelTemplate): Draft => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));

function fromDraft(d: Draft): LabelTemplate | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    const field = NUMBER_FIELDS.find((f) => f.key === k);
    if (field) {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || (field.int && !Number.isInteger(n))) return null;
      out[k] = n;
    } else out[k] = v;
  }
  return out as LabelTemplate;
}

export default function LabelLayout() {
  const current = useQuery('label-template', () => api<{ template: LabelTemplate }>('/label-template'));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (current.error && !current.data) return <Screen><Notice kind="error">{current.error}</Notice></Screen>;
  if (!current.data) return <Screen><Loading /></Screen>;
  const d = draft ?? toDraft(current.data.template);
  const parsed = fromDraft(d);
  const problems = parsed ? templateProblems(parsed) : ['Every measurement must be a number (columns and rows whole numbers).'];
  const set = (k: string) => (v: string | boolean) => setDraft({ ...d, [k]: v });

  const save = async () => {
    setMsg(null);
    if (!parsed || problems.length) return;
    setBusy(true);
    try {
      await api('/settings/label_template', { method: 'PUT', body: { value: parsed } });
      setDraft(null);
      current.reload();
      setMsg({ kind: 'success', text: 'Label layout saved. It applies to all new prints.' });
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  // Calibration print: positions are marked "TEST" and the QR content is deliberately not an asset code.
  const testPrint = async () => {
    if (!parsed || problems.length) return;
    const n = parsed.columns * parsed.rows;
    const html = labelSheetHtml(
      Array.from({ length: n }, (_, i) => ({ institutionalId: `TEST ${i + 1}`, qrPayload: 'TEST LABEL - NOT AN ASSET', name: 'Alignment test — not an asset label', departmentCode: 'TEST' })),
      parsed,
    );
    try {
      await printLabelHtml(html, parsed);
      setMsg({ kind: 'info', text: 'Test page sent to the print dialog. Hold the printout against a label sheet to check alignment.' });
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  return (
    <Screen>
      <Heading>Label layout</Heading>
      <Body muted>
        Set these to match your label stock. Measurements are on the label sheet packaging or the label printer’s settings. Print a test page and check alignment before printing real labels.
      </Body>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <Card>
        <Heading level={2}>Start from a preset</Heading>
        <Row>
          <Button title="A4 sheet, 21 labels (63.5 × 38.1 mm)" variant="secondary" onPress={() => setDraft(toDraft(DEFAULT_LABEL_TEMPLATE))} />
          <Button title="Label printer, 50 × 30 mm" variant="secondary" onPress={() => setDraft(toDraft(SINGLE_LABEL_PRESET))} />
        </Row>
      </Card>
      <Card>
        <Choice
          label="Layout"
          value={d.layout as 'sheet' | 'single'}
          options={[
            { value: 'sheet', label: 'Label sheets (several per page)' },
            { value: 'single', label: 'Label printer (one per page)' },
          ]}
          onChange={set('layout')}
        />
        <Row>
          {NUMBER_FIELDS.map((f) => (
            <View key={f.key} style={{ flexBasis: 170, flexGrow: 1 }}>
              <Field label={f.label} value={String(d[f.key])} onChangeText={set(f.key)} keyboardType="decimal-pad" />
            </View>
          ))}
        </Row>
        <Choice
          label="Show asset name on label"
          value={d.showName ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          onChange={(v) => set('showName')(v === 'yes')}
        />
        <Choice
          label="Show department code on label"
          value={d.showDepartment ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          onChange={(v) => set('showDepartment')(v === 'yes')}
        />
        <Field label="Footer text (optional)" value={String(d.footerText)} onChangeText={set('footerText')} maxLength={60} placeholder="e.g. Property of the University" />
        {problems.length ? (
          <Notice kind="error">{problems.join(' ')}</Notice>
        ) : (
          <Notice kind="success">Labels fit the page and the QR code is large enough to scan.</Notice>
        )}
        <Row>
          <Button title="Save layout" onPress={save} loading={busy} disabled={problems.length > 0} />
          <Button title="Print test page" variant="secondary" onPress={testPrint} disabled={problems.length > 0} />
        </Row>
      </Card>
    </Screen>
  );
}
