/**
 * The task's own LLM access — model + key resolution from the process env (a task
 * runs in the station's environment, so the provider key is in process.env and the
 * dock's model is in BRAIN_MODEL). Used to build `this.agent` (see task.ts). This
 * is the ONLY model wiring; everything else (vision, classification, multi-step)
 * is the task author's own code over the Agent.
 */
import { getModel } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** The task's model from env (BRAIN_MODEL, the dock's model; default gemini flash). */
export function taskModel(): Model<any> {
  const spec = process.env.BRAIN_MODEL || 'google/gemini-2.5-flash';
  const slash = spec.indexOf('/');
  const provider = slash > 0 ? spec.slice(0, slash) : 'google';
  const rest = slash > 0 ? spec.slice(slash + 1) : spec;
  return getModel(provider as never, rest as never) as Model<any>;
}

/** The provider API key from env (same names the station reads from .env). */
export function taskApiKey(provider: string): string | undefined {
  const env = process.env;
  switch (provider) {
    case 'google': return env.GEMINI_API_KEY_PAID_ACC || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    case 'anthropic': return env.ANTHROPIC_API_KEY;
    case 'openai': return env.OPENAI_API_KEY;
    case 'openrouter': return env.OPENROUTER_API_KEY;
    default: return env.GEMINI_API_KEY;
  }
}

/** Extract the assistant's text from an Agent's last message (the common "what did
 *  it say" read — pi keeps it in state.messages, which is fiddly to dig out). */
export function assistantText(messages: AgentMessage[]): string {
  const last = messages.at(-1) as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  return (last?.role === 'assistant' && Array.isArray(last.content) ? last.content : [])
    .filter((c) => c.type === 'text').map((c) => c.text ?? '').join(' ').trim();
}
