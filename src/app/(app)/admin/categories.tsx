import { useState } from 'react';

import { Badge, Body, Button, Card, Field, Heading, Loading, Notice, Row, Screen } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { confirmAction } from '@/lib/confirm';
import type { Category } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

export default function Categories() {
  const list = useQuery('categories', () => api<{ items: Category[] }>('/categories'));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setMsg(null);
    setErrors({});
    setBusy(true);
    try {
      await api('/categories', { body: { name: name.trim(), description: description.trim() || undefined } });
      setName('');
      setDescription('');
      setMsg({ kind: 'success', text: 'Category added.' });
      list.reload();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      setMsg({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (c: Category) => {
    const verb = c.isActive ? 'Deactivate' : 'Reactivate';
    const detail = c.isActive ? 'It will no longer be offered for new registrations. Existing assets keep this category.' : 'It will be offered again.';
    if (!(await confirmAction(`${verb} "${c.name}"?`, detail, verb))) return;
    try {
      await api(`/categories/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } });
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) });
    }
  };

  return (
    <Screen>
      <Heading>Asset categories</Heading>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <Card>
        <Heading level={2}>Add category</Heading>
        <Field label="Name" value={name} onChangeText={setName} error={errors.name} placeholder="e.g. Laptops" />
        <Field label="Description (optional)" value={description} onChangeText={setDescription} error={errors.description} />
        <Button title="Add category" onPress={add} loading={busy} />
      </Card>
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data?.items.length === 0 ? <Body muted>No categories yet. Staff cannot register assets until at least one exists.</Body> : null}
      {list.data?.items.map((c) => (
        <Card key={c.id}>
          <Row>
            <Heading level={2}>{c.name}</Heading>
            <Badge label={c.isActive ? 'Active' : 'Inactive'} tone={c.isActive ? 'good' : 'neutral'} />
          </Row>
          {c.description ? <Body muted>{c.description}</Body> : null}
          <Row>
            <Button title={c.isActive ? 'Deactivate' : 'Reactivate'} variant="secondary" onPress={() => toggle(c)} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
