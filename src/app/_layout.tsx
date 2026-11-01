import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { useHeaderOptions } from '@/hooks/use-header-options';
// Must run before any QR scanning: serves the web QR decoder from this app instead of a CDN.
import '@/lib/barcode-setup';
import { OfflineProvider } from '@/lib/offline/provider';
import { SessionProvider, useSession } from '@/lib/session';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <SessionProvider>
        <OfflineProvider>
          <RootNavigator />
        </OfflineProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

function RootNavigator() {
  const { user, isLoading } = useSession();
  const headerOptions = useHeaderOptions();

  useEffect(() => {
    if (!isLoading) SplashScreen.hideAsync();
  }, [isLoading]);

  if (isLoading) return null; // splash screen stays visible while the saved session is checked

  return (
    <>
    <StatusBar style="light" />
    <Stack screenOptions={headerOptions}>
      {/* Signed-in area. The server enforces permissions; these guards only control navigation. */}
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
        <Stack.Screen name="request-access" options={{ title: 'Request access' }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Forgot password' }} />
      </Stack.Protected>

      {/* Reachable from emailed / admin-issued links whether or not someone is signed in. */}
      <Stack.Screen name="reset-password" options={{ title: 'Set password', headerShown: false }} />
    </Stack>
    </>
  );
}
