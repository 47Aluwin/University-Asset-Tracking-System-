import { useState } from 'react';

import { Body, Button, Card, Field, Heading, Notice, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!email.trim()) return setError('Enter your institutional email.');
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/auth/forgot-password', { body: { email: email.trim() } });
      setMessage(r.message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>Forgot password</Heading>
      <Body muted>We will send a single-use link that expires after 30 minutes.</Body>
      {message ? <Notice kind="info">{message}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Button title="Send reset link" onPress={submit} loading={busy} />
      </Card>
    </Screen>
  );
}
