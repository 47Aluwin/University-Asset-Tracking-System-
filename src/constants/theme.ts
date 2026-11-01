/**
 * App colours, light and dark.
 *
 * Palette taken from the university website's theme (www.pnguot.ac.pg, 2026-10-28):
 *   deep maroon #4E0530 (top bar, footer)  ·  crimson #a51c30 (headings, links, menu)
 *   navy #293352 (menu accents)            ·  Roboto (body font)
 * Dark-mode values are lighter tints of the same hues so text keeps at least 4.5:1 contrast.
 * Status colours (danger / success / warning) are kept distinct from the brand colours.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Brand = {
  maroon: '#4E0530',
  crimson: '#A51C30',
  navy: '#293352',
} as const;

export const Colors = {
  light: {
    text: '#1F1A1C',
    background: '#ffffff',
    backgroundElement: '#F7F4F4',
    backgroundSelected: '#F6E4E7',
    textSecondary: '#5F5458',
    border: '#DDD3D5',
    heading: Brand.crimson,
    primary: Brand.crimson,
    onPrimary: '#ffffff',
    secondary: Brand.navy,
    header: Brand.maroon,
    onHeader: '#ffffff',
    danger: '#B42318',
    success: '#1E7A3C',
    warning: '#8A5A00',
  },
  dark: {
    text: '#F5F0F1',
    background: '#120D0F',
    backgroundElement: '#221A1D',
    backgroundSelected: '#3A2229',
    textSecondary: '#C4B8BC',
    border: '#4A3A40',
    heading: '#F28B9B',
    primary: '#E86A7C',
    onPrimary: '#2A0008',
    secondary: '#AFC0F2',
    header: Brand.maroon,
    onHeader: '#ffffff',
    danger: '#FF8A80',
    success: '#6FD08C',
    warning: '#F5C46B',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
