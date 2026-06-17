/**
 * whatsapp:check — exercise the LIVE WhatsApp Cloud API setup end-to-end (token
 * valid, phone number reachable, a real message delivered) against your real
 * number, printing a numbered pass/fail line per check. Unlike whatsapp.test.ts
 * (which mocks fetch), this hits Meta's Graph API for real to prove the token +
 * phone-number-id + recipient allow-list are right.
 *
 *   # set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (+ WHATSAPP_DEFAULT_TO) in .env
 *   npm run whatsapp:check                  # sends to WHATSAPP_DEFAULT_TO
 *   npm run whatsapp:check -- +15551234567  # or pass a recipient (E.164)
 *
 * No station needed. The send goes to a real phone, so expect a WhatsApp on it.
 */
import { readFileSync } from 'node:fs';
import { sendMessage, whatsappToken, whatsappPhoneNumberId, whatsappDefaultTo } from '../integrations/whatsapp.js';

// Load orbit-station/.env the same way the station does (real env wins).
loadDotEnv(new URL('../../../.env', import.meta.url).pathname);

const GRAPH = 'https://graph.facebook.com/v21.0';
const to = process.argv[2] ?? whatsappDefaultTo();

let n = 0, passed = 0, failed = 0;
const results: string[] = [];

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  n++;
  try {
    const r = await fn();
    passed++;
    results.push(`  ${n}. ok    ${name}${r ? ` — ${r}` : ''}`);
  } catch (err) {
    failed++;
    results.push(`  ${n}. FAIL  ${name} — ${String(err instanceof Error ? err.message : err)}`);
  }
}

async function main(): Promise<void> {
  console.log('\nwhatsapp:check — live WhatsApp Cloud API setup\n');
  if (!whatsappToken() || !whatsappPhoneNumberId()) {
    console.error('  WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set (orbit-station/.env). Nothing to test.');
    process.exit(1);
  }
  if (!to) {
    console.error('  No recipient: pass one (npm run whatsapp:check -- +15551234567) or set WHATSAPP_DEFAULT_TO.');
    process.exit(1);
  }
  console.log(`  token: ${whatsappToken()!.slice(0, 12)}…   phone_number_id: ${whatsappPhoneNumberId()}   to: ${to}\n`);

  // 1) token valid + scopes (debug_token) — proves the token works and is WhatsApp-scoped.
  await check('debug_token (token valid)', async () => {
    const t = whatsappToken()!;
    const res = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(t)}&access_token=${encodeURIComponent(t)}`);
    const d = (await res.json()) as any;
    if (!d.data?.is_valid) throw new Error(`token invalid: ${d.data?.error?.message ?? 'unknown'}`);
    const scopes = (d.data.scopes ?? []).join(',');
    const perm = d.data.expires_at === 0 ? 'never-expires' : `expires ${new Date(d.data.expires_at * 1000).toISOString()}`;
    if (!scopes.includes('whatsapp_business_messaging')) throw new Error(`missing whatsapp_business_messaging scope (have: ${scopes})`);
    return `${d.data.type} on app "${d.data.application}", ${perm}`;
  });

  // 2) phone number reachable (read the sending number's display info).
  await check('phone number readable', async () => {
    const res = await fetch(`${GRAPH}/${whatsappPhoneNumberId()}?fields=display_phone_number,verified_name,quality_rating`, {
      headers: { authorization: `Bearer ${whatsappToken()}` },
    });
    const d = (await res.json()) as any;
    if (d.error) throw new Error(d.error.message);
    return `${d.display_phone_number ?? '(no number)'}${d.verified_name ? ` "${d.verified_name}"` : ''}`;
  });

  // 3) send a real text message (the actual brain path).
  await check('sendMessage (text delivered)', async () => {
    const r = await sendMessage({ to: to!, text: `orbit whatsapp:check ✅ ${new Date().toISOString()}` });
    if (!r.messageId) throw new Error('no message id returned');
    return `wamid=${r.messageId.slice(0, 24)}…`;
  });

  console.log(results.join('\n'));
  console.log(`\n  ${n} checks — ${passed} ok, ${failed} fail\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Minimal .env loader (mirrors main.ts) so this runs without the station. */
function loadDotEnv(path: string): void {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]!] == null) process.env[m[1]!] = m[2]!;
    }
  } catch { /* no .env — rely on the real environment */ }
}

main().catch((err) => { console.error('whatsapp:check crashed', err); process.exit(1); });
