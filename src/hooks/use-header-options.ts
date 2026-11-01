import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Maroon header bar with white title, matching the university website's top bar. */
export function useHeaderOptions() {
  const t = useTheme();
  return {
    headerStyle: { backgroundColor: t.header },
    headerTintColor: t.onHeader,
    headerTitleStyle: { fontFamily: Fonts?.sans, fontWeight: '700' as const },
    contentStyle: { backgroundColor: t.background },
  };
}
