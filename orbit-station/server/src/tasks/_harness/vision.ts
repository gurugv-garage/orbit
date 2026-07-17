/**
 * Vision SUGAR — thin convenience over the task's own LLM (this.agent / the same
 * env model + key). NOT a separate capability: it's a few lines that build a
 * one-shot Agent and ask about an image. Prefer `this.agent` / `this.ask(...)` on
 * the Task base for anything beyond a single image question; these exist only
 * because "judge this frame (yes/no, or describe it)" is the dead-common case and
 * parsing a TRUE/FALSE answer is an easy place to slip.
 *
 *   import { Task, runTask, isTrueInImage } from '../../_harness/index.js';
 *   const frame = await this.frame();
 *   if (frame && await isTrueInImage('exactly five fingers are held up', frame)) { … }
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Ask a vision model a question about a base64 JPEG (exactly what this.frame()
 *  returns); returns the text answer. Throws if no image. (pi is imported lazily
 *  so the harness index — loaded by EVERY task — never eagerly pulls it.) */
export async function askVision(question: string, imageBase64: string | undefined): Promise<string> {
  if (!imageBase64) throw new Error('askVision: no image (this.frame() returned undefined — is the dock streaming?)');
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { taskModel, taskApiKey, assistantText } = await import('./model.js');
  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are a precise visual question answerer. Answer ONLY about what is literally visible. Be concise.',
      model: taskModel(), thinkingLevel: 'off', tools: [], messages: [],
    },
    getApiKey: (provider: string) => taskApiKey(provider),
  } as never);
  await agent.prompt([{
    role: 'user',
    content: [{ type: 'text', text: question }, { type: 'image', data: imageBase64, mimeType: 'image/jpeg' }],
    timestamp: Date.now(),
  } as AgentMessage]);
  // this one-shot Agent bypasses getAgent()'s wrapped prompt — ship its usage
  // through the running Task so vision sugar spend also reaches the Cost tab.
  try { (await import('./task.js')).shipOneShotUsage(agent); } catch { /* obs must never break sugar */ }
  return assistantText(agent.state.messages) || '(no answer)';
}

/** Yes/no over askVision: phrase `statement` as something true/false about the
 *  image; returns true only if the model clearly affirms it. Use for edge-triggered
 *  watchers (notify ONCE on a real true, not on noise). */
export async function isTrueInImage(statement: string, imageBase64: string | undefined): Promise<boolean> {
  const answer = await askVision(
    `Looking ONLY at the image: is the following TRUE or FALSE — "${statement}"? Reply with exactly one word: TRUE or FALSE.`,
    imageBase64,
  );
  return /^\s*true\b/i.test(answer);
}
