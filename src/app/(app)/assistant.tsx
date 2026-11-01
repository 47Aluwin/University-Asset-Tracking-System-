import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Body, Button, Card, Field, Heading, Loading, Notice, Row, Screen } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/use-query';

type Turn = { role: 'user' | 'assistant'; content: string };

const SUGGESTIONS = [
  'How do I register a new asset?',
  'How do I print and attach a QR label?',
  'How do I report a damaged asset?',
  'How do I see the assets of one faculty?',
];

/** The server accepts up to 20 messages per conversation. */
const MAX_TURNS = 20;

export default function AssistantScreen() {
  const t = useTheme();
  const status = useQuery('assistant-status', () => api<{ enabled: boolean }>('/assistant/status'));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = turns.length >= MAX_TURNS - 1;

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy || full) return;
    setError(null);
    const next: Turn[] = [...turns, { role: 'user', content: question }];
    setTurns(next);
    setDraft('');
    setBusy(true);
    try {
      const r = await api<{ reply: string }>('/assistant/messages', { body: { messages: next } });
      setTurns([...next, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      // Keep the question visible so it can be sent again; show why it failed.
      setTurns(turns);
      setDraft(question);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading>Help assistant</Heading>
      <Body muted>
        Ask how to use the app. The assistant explains steps and screens; it cannot see your asset records or change anything. It can make
        mistakes — check important steps in the app or with a System Administrator.
      </Body>

      {status.error ? <Notice kind="error">{status.error}</Notice> : null}
      {!status.data && !status.error ? <Loading label="Checking the assistant…" /> : null}
      {status.data && !status.data.enabled ? (
        <Notice kind="info">The help assistant is not set up on this server yet. A System Administrator needs to add an AI service key.</Notice>
      ) : null}

      {status.data?.enabled ? (
        <>
          {turns.length === 0 ? (
            <Card>
              <Heading level={2}>Try asking</Heading>
              <View style={styles.chips}>
                {SUGGESTIONS.map((s) => (
                  <Pressable
                    key={s}
                    accessibilityRole="button"
                    onPress={() => send(s)}
                    style={({ pressed }) => [styles.chip, { borderColor: t.border, opacity: pressed ? 0.7 : 1 }]}>
                    <Text style={{ color: t.text }}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </Card>
          ) : null}

          <View style={{ gap: 10 }} accessibilityLiveRegion="polite">
            {turns.map((m, i) => (
              <View
                key={i}
                style={[
                  styles.bubble,
                  m.role === 'user'
                    ? { alignSelf: 'flex-end', backgroundColor: t.backgroundSelected }
                    : { alignSelf: 'flex-start', backgroundColor: t.backgroundElement, borderColor: t.border, borderWidth: 1 },
                ]}>
                <Text style={{ color: t.textSecondary, fontSize: 12, fontWeight: '600' }}>{m.role === 'user' ? 'You' : 'Assistant'}</Text>
                <Text style={{ color: t.text, fontSize: 16, lineHeight: 22 }} selectable>
                  {m.content}
                </Text>
              </View>
            ))}
            {busy ? <Loading label="Thinking…" /> : null}
          </View>

          {error ? <Notice kind="error">{error}</Notice> : null}
          {full ? <Notice kind="info">This conversation is long. Start a new one to keep answers accurate.</Notice> : null}

          <Field
            label="Your question"
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. How do I move an asset to another room?"
            multiline
            maxLength={2000}
            editable={!full}
            style={{ minHeight: 64, textAlignVertical: 'top' }}
          />
          <Row>
            <Button title="Ask" onPress={() => send(draft)} loading={busy} />
            {turns.length ? (
              <Button
                title="New conversation"
                variant="secondary"
                onPress={() => {
                  setTurns([]);
                  setError(null);
                }}
              />
            ) : null}
          </Row>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  bubble: { maxWidth: '88%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
});
