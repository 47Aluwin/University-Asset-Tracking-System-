import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Text, View, type TextInputInstance } from 'react-native';

import { AccountChip, AuthCard, Checkbox, RuleLine } from '@/components/auth-card';
import { Body, Button, Field, LinkText, Notice, Row } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, ApiError, errorMessage } from '@/lib/api';
import { passwordRules } from '@/lib/password-rules';
import { useSession } from '@/lib/session';
import { useQuery } from '@/lib/use-query';

type LinkInfo = { email: string; fullName: string; purpose: 'setup' | 'reset' };

export default function ResetPassword() {
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  // Check the link first (without using it) so we can show the account, or say straight away that it no longer works.
  const link = useQuery(`reset-link:${token}`, () =>
    token ? api<LinkInfo>('/auth/reset-password/check', { body: { token }, noAuthRedirect: true }) : Promise.reject(new ApiError(400, 'NO_TOKEN', '')),
  );

  if (!link.data && !link.error) {
    return (
      <AuthCard title="Checking your link">
        <ActivityIndicator />
      </AuthCard>
    );
  }
  if (!link.data) return <LinkProblem networkError={link.error && /reach the server/i.test(link.error) ? link.error : null} />;
  return <PasswordForm token={token} info={link.data} />;
}

function LinkProblem({ networkError }: { networkError: string | null }) {
  return (
    <AuthCard title={networkError ? 'Can’t check this link' : 'This link no longer works'}>
      <Body muted style={{ textAlign: 'center' }}>
        {networkError
          ? networkError
          : 'Password links work once and expire after a while. This one has already been used, has expired, or is incomplete.'}
      </Body>
      {!networkError ? (
        <Body muted style={{ textAlign: 'center' }}>
          If you already set your password, just sign in. Otherwise use “Forgot password?” on the sign-in page, or ask a system administrator for a new link.
        </Body>
      ) : null}
      <Button title="Go to sign in" onPress={() => router.replace('/sign-in')} />
    </AuthCard>
  );
}

function PasswordForm({ token, info }: { token: string; info: LinkInfo }) {
  const t = useTheme();
  const { user, signOut } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<TextInputInstance>(null);

  const rules = passwordRules(password, confirm, info.email);
  const isNew = info.purpose === 'setup';

  const submit = async () => {
    setError(null);
    if (!rules.longEnough) return setError('Use at least 12 characters.');
    if (!rules.avoidsEmail) return setError('Choose a password that doesn’t include your email.');
    if (!rules.matches) return setError('Those passwords didn’t match. Try again.');
    setBusy(true);
    try {
      await api('/auth/reset-password', { body: { token, newPassword: password }, noAuthRedirect: true });
      setDone(true);
      // The link may belong to a different account than the one signed in on this device.
      if (user) await signOut();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title="You’re all set" subtitle={<AccountChip email={info.email} />}>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 44, color: t.success }} accessibilityElementsHidden>
            ✓
          </Text>
        </View>
        <Body muted style={{ textAlign: 'center' }}>
          {isNew ? 'Your password has been created.' : 'Your password has been changed. Any other devices signed in to this account have been signed out.'}
        </Body>
        <Button title="Sign in" onPress={() => router.replace({ pathname: '/sign-in', params: { email: info.email } })} />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={isNew ? 'Create a password' : 'Choose a new password'}
      subtitle={
        <View style={{ alignItems: 'center', gap: 10 }}>
          {isNew ? <Body muted>Welcome, {info.fullName}</Body> : null}
          <AccountChip email={info.email} />
        </View>
      }>
      <Field
        label="Password"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setError(null);
        }}
        secureTextEntry={!show}
        autoComplete="new-password"
        textContentType="newPassword"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
      />
      <Field
        ref={confirmRef}
        label="Confirm"
        value={confirm}
        onChangeText={(v) => {
          setConfirm(v);
          setError(null);
        }}
        secureTextEntry={!show}
        autoComplete="new-password"
        textContentType="newPassword"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Checkbox label="Show password" checked={show} onChange={setShow} />

      <View style={{ gap: 6 }}>
        <RuleLine ok={rules.longEnough}>At least 12 characters</RuleLine>
        <RuleLine ok={rules.avoidsEmail}>{rules.emailRuleText}</RuleLine>
        <RuleLine ok={rules.matches}>Both passwords match</RuleLine>
      </View>

      {error ? <Notice kind="error">{error}</Notice> : null}

      <Row style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <LinkText onPress={() => router.replace('/sign-in')}>Back to sign in</LinkText>
        <Button title="Next" onPress={submit} loading={busy} style={{ minWidth: 110 }} />
      </Row>
    </AuthCard>
  );
}
