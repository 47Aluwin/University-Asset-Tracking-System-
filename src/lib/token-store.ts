// Native (iOS/Android): session token kept in the OS keychain / keystore.
import * as SecureStore from 'expo-secure-store';

const KEY = 'uats.session';

export const tokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token: string) => SecureStore.setItemAsync(KEY, token),
  clear: () => SecureStore.deleteItemAsync(KEY),
};
