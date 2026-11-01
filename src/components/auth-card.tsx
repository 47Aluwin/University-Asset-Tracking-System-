// Centred single-card layout for account screens (set password, and similar), in the style of
// familiar account pages: app mark at the top, a title, an optional account chip, then the form.
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const t = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.backgroundElement }}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { backgroundColor: t.background, borderColor: t.border }]}>
          <View style={styles.brandRow} accessible accessibilityLabel="University Asset Tracking">
            <View style={styles.mark}>
              <Text style={styles.markText}>UAT</Text>
            </View>
            <Text style={[styles.brandText, { color: t.textSecondary }]}>University Asset Tracking</Text>
          </View>
          <Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>
            {title}
          </Text>
          {subtitle ? <View style={styles.subtitle}>{subtitle}</View> : null}
          <View style={styles.body}>{children}</View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Rounded chip showing which account the screen is about (like an email chip on account pages). */
export function AccountChip({ email }: { email: string }) {
  const t = useTheme();
  return (
    <View style={[styles.chip, { borderColor: t.border }]}>
      <View style={[styles.avatar, { backgroundColor: Brand.crimson }]}>
        <Text style={styles.avatarText}>{email.slice(0, 1).toUpperCase()}</Text>
      </View>
      <Text selectable style={[styles.chipText, { color: t.text }]} numberOfLines={1}>
        {email}
      </Text>
    </View>
  );
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      style={styles.checkRow}>
      <View style={[styles.box, { borderColor: checked ? t.primary : t.textSecondary, backgroundColor: checked ? t.primary : 'transparent' }]}>
        {checked ? <Text style={{ color: t.onPrimary, fontWeight: '700', fontSize: 13, lineHeight: 16 }}>✓</Text> : null}
      </View>
      <Text style={[styles.checkLabel, { color: t.text }]}>{label}</Text>
    </Pressable>
  );
}

/** One line of a live checklist: ✓ when met, ○ when not (meaning never depends on colour alone). */
export function RuleLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.rule} accessible accessibilityLabel={`${ok ? 'Done' : 'Not yet'}: ${String(children)}`}>
      <Text style={[styles.ruleIcon, { color: ok ? t.success : t.textSecondary }]}>{ok ? '✓' : '○'}</Text>
      <Text style={[styles.ruleText, { color: ok ? t.text : t.textSecondary }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 450, borderWidth: 1, borderRadius: 16, paddingHorizontal: 28, paddingVertical: 32 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'center' },
  mark: { width: 36, height: 36, borderRadius: 18, backgroundColor: Brand.maroon, alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#fff', fontWeight: '700', fontSize: 11, letterSpacing: 0.5, fontFamily: Fonts?.sans },
  brandText: { fontSize: 15, fontWeight: '500', fontFamily: Fonts?.sans },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '500', textAlign: 'center', marginTop: 20, fontFamily: Fonts?.sans },
  subtitle: { alignItems: 'center', marginTop: 10 },
  body: { marginTop: 24, gap: 16 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 999, paddingVertical: 4, paddingLeft: 4, paddingRight: 12, maxWidth: '100%' },
  avatar: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  chipText: { fontSize: 14, fontWeight: '500', flexShrink: 1, fontFamily: Fonts?.sans },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  box: { width: 20, height: 20, borderWidth: 2, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  checkLabel: { fontSize: 15, fontFamily: Fonts?.sans },
  rule: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  ruleIcon: { fontSize: 15, fontWeight: '700', width: 16, textAlign: 'center' },
  ruleText: { fontSize: 14, lineHeight: 20, flexShrink: 1, fontFamily: Fonts?.sans },
});
