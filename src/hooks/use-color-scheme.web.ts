import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

const noopSubscribe = () => () => {};

/**
 * Static web rendering has no colour scheme, so render 'light' on the server and
 * switch to the real scheme once running in the browser.
 */
export function useColorScheme() {
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const colorScheme = useRNColorScheme();
  return isClient ? colorScheme : 'light';
}
