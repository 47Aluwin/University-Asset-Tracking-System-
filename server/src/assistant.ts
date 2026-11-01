// Help assistant: answers "how do I…?" questions about using this app, grounded in the user guide.
// It is help-only by design: it receives no asset, user or audit data and cannot change anything.
import Anthropic from '@anthropic-ai/sdk';
import { ApiError as GeminiApiError, GoogleGenAI } from '@google/genai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from './config.ts';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type AssistantReply = { text: string; refused: boolean; usage: { inputTokens: number; outputTokens: number; cachedTokens: number } };

/** What the API route needs. Tests pass a fake; production uses Claude. */
export type Assistant = {
  model: string;
  reply(turns: ChatTurn[], ctx: { roleLabel: string }): Promise<AssistantReply>;
};

/**
 * Why the AI service could not answer, the same for every provider, so the API can show one plain message:
 * key refused, no credit left, too many requests (incl. free-tier limits), unreachable, or anything else.
 */
export class AssistantFailure extends Error {
  readonly kind: 'auth' | 'credit' | 'busy' | 'network' | 'failed';
  constructor(kind: AssistantFailure['kind'], cause?: unknown) {
    super(`assistant ${kind}`, { cause });
    this.kind = kind;
  }
}

const REFUSED = "Sorry, I can't help with that question. I can explain how to use the asset tracking app.";
const EMPTY = "Sorry, I don't have an answer for that. Try asking in a different way.";
const roleLine = (roleLabel: string) => `The person asking is signed in as: ${roleLabel}.`;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The user guide is the assistant's source of truth. Loaded once at start-up. */
function loadGuide(): string {
  for (const p of [path.resolve(here, '../../docs/user-guide.md'), path.resolve(here, '../docs/user-guide.md')]) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      // try the next location
    }
  }
  return '(The user guide could not be loaded. Answer only general questions about the app and suggest asking a System Administrator.)';
}

// Frozen system prompt (kept byte-identical between requests so it can be cached). Per-user details go after it.
export function systemPrompt(guide: string) {
  return `You are the help assistant inside the University Asset Tracking System of the Papua New Guinea University of Technology (PNG Unitech). Staff use the app on phones and on the web to register university assets, print and attach QR labels, verify assets, record condition and maintenance, and produce reports. Assets are classified by faculty and by school / department; units outside the faculties, such as the University Library and the Student Support & Facility Centre, are "Central administration".

Your job is to explain how to use the app: where to find things, what each step means, and why the app behaves as it does. Base your answers on the user guide below. If the guide does not cover something, say you are not sure and suggest asking a System Administrator, rather than guessing or inventing screens, buttons or features.

You cannot see any asset, user, audit or report data, and you cannot do anything in the app. If someone asks about specific records (for example "which laptops are overdue?" or "what is the value of Civil Engineering's assets?"), explain which screen and filters will show it to them. Never claim to have looked anything up or changed anything.

What a person can do depends on their role and department; the person's role is given after this guide. Tell them when a task needs another role (for example, only System Administrators approve access requests or archive registered assets).

Never ask for or repeat passwords, setup links or reset links. For account problems (locked out, forgot password), explain the self-service steps in the guide, or to contact a System Administrator.

Write short, plain answers for busy staff, many of whom use English as a second language: a sentence or two, or a few numbered steps. Use the app's own button and screen names in quotes. Use no tables and little formatting, since answers are shown on a small phone screen. Reply in the language the person writes in.

<user_guide>
${guide}
</user_guide>`;
}

/**
 * Server-side refusal fallback (retry a declined question on another model in the same call) exists only for some
 * models. Claude Haiku 5.5 has none - sending the parameter would be ignored or rejected - so it is added only here.
 */
export const supportsFallback = (model: string) => /^claude-(opus-5|opus-5-5|fable-5-1|sonnet-5-5)$/.test(model);

/** The AI service named in ASSISTANT_PROVIDER, or null (assistant off) when its key is not set. */
export function createAssistant(config: Config): Assistant | null {
  return config.assistant.provider === 'gemini' ? createGeminiAssistant(config) : createClaudeAssistant(config);
}

export function createClaudeAssistant(config: Config): Assistant | null {
  if (!config.assistant.claudeKey) return null;
  const client = new Anthropic({ apiKey: config.assistant.claudeKey, timeout: 60_000, maxRetries: 2 });
  const model = config.assistant.claudeModel;
  const system = systemPrompt(loadGuide());
  return {
    model,
    async reply(turns, ctx) {
      const response = await claudeCall(() => client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Everyday help questions do not need deep reasoning; low effort keeps answers quick and cheap.
        output_config: { effort: 'low' },
        // Where supported: if a safety check declines a question, retry it on another suitable model in the same call.
        ...(supportsFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        system: [
          { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: roleLine(ctx.roleLabel) },
        ],
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
      }));
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedTokens: response.usage.cache_read_input_tokens ?? 0,
      };
      if (response.stop_reason === 'refusal') return { text: REFUSED, refused: true, usage };
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text: text || EMPTY, refused: false, usage };
    },
  };
}

async function claudeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AssistantFailure('auth', e);
    // An empty prepaid balance is a 400 with no dedicated error type, so the message is the only signal.
    if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) throw new AssistantFailure('credit', e);
    if (e instanceof Anthropic.RateLimitError) throw new AssistantFailure('busy', e);
    if (e instanceof Anthropic.APIConnectionError) throw new AssistantFailure('network', e);
    throw new AssistantFailure('failed', e);
  }
}

/** Google Gemini (free tier available). Same instructions and limits as Claude; only the transport differs. */
export function createGeminiAssistant(config: Config): Assistant | null {
  if (!config.assistant.geminiKey) return null;
  const ai = new GoogleGenAI({ apiKey: config.assistant.geminiKey });
  const model = config.assistant.geminiModel;
  const system = systemPrompt(loadGuide());
  return {
    model,
    async reply(turns, ctx) {
      let response;
      try {
        response = await ai.models.generateContent({
          model,
          // Gemini calls the assistant's side of the conversation "model".
          contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
          config: { systemInstruction: `${system}\n\n${roleLine(ctx.roleLabel)}`, maxOutputTokens: 4096 },
        });
      } catch (e) {
        if (e instanceof GeminiApiError) {
          // 403 "free tier is not available for this project": the Google project needs billing (no free quota).
          if (e.status === 403 && /free tier|billing/i.test(e.message)) throw new AssistantFailure('credit', e);
          // 400 "API key not valid" / 401 / 403: the key was refused. 429: rate or free-tier quota reached.
          if (e.status === 401 || e.status === 403 || (e.status === 400 && /api key/i.test(e.message))) throw new AssistantFailure('auth', e);
          if (e.status === 429) throw new AssistantFailure('busy', e);
          throw new AssistantFailure('failed', e);
        }
        throw new AssistantFailure('network', e); // fetch failed: no connection to Google
      }
      const u = response.usageMetadata;
      const usage = { inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0, cachedTokens: u?.cachedContentTokenCount ?? 0 };
      const finish = String(response.candidates?.[0]?.finishReason ?? '');
      if (response.promptFeedback?.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(finish)) return { text: REFUSED, refused: true, usage };
      return { text: (response.text ?? '').trim() || EMPTY, refused: false, usage };
    },
  };
}
