// Date entry, value always "YYYY-MM-DD" (or "" for none). The website version (date-field.web.tsx) shows the
// browser's calendar picker; on phones this typed field is used.
import { Field } from '@/components/ui';

export type DateFieldProps = {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  error?: string;
  hint?: string;
  /** Latest allowed date, "YYYY-MM-DD" (e.g. today for purchase dates). */
  max?: string;
};

export function DateField({ label, value, onChangeText, error, hint }: DateFieldProps) {
  return (
    <Field
      label={label}
      value={value}
      onChangeText={onChangeText}
      error={error}
      placeholder="YYYY-MM-DD"
      hint={hint ? `${hint} Format: YYYY-MM-DD, e.g. 2026-03-14.` : 'Format: YYYY-MM-DD, e.g. 2026-03-14.'}
      autoCapitalize="none"
      keyboardType="numbers-and-punctuation"
      maxLength={10}
    />
  );
}
