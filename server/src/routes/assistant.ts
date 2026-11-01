// Help assistant API. Signed-in users only (global sign-in rule). It sends the AI only the conversation the
// person typed plus their role name: no asset, user or audit data. The audit log records that a question
// was asked and its token use, never the question text.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requireUser, routeLimit, type AppDeps } from '../app.ts';
import { AssistantFailure } from '../assistant.ts';
import { audit } from '../audit.ts';
import { AppError } from '../errors.ts';

const ROLE_LABELS: Record<string, string> = {
  SYSTEM_ADMIN: 'System Administrator',
  ASSET_MANAGER: 'Asset Management Team member',
  DEPARTMENT_STAFF: 'Department staff member',
};

const Body = z.strictObject({
  messages: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(20, 'This conversation is long. Start a new one to keep answers accurate.')
    .refine((m) => m.length > 0 && m[0].role === 'user' && m.at(-1)!.role === 'user', 'The conversation must start and end with your question.'),
});

const notConfigured = () =>
  new AppError(503, 'ASSISTANT_NOT_CONFIGURED', 'The help assistant is not set up on this server yet. An administrator must add an AI service key.');

export function assistantRoutes(app: FastifyInstance, { db, config, assistant }: AppDeps) {
  app.get('/assistant/status', async (req) => {
    requireUser(req);
    return { enabled: !!assistant };
  });

  app.post('/assistant/messages', { config: routeLimit(config, 20, 1) }, async (req) => {
    const user = requireUser(req);
    const body = parse(Body, req.body);
    if (!assistant) throw notConfigured();
    try {
      const r = await assistant.reply(body.messages, { roleLabel: ROLE_LABELS[user.role] ?? 'staff member' });
      await audit(db, {
        actorId: user.id,
        action: 'assistant.ask',
        entityType: 'assistant',
        entityId: assistant.model,
        // Usage for cost tracking. (Key names avoid the word "token": the audit log drops such keys as secrets.)
        context: { messages: body.messages.length, refused: r.refused, inputUnits: r.usage.inputTokens, outputUnits: r.usage.outputTokens, cachedUnits: r.usage.cachedTokens },
        ip: req.ip,
      });
      return { reply: r.text };
    } catch (e) {
      if (e instanceof AppError) throw e;
      req.log.error(e, 'assistant request failed');
      const kind = e instanceof AssistantFailure ? e.kind : 'failed';
      if (kind === 'auth') {
        throw new AppError(503, 'ASSISTANT_NOT_CONFIGURED', 'The help assistant is not working: its AI service key was refused. Please tell an administrator.');
      }
      if (kind === 'credit') {
        throw new AppError(503, 'ASSISTANT_NO_CREDIT', 'The help assistant is switched off: its AI account needs credit or billing set up. Please tell an administrator.');
      }
      if (kind === 'busy') {
        throw new AppError(429, 'ASSISTANT_BUSY', 'The help assistant is busy or has reached its free limit. Please try again in a minute.');
      }
      if (kind === 'network') {
        throw new AppError(502, 'ASSISTANT_UNREACHABLE', 'The help assistant could not be reached. Check the server’s internet connection and try again.');
      }
      throw new AppError(502, 'ASSISTANT_FAILED', 'The help assistant could not answer just now. Please try again.');
    }
  });
}
