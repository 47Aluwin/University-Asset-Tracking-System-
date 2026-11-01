// Shared, accessible building blocks so every screen looks and behaves the same.
import { forwardRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function Screen({ children, scroll = true, wide = false }: { children: ReactNode; scroll?: boolean; wide?: boolean }) {
  const t = useTheme();
  const inner = <View style={[styles.inner, { maxWidth: wide ? 1200 : MaxContentWidth }]}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: t.background }}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {inner}
        </ScrollView>
      ) : (
        <View style={[styles.scroll, { flex: 1 }]}>{inner}</View>
      )}
    </SafeAreaView>
  );
}

export function Heading({ children, level = 1 }: { children: ReactNode; level?: 1 | 2 }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[level === 1 ? styles.h1 : styles.h2, { color: t.heading }]}>
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.textSecondary : t.text }, style]}>{children}</Text>;
}

type FieldProps = TextInputProps & { label: string; error?: string; hint?: string };

export const Field = forwardRef<TextInputInstance, FieldProps>(function Field({ label, error, hint, style, ...rest }, ref) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.text }]}>{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={t.textSecondary}
        style={[
          styles.input,
          { color: t.text, borderColor: error ? t.danger : t.border, backgroundColor: t.background },
          style,
        ]}
        {...rest}
      />
      {hint && !error ? <Text style={[styles.small, { color: t.textSecondary }]}>{hint}</Text> : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.small, { color: t.danger }]}>
          ⚠ {error}
        </Text>
      ) : null}
    </View>
  );
});

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

/**
 * primary = filled crimson; secondary = navy outline; danger = red outline with a warning sign, so a
 * destructive action never looks like the (also red-toned) primary action.
 */
export function Button({ title, onPress, variant = 'primary', loading, disabled, style }: ButtonProps) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.primary : 'transparent';
  const fg = variant === 'primary' ? t.onPrimary : variant === 'danger' ? t.danger : t.secondary;
  const border = variant === 'primary' ? t.primary : fg;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border, opacity: off ? 0.55 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>
          {variant === 'danger' ? '⚠ ' : ''}
          {title}
        </Text>
      )}
    </Pressable>
  );
}

/** Maroon title band in the university website's style. Text only: no university logo is used. */
export function BrandBanner({ title, subtitle }: { title: string; subtitle?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: t.header }]}>
      <View style={[styles.bannerAccent, { backgroundColor: Brand.crimson }]} />
      <Text accessibilityRole="header" style={[styles.bannerTitle, { color: t.onHeader }]}>
        {title}
      </Text>
      {subtitle ? <Text style={[styles.bannerSubtitle, { color: t.onHeader }]}>{subtitle}</Text> : null}
    </View>
  );
}

export function LinkText({ children, onPress }: { children: ReactNode; onPress: () => void }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="link" onPress={onPress} style={[styles.body, { color: t.primary, textDecorationLine: 'underline' }]}>
      {children}
    </Text>
  );
}

/** Message box. The leading word makes the meaning clear without relying on colour. */
export function Notice({ kind, children }: { kind: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  const t = useTheme();
  const color = { error: t.danger, success: t.success, info: t.secondary, warning: t.warning }[kind];
  const prefix = { error: 'Error', success: 'Done', info: 'Note', warning: 'Warning' }[kind];
  return (
    <View accessibilityRole="alert" style={[styles.notice, { borderColor: color, backgroundColor: t.backgroundElement }]}>
      <Text style={[styles.body, { color: t.text }]}>
        <Text style={{ fontWeight: '700', color }}>{prefix}: </Text>
        {children}
      </Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.backgroundElement, borderColor: t.border }, style]}>{children}</View>;
}

/** Status label: text + border, never colour alone. */
export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info' }) {
  const t = useTheme();
  const color = { neutral: t.textSecondary, good: t.success, bad: t.danger, warn: t.warning, info: t.secondary }[tone];
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

/** Single-choice selector rendered as a row of buttons (works the same on phone and browser). */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  error?: string;
}) {
  const t = useTheme();
  return (
    <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={[styles.label, { color: t.text }]}>{label}</Text>
      <View style={styles.chips}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o.value)}
              style={[
                styles.chip,
                { borderColor: selected ? t.primary : t.border, backgroundColor: selected ? t.backgroundSelected : 'transparent' },
              ]}>
              <Text style={{ color: t.text, fontWeight: selected ? '700' : '500' }}>
                {selected ? '✓ ' : ''}
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={[styles.small, { color: t.danger }]}>⚠ {error}</Text> : null}
    </View>
  );
}

/**
 * A Choice with a search box once the list is long, for picking from many options (e.g. schools).
 * The selected option always stays visible, even when it does not match the search text.
 */
export function SearchableChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
  searchFrom = 6,
  emptyText = 'Nothing matches your search.',
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  error?: string;
  /** Show the search box when there are at least this many options. */
  searchFrom?: number;
  emptyText?: string;
}) {
  const t = useTheme();
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.value === value || o.label.toLowerCase().includes(needle)) : options;
  return (
    <View style={{ gap: 6 }}>
      {options.length >= searchFrom ? (
        <Field
          label={`Search ${label.toLowerCase()}`}
          value={search}
          onChangeText={setSearch}
          placeholder="Type to filter the list"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}
      <Choice label={label} value={value} options={shown} onChange={onChange} error={error} />
      {needle && shown.length === 0 ? <Text style={[styles.small, { color: t.textSecondary }]}>{emptyText}</Text> : null}
    </View>
  );
}

/**
 * Groups a screen's filters under one heading with a count of active filters and "Clear all".
 * Starts open on wide screens (room to spare) and folded on phones and narrow windows (the list matters
 * more), or open whenever filters are already active.
 */
export function FilterPanel({ active, onClear, children }: { active: number; onClear: () => void; children: ReactNode }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState((Platform.OS === 'web' && width >= 700) || active > 0);
  return (
    <View style={[styles.card, { borderColor: t.border, backgroundColor: t.backgroundElement }]}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Filters${active ? `, ${active} active` : ''}. ${open ? 'Hide' : 'Show'} filters`}
          onPress={() => setOpen((o) => !o)}
          style={({ pressed }) => [{ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.7 : 1 }]}>
          <Text style={[styles.h2, { color: t.text }]}>
            {open ? '▾' : '▸'} Filters{active ? ` (${active} active)` : ''}
          </Text>
        </Pressable>
        {active ? <Button title="Clear all" variant="secondary" onPress={onClear} /> : null}
      </View>
      {open ? <View style={{ gap: Spacing.three }}>{children}</View> : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <ActivityIndicator color={t.primary} />
      <Text style={[styles.body, { color: t.textSecondary }]}>{label}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export const formatDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: 'center', paddingVertical: Spacing.four },
  inner: { width: '100%', paddingHorizontal: Spacing.three, gap: Spacing.three },
  h1: { fontFamily: Fonts?.sans, fontSize: 26, lineHeight: 32, fontWeight: '700' },
  h2: { fontFamily: Fonts?.sans, fontSize: 19, lineHeight: 26, fontWeight: '700' },
  body: { fontFamily: Fonts?.sans, fontSize: 16, lineHeight: 22 },
  small: { fontFamily: Fonts?.sans, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: Fonts?.sans, fontSize: 15, fontWeight: '600' },
  field: { gap: Spacing.one },
  input: { fontFamily: Fonts?.sans, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 44 },
  button: { minHeight: 44, borderRadius: 8, borderWidth: 1.5, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontFamily: Fonts?.sans, fontSize: 16, fontWeight: '700' },
  notice: { borderLeftWidth: 4, borderWidth: 1, borderRadius: 8, padding: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: Spacing.three, gap: Spacing.two },
  badge: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, alignSelf: 'flex-start' },
  badgeText: { fontFamily: Fonts?.sans, fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  chip: { borderWidth: 1.5, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, minHeight: 40, justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.four, gap: Spacing.two },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, alignItems: 'center' },
  banner: { borderRadius: 12, paddingVertical: Spacing.four, paddingHorizontal: Spacing.four, gap: Spacing.one, overflow: 'hidden' },
  bannerAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 6 },
  bannerTitle: { fontFamily: Fonts?.sans, fontSize: 24, lineHeight: 30, fontWeight: '700' },
  bannerSubtitle: { fontFamily: Fonts?.sans, fontSize: 15, lineHeight: 21, opacity: 0.9 },
});
