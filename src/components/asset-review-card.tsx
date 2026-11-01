// Post-registration review on the asset page: status, what was flagged, what was corrected, and the actions
// the signed-in person may take (review, or submit corrections for their department).
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Checkbox } from '@/components/auth-card';
import { Badge, Body, Button, Card, Field, Heading, Notice, Row, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import type { Asset, ReviewEntry } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { FIELD_LABELS, REVIEW_STATUS_LABELS } from '@shared/status-labels';

const tone = (s: Asset['review']['status']) =>
  s === 'approved' ? 'good' : s === 'returned_for_correction' ? 'bad' : s === 'corrected_awaiting_rereview' ? 'warn' : 'neutral';
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));
const ACTION_WORDS: Record<ReviewEntry['action'], string> = {
  approved: 'Approved',
  returned: 'Returned for correction',
  corrections_submitted: 'Corrections submitted',
};
const FLAGGABLE = ['name', 'description', 'categoryId', 'manufacturer', 'model', 'manufacturerBarcode', 'locationId', 'acquisitionDate', 'acquisitionCost', 'currency', 'supplier', 'condition'];

export function AssetReviewCard({ asset: a, onChanged }: { asset: Asset; onChanged: () => void }) {
  const t = useTheme();
  const history = useQuery(`asset-reviews:${a.id}:${a.version}`, () => api<{ items: ReviewEntry[] }>(`/assets/${a.id}/reviews`));
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<string[]>([]);
  const [returning, setReturning] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (a.registrationStatus !== 'registered') return null;

  const run = async (path: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(path, { body: { ...body, version: a.version } });
      setNote('');
      setFields([]);
      setReturning(false);
      setMsg({ kind: 'success', text: done });
      onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const last = a.review.last;

  return (
    <Card>
      <Heading level={2}>Review</Heading>
      <Row>
        <Badge label={REVIEW_STATUS_LABELS[a.review.status]} tone={tone(a.review.status)} />
        <Body muted>Review checks the record after registration; it does not affect registration.</Body>
      </Row>
      {a.review.status === 'returned_for_correction' && last?.action === 'returned' ? (
        <Notice kind="warning">
          Returned by {last.by} on {formatDateTime(last.at)}: {last.note}
          {last.fields.length ? ` Check: ${last.fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}.` : ''}
        </Notice>
      ) : null}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}

      {a.can.review ? (
        returning ? (
          <View style={{ gap: 8 }}>
            <Field label="What needs correcting?" value={note} onChangeText={setNote} placeholder="e.g. Serial number does not match the plate" multiline />
            <Body muted>Fields to check (optional):</Body>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
              {FLAGGABLE.map((f) => (
                <Checkbox key={f} label={FIELD_LABELS[f]} checked={fields.includes(f)} onChange={(on) => setFields(on ? [...fields, f] : fields.filter((x) => x !== f))} />
              ))}
            </View>
            <Row>
              <Button title="Return to department" onPress={() => run(`/assets/${a.id}/review`, { action: 'return', note: note.trim(), fields }, `Returned to ${a.department.name} for correction.`)} loading={busy} />
              <Button title="Cancel" variant="secondary" onPress={() => setReturning(false)} />
            </Row>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Field label="Review note (optional)" value={note} onChangeText={setNote} />
            <Row>
              <Button title="Approve record" onPress={() => run(`/assets/${a.id}/review`, { action: 'approve', note: note.trim() || undefined }, 'Record approved.')} loading={busy} />
              <Button title="Return for correction" variant="secondary" onPress={() => setReturning(true)} />
            </Row>
          </View>
        )
      ) : null}

      {a.can.submitCorrections ? (
        <View style={{ gap: 8 }}>
          <Body>Correct the record with “Edit details” (each change is recorded with its old and new value), then send it back for review.</Body>
          <Row>
            <Button title="Edit details" variant="secondary" onPress={() => router.push({ pathname: '/inventory/[id]/edit', params: { id: a.id } })} />
          </Row>
          <Field label="Note to the reviewer" value={note} onChangeText={setNote} placeholder="What you corrected, or why no change is needed" multiline />
          <Button title="Corrections done — send for re-review" onPress={() => run(`/assets/${a.id}/corrections-done`, { note: note.trim() || undefined }, 'Sent back for re-review.')} loading={busy} />
        </View>
      ) : null}

      {history.data?.items.length ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: '700', marginTop: 4 }}>Review history</Text>
          {history.data.items.map((h) => (
            <View key={h.id} style={{ borderTopWidth: 1, borderColor: t.border, paddingTop: 6, gap: 2 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>
                {ACTION_WORDS[h.action]} · {h.by} · {formatDateTime(h.at)}
              </Text>
              {h.note ? <Text style={{ color: t.textSecondary }}>{h.note}</Text> : null}
              {h.fields.length ? <Text style={{ color: t.textSecondary }}>Flagged: {h.fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}</Text> : null}
              {h.changes
                ? Object.entries(h.changes).map(([k, c]) => (
                    <Text key={k} style={{ color: t.textSecondary }}>
                      {FIELD_LABELS[k] ?? k}: {show(c.before)} → {show(c.after)}
                    </Text>
                  ))
                : null}
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
