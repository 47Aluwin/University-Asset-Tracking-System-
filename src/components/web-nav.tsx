// Website menu bar: jump between the main areas from any page instead of going back to Home.
// Web only — on the phone app the home screen tiles and the back button do this job.
import { router, usePathname, type Href } from 'expo-router';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/session';

type Item = { label: string; href: Href; match: (path: string) => boolean };

export function WebNav() {
  const t = useTheme();
  const path = usePathname();
  const { width } = useWindowDimensions();
  const { user, can } = useSession();
  if (Platform.OS !== 'web' || !user) return null;

  const starts = (p: string) => (x: string) => x === p || x.startsWith(`${p}/`);
  const items: Item[] = [{ label: 'Home', href: '/', match: (x) => x === '/' }];
  if (can('assets.read')) {
    items.push({ label: 'Assets', href: '/inventory', match: (x) => starts('/inventory')(x) && x !== '/inventory/new' });
  }
  if (can('assets.register')) items.push({ label: 'Register asset', href: '/inventory/new', match: (x) => x === '/inventory/new' });
  if (can('verification.record')) items.push({ label: 'Scan', href: '/scan', match: starts('/scan') });
  if (can('maintenance.read')) items.push({ label: 'Maintenance', href: '/maintenance', match: starts('/maintenance') });
  if (can('assets.review')) items.push({ label: 'Review', href: '/asset-reviews', match: starts('/asset-reviews') });
  if (can('dashboard.read')) items.push({ label: 'Dashboard', href: '/dashboard', match: starts('/dashboard') });
  if (can('reports.generate')) items.push({ label: 'Reports', href: '/reports', match: starts('/reports') });
  if (can('users.manage')) items.push({ label: 'Users', href: '/admin/users', match: starts('/admin/users') });
  items.push({ label: 'My account', href: '/account', match: starts('/account') });

  const links = items.map((it) => {
    const active = it.match(path);
    return (
      <Pressable
        key={it.label}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        aria-current={active ? 'page' : undefined}
        onPress={() => router.navigate(it.href)}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
          styles.link,
          { borderBottomColor: active ? t.onHeader : 'transparent', opacity: pressed ? 0.7 : 1 },
          hovered && !active ? { backgroundColor: 'rgba(255,255,255,0.12)' } : null,
        ]}>
        <Text style={[styles.linkText, { color: t.onHeader, fontWeight: active ? '700' : '500' }]}>{it.label}</Text>
      </Pressable>
    );
  });

  return (
    <View accessibilityRole="navigation" aria-label="Main menu" style={[styles.bar, { backgroundColor: t.header, borderTopColor: 'rgba(255,255,255,0.18)' }]}>
      {width >= 900 ? (
        <View style={styles.wide}>{links}</View>
      ) : (
        // Narrow windows: one row that scrolls sideways, so the page itself never does.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.narrow}>
          {links}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1 },
  wide: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 12 },
  narrow: { flexDirection: 'row', paddingHorizontal: 8 },
  link: { paddingHorizontal: 14, minHeight: 44, justifyContent: 'center', borderBottomWidth: 3 },
  linkText: { fontFamily: Fonts?.sans, fontSize: 15 },
});
