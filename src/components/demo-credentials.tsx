// Demo account box for the sign-in page, so testers and reviewers can try the app without an account.
// Shown only when EXPO_PUBLIC_DEMO_EMAIL and EXPO_PUBLIC_DEMO_PASSWORD are set (development: .env.local).
// Never set them for a real deployment: anything EXPO_PUBLIC_* is visible to everyone who opens the app.
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/ui';
import { Brand, Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export const DEMO_EMAIL = process.env.EXPO_PUBLIC_DEMO_EMAIL?.trim() || '';
export const DEMO_PASSWORD = process.env.EXPO_PUBLIC_DEMO_PASSWORD?.trim() || '';
export const demoEnabled = !!(DEMO_EMAIL && DEMO_PASSWORD);

function CredentialRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const t = useTheme();
  // Narrow screens: the value gets a full line (an email never breaks mid-word), buttons go below it.
  const narrow = useWindowDimensions().width < 600;
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.cred}>
      <Text style={[styles.label, { color: t.textSecondary }]}>{label}</Text>
      <View style={styles.valueRow}>
        <Pressable
          onPress={secret ? () => setShown((s) => !s) : undefined}
          disabled={!secret}
          accessibilityRole={secret ? 'button' : 'text'}
          accessibilityLabel={secret ? (shown ? `Demo password: ${value}. Tap to hide` : 'Demo password hidden. Tap to show') : `Demo ${label.toLowerCase()}: ${value}`}
          style={[styles.value, narrow && { flexBasis: '100%' }, { borderColor: t.border, backgroundColor: t.background }]}>
          <Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.valueText, { color: t.text }]}>
            {shown ? value : '•'.repeat(Math.max(8, value.length))}
          </Text>
        </Pressable>
        <View style={styles.actions}>
          {secret ? <Button title={shown ? 'Hide' : 'Show'} variant="secondary" onPress={() => setShown((s) => !s)} /> : null}
          <Button title={copied ? 'Copied ✓' : 'Copy'} variant="secondary" onPress={copy} />
        </View>
      </View>
    </View>
  );
}

export function DemoCredentials({ onUse }: { onUse: (email: string, password: string) => void }) {
  const t = useTheme();
  if (!demoEnabled) return null;
  return (
    <View
      accessibilityRole="summary"
      style={[styles.box, { borderColor: Brand.crimson, backgroundColor: t.backgroundElement }]}>
      <Text accessibilityRole="header" style={[styles.heading, { color: t.text }]}>
        Test the App – Demo Account
      </Text>
      <Text style={[styles.note, { color: t.textSecondary }]}>Use these demo credentials to explore the application.</Text>
      <CredentialRow label="Email" value={DEMO_EMAIL} />
      <CredentialRow label="Password" value={DEMO_PASSWORD} secret />
      <Button title="Fill in the sign-in form for me" onPress={() => onUse(DEMO_EMAIL, DEMO_PASSWORD)} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderLeftWidth: 5, borderRadius: 12, padding: 16, gap: 12 },
  heading: { fontFamily: Fonts?.sans, fontSize: 19, lineHeight: 26, fontWeight: '700' },
  note: { fontFamily: Fonts?.sans, fontSize: 15, lineHeight: 21 },
  cred: { gap: 4 },
  label: { fontFamily: Fonts?.sans, fontSize: 14, fontWeight: '600' },
  valueRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  value: { flexGrow: 1, flexBasis: 200, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 },
  valueText: { fontFamily: Fonts?.mono ?? 'monospace', fontSize: 16 },
  actions: { flexDirection: 'row', gap: 8 },
});
