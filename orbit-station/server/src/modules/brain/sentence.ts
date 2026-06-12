/**
 * Emits speakable sentences from streaming assistant prose **as it arrives**,
 * so the dock starts talking before the whole reply has generated (the main
 * perceived-latency win on multi-second turns).
 *
 * TS port of the dock's `StreamingReplyExtractor.kt` — its unit-test vectors
 * are ported verbatim in sentence.test.ts; they are the spec. The brain feeds
 * the cumulative assistant text on each stream delta; `push` returns any
 * newly-completed sentences (in order), and `flush` yields the trailing
 * clause at end-of-stream (the last sentence often lacks terminal
 * punctuation). `flush` must only be called on NORMAL completion — a
 * cancelled/timed-out turn must not leak its half-sentence into TTS.
 */
export class SentenceStreamer {
  #emittedChars = 0;  // how much of the cumulative text we've already spoken
  #lastText = '';     // last cumulative text seen (for flush)
  #flushed = false;   // flush() ran → no more output

  /**
   * Feed the cumulative prose seen so far; returns sentences completed since
   * the last call (terminal punctuation followed by whitespace). Empty until
   * the first sentence boundary is reached.
   */
  push(textSoFar: string): string[] {
    if (this.#flushed) return [];
    this.#lastText = textSoFar;
    const unseen = textSoFar.substring(Math.min(this.#emittedChars, textSoFar.length));
    const out: string[] = [];
    let consumed = 0;
    for (const boundary of sentenceBoundaries(unseen)) {
      const sentence = unseen.substring(consumed, boundary).trim();
      if (sentence.length > 0) out.push(sentence);
      consumed = boundary;
    }
    this.#emittedChars += consumed;
    return out;
  }

  /** Full cumulative text so far (for the live subtitle), or null if empty. */
  liveText(textSoFar: string): string | null {
    return textSoFar.length > 0 ? textSoFar : null;
  }

  /**
   * End of stream: return the trailing clause not yet emitted (the final
   * sentence usually has no terminal punctuation). Idempotent.
   */
  flush(): string | null {
    if (this.#flushed) return null;
    this.#flushed = true;
    const tail = this.#lastText.substring(Math.min(this.#emittedChars, this.#lastText.length)).trim();
    return tail.length > 0 ? tail : null;
  }
}

const TERMINAL = new Set(['.', '!', '?', '…']);

/**
 * End offsets (exclusive) of complete sentences in `text`. A boundary is a
 * run of terminal punctuation (. ! ? …) followed by whitespace — the
 * trailing-whitespace requirement avoids splitting an abbreviation or a
 * mid-stream token that just happens to end the buffer.
 */
function sentenceBoundaries(text: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (TERMINAL.has(text[i]!)) {
      let j = i;
      while (j < text.length && TERMINAL.has(text[j]!)) j++;
      if (j < text.length && /\s/.test(text[j]!)) {
        out.push(j);
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}
