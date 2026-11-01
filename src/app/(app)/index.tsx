import { router, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Badge, Body, BrandBanner, Card, Heading, Notice, Screen } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { offlineCapable } from '@/lib/offline';
import { useOffline } from '@/lib/offline/provider';
import { useSession } from '@/lib/session';
import { ROLE_LABELS } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

type Tile = { title: string; detail: string; href: Href; badge?: string };

export default function Home() {
  const { user, can, startedOffline } = useSession();
  const offline = useOffline();
  const [pendingRequests, setPendingRequests] = useState<number | null>(null);
  // The help assistant tile appears only when the server has an AI key configured (offline or errors: hidden).
  const assistant = useQuery('assistant-status', () => api<{ enabled: boolean }>('/assistant/status'));

  useFocusEffect(
    useCallback(() => {
      if (!can('access_requests.review')) return;
      api<{ total: number }>('/access-requests', { query: { status: 'pending', pageSize: 1 } })
        .then((r) => setPendingRequests(r.total))
        .catch(() => setPendingRequests(null));
    }, [can]),
  );

  // Small live counts for the tiles (totals only; the lists themselves load on their own screens).
  const [counts, setCounts] = useState<{ overdue: number; due: number; flags: number; maintenance: number; review: number; returned: number } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!can('assets.read')) return;
      const total = (path: string, query: Record<string, string | number>) =>
        api<{ total: number }>(path, { query: { ...query, pageSize: 1 } }).then((r) => r.total).catch(() => 0);
      Promise.all([
        total('/assets', { verification: 'overdue' }),
        total('/assets', { verification: 'due' }),
        can('flags.read') ? total('/flags', { status: 'open' }) : Promise.resolve(0),
        can('maintenance.read') ? total('/maintenance', { open: 'true' }) : Promise.resolve(0),
        can('assets.review') ? total('/assets', { review: 'needs_review' }) : Promise.resolve(0),
        can('assets.edit') ? total('/assets', { review: 'returned_for_correction' }) : Promise.resolve(0),
      ]).then(([overdue, due, flags, maintenance, review, returned]) => setCounts({ overdue, due, flags, maintenance, review, returned }));
    }, [can]),
  );

  if (!user) return null;

  const admin: Tile[] = [];
  if (can('access_requests.review'))
    admin.push({
      title: 'Access requests',
      detail: 'Approve or reject staff requests',
      href: '/admin/access-requests',
      badge: pendingRequests ? `${pendingRequests} pending` : undefined,
    });
  if (can('users.manage')) admin.push({ title: 'Users', detail: 'Accounts, roles, departments, deactivation', href: '/admin/users' });
  if (can('departments.manage')) admin.push({ title: 'Faculties and departments', detail: 'Faculties, schools, central units and default currencies', href: '/admin/departments' });
  if (can('categories.manage')) admin.push({ title: 'Categories', detail: 'Asset categories offered at registration', href: '/admin/categories' });
  if (can('settings.manage')) admin.push({ title: 'Label layout', detail: 'Label sheet / label printer sizes, test print', href: '/admin/label-layout' });
  if (can('schedules.manage')) admin.push({ title: 'Verification schedules', detail: 'How often assets must be physically checked', href: '/admin/schedules' });
  if (can('audit.read')) admin.push({ title: 'Audit log', detail: 'Who did what, and when', href: '/admin/audit' });

  const overview: Tile[] = [];
  if (can('dashboard.read')) overview.push({ title: 'Dashboard', detail: 'Totals, values per currency, verification, maintenance, departments', href: '/dashboard' });
  if (can('reports.generate')) overview.push({ title: 'Reports', detail: 'Asset register, department value, verification, maintenance — PDF and Excel', href: '/reports' });

  const assets: Tile[] = [];
  if (offlineCapable || offline.problems)
    assets.push({
      title: 'Waiting to sync',
      detail: 'Work saved on this phone, conflicts to review',
      href: '/sync',
      badge: offline.problems ? `${offline.problems} need attention` : offline.waiting ? `${offline.waiting} waiting` : undefined,
    });
  if (can('verification.record')) assets.push({ title: 'Scan asset', detail: 'Scan a QR label to verify, relocate or open an asset', href: '/scan' });
  if (can('assets.register')) {
    assets.push({ title: 'Register asset', detail: 'Scan the item’s barcode, save it, then print its QR label and stick it on', href: '/inventory/new' });
  }
  if (can('assets.read')) {
    assets.push({ title: 'Asset register', detail: 'Search, filter and view assets', href: '/inventory' });
    assets.push({
      title: 'Due and overdue',
      detail: 'Assets that need physical verification',
      href: { pathname: '/inventory', params: { verification: 'due_or_overdue' } },
      badge: counts ? (counts.overdue ? `${counts.overdue} overdue` : counts.due ? `${counts.due} due` : undefined) : undefined,
    });
    assets.push({ title: 'Find by asset code', detail: 'Open an asset from the ID on its label', href: '/inventory/find' });
  }
  if (can('maintenance.read')) {
    assets.push({
      title: 'Maintenance',
      detail: can('maintenance.manage') ? 'Repair requests for your department' : 'Repair requests across departments (oversight)',
      href: '/maintenance',
      badge: counts?.maintenance ? `${counts.maintenance} open` : undefined,
    });
  }
  if (can('assets.review')) {
    assets.push({
      title: 'Registration review',
      detail: 'Approve new records or return them for correction',
      href: '/asset-reviews',
      badge: counts?.review ? `${counts.review} to review` : undefined,
    });
  } else if (can('assets.edit') && counts?.returned) {
    assets.push({
      title: 'Returned for correction',
      detail: 'Records the Asset Management Team asked your department to correct',
      href: { pathname: '/asset-reviews', params: { tab: 'returned_for_correction' } },
      badge: `${counts.returned} to correct`,
    });
  }
  if (can('flags.read')) {
    assets.push({
      title: 'Review flags',
      detail: can('flags.review') ? 'Discrepancies, transfers and missing reports to check' : 'Items flagged in your department',
      href: '/review',
      badge: counts?.flags ? `${counts.flags} open` : undefined,
    });
  }

  return (
    <Screen wide>
      <BrandBanner
        title={`Hello, ${user.fullName}`}
        subtitle={`${ROLE_LABELS[user.role]}${user.department ? ` · ${user.department.name}` : ' · All departments'}`}
      />

      {!offline.online || startedOffline ? (
        <Notice kind="warning">
          No connection. You can keep scanning, verifying, relocating and reporting; work is saved on this phone and sent when you are back online.
        </Notice>
      ) : null}
      {offline.waiting || offline.problems ? (
        <Notice kind={offline.problems ? 'error' : 'info'}>
          {offline.waiting ? `${offline.waiting} item(s) saved on this phone are waiting to be sent. ` : ''}
          {offline.problems ? `${offline.problems} item(s) were not accepted and need your attention. ` : ''}
          <Text onPress={() => router.push('/sync')} style={{ textDecorationLine: 'underline' }}>
            Open “Waiting to sync”
          </Text>
        </Notice>
      ) : null}

      {overview.length ? (
        <>
          <Heading level={2}>Overview</Heading>
          <View style={styles.grid}>
            {overview.map((t) => (
              <TileCard key={t.title} tile={t} />
            ))}
          </View>
        </>
      ) : null}

      {admin.length ? (
        <>
          <Heading level={2}>Administration</Heading>
          <View style={styles.grid}>
            {admin.map((t) => (
              <TileCard key={t.title} tile={t} />
            ))}
          </View>
        </>
      ) : null}

      {assets.length ? (
        <>
          <Heading level={2}>Assets</Heading>
          <View style={styles.grid}>
            {assets.map((t) => (
              <TileCard key={t.title} tile={t} />
            ))}
          </View>
        </>
      ) : null}
      <Card>
        <Body muted>
          {offlineCapable
            ? 'Fieldwork done without a connection is saved on this phone and sent automatically later.'
            : 'The web version works online only. Use the phone app for fieldwork without a connection.'}
        </Body>
      </Card>

      <View style={styles.grid}>
        {assistant.data?.enabled ? <TileCard tile={{ title: 'Help assistant', detail: 'Ask how to use the app', href: '/assistant' }} /> : null}
        <TileCard tile={{ title: 'My account', detail: 'Change password, sign out', href: '/account' }} />
      </View>
    </Screen>
  );
}

function TileCard({ tile }: { tile: Tile }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${tile.title}. ${tile.detail}${tile.badge ? `. ${tile.badge}` : ''}`}
      onPress={() => router.push(tile.href)}
      style={({ pressed }) => [styles.tile, { backgroundColor: t.backgroundElement, borderColor: t.border, opacity: pressed ? 0.8 : 1 }]}>
      <Text style={[styles.tileTitle, { color: t.text }]}>{tile.title}</Text>
      <Text style={{ color: t.textSecondary }}>{tile.detail}</Text>
      {tile.badge ? <Badge label={tile.badge} tone="warn" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { flexGrow: 1, flexBasis: 260, borderWidth: 1, borderRadius: 12, padding: 16, gap: 6, minHeight: 96 },
  tileTitle: { fontSize: 18, fontWeight: '700' },
});
