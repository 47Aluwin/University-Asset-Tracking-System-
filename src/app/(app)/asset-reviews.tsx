import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { Badge, Body, Button, Choice, Heading, Loading, Notice, Row, Screen, formatDateTime } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Asset, Paged } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { FIELD_LABELS, REVIEW_STATUS_LABELS } from '@shared/status-labels';

type Tab = 'not_reviewed' | 'corrected_awaiting_rereview' | 'returned_for_correction';

/** Review queue for the Asset Management Team; "returned for correction" list for departments. */
export default function AssetReviews() {
  const t = useTheme();
  const { can } = useSession();
  const reviewer = can('assets.review');
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(
    (['not_reviewed', 'corrected_awaiting_rereview', 'returned_for_correction'] as const).find((x) => x === params.tab) ?? (reviewer ? 'not_reviewed' : 'returned_for_correction'),
  );
  const [page, setPage] = useState(1);
  const query = { review: tab, sort: 'oldest', page, pageSize: 25 };
  const list = useQuery(`reviews:${JSON.stringify(query)}`, () => api<Paged<Asset>>('/assets', { query }));
  const { reload } = list;
  useFocusEffect(useCallback(() => reload(), [reload]));
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <Screen wide>
      <Heading>{reviewer ? 'Registration review' : 'Returned for correction'}</Heading>
      <Body muted>
        {reviewer
          ? 'Check newly registered records. Approve them, or return them to their department with what needs correcting. Review never blocks registration.'
          : 'Records the Asset Management Team returned to your department. Correct them, then send them back for re-review.'}
      </Body>
      <Choice<Tab>
        label="Show"
        value={tab}
        options={[
          ...(reviewer ? [{ value: 'not_reviewed' as const, label: 'Awaiting first review' }, { value: 'corrected_awaiting_rereview' as const, label: 'Corrected — re-review' }] : []),
          { value: 'returned_for_correction', label: reviewer ? 'With departments for correction' : 'Returned to us' },
        ]}
        onChange={(v) => {
          setTab(v);
          setPage(1);
        }}
      />
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data && !list.data.items.length ? <Body muted>Nothing here.</Body> : null}
      {list.data?.items.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="link"
          accessibilityLabel={`${a.institutionalId} ${a.name}`}
          onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: a.id } })}
          style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, gap: 4, backgroundColor: t.backgroundElement }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>
            {a.institutionalId} — {a.name}
          </Text>
          <Row>
            <Badge label={REVIEW_STATUS_LABELS[a.review.status]} tone={a.review.status === 'returned_for_correction' ? 'bad' : 'warn'} />
            <Body muted>
              {a.department.name} · registered {formatDateTime(a.registeredAt)}
            </Body>
          </Row>
          {a.review.last && a.review.last.action !== 'approved' ? (
            <Text style={{ color: t.textSecondary }}>
              {a.review.last.action === 'returned' ? `Returned: ${a.review.last.note}` : `Corrected by ${a.review.last.by}${a.review.last.note ? `: ${a.review.last.note}` : ''}`}
              {a.review.last.fields.length ? ` (${a.review.last.fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')})` : ''}
            </Text>
          ) : null}
        </Pressable>
      ))}
      {pages > 1 ? (
        <Row>
          <Button title="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage(page - 1)} />
          <Body muted>
            Page {page} of {pages}
          </Body>
          <Button title="Next" variant="secondary" disabled={page >= pages} onPress={() => setPage(page + 1)} />
        </Row>
      ) : null}
    </Screen>
  );
}
