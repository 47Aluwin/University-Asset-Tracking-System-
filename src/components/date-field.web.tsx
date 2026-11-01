// Website date entry: the browser's own calendar picker (keyboard accessible), value "YYYY-MM-DD".
import { Text, View } from 'react-native';

import type { DateFieldProps } from '@/components/date-field';
import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type { DateFieldProps };

export function DateField({ label, value, onChangeText, error, hint, max }: DateFieldProps) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontFamily: Fonts?.sans, fontSize: 15, fontWeight: '600', color: t.text }}>{label}</Text>
      <input
        type="date"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={value}
        max={max}
        onChange={(e) => onChangeText(e.currentTarget.value)}
        style={{
          fontFamily: 'inherit',
          fontSize: 16,
          minHeight: 44,
          boxSizing: 'border-box',
          padding: '8px 12px',
          borderRadius: 8,
          border: `1px solid ${error ? t.danger : t.border}`,
          backgroundColor: t.background,
          color: t.text,
          colorScheme: 'light dark',
          maxWidth: 260,
        }}
      />
      {hint && !error ? <Text style={{ fontSize: 13, lineHeight: 18, color: t.textSecondary }}>{hint}</Text> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ fontSize: 13, lineHeight: 18, color: t.danger }}>⚠ {error}</Text> : null}
    </View>
  );
}
