import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';

import { DemoCredentials } from '@/components/demo-credentials';
import { Body, BrandBanner, Button, Card, Field, LinkText, Notice, Row, Screen } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function SignIn() {
  const { signIn } = useSession();
  // Pre-filled after setting a password, so people only need to type it.
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(typeof params.email === 'string' ? params.email : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const passwordRef = useRef<TextInputInstance>(null);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your institutional email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.replace('/');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ACCOUNT_LOCKED') {
        const s = (e.details as { retryAfterSeconds?: number })?.retryAfterSeconds;
        setError(`${e.message}${s ? ` Try again in about ${Math.ceil(s / 60)} minutes,` : ''} or ask an administrator to unlock it.`);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <BrandBanner title="University Asset Tracking" subtitle="Sign in with your institutional account." />
      <Card>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <Field
          ref={passwordRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Row>
          <Button
            title={showPassword ? 'Hide password' : 'Show password'}
            variant="secondary"
            onPress={() => setShowPassword((v) => !v)}
          />
        </Row>
        <Button title="Sign in" onPress={submit} loading={busy} />
      </Card>
      <DemoCredentials
        onUse={(demoEmail, demoPassword) => {
          setEmail(demoEmail);
          setPassword(demoPassword);
          setError(null);
        }}
      />
      <Row>
        <LinkText onPress={() => router.push('/forgot-password')}>Forgot password?</LinkText>
      </Row>
      <Row>
        <Body muted>New staff member?</Body>
        <LinkText onPress={() => router.push('/request-access')}>Request access</LinkText>
      </Row>
    </Screen>
  );
}
