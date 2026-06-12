/**
 * A SAFE evaluator for the `compute` tool — the dock's bounded stand-in for
 * "run code". Handles exactly what a model needs to "pick a number and
 * branch": numbers, `+ - * / %`, parentheses, comparisons
 * (`> < >= <= == !=`), and `random(a,b)` (inclusive int). NOT a general
 * interpreter — no variables, calls, names, or statements; anything else is
 * rejected. Pure + deterministic given the `rng`, so it's unit-testable.
 *
 * TS port of the dock's `SafeCompute.kt` (test vectors ported in
 * safe-compute.test.ts). Returns a short result string the model reads back:
 * a number, "true"/"false", or "error: …".
 */
export class SafeCompute {
  #rng: () => number;

  /** @param rng uniform [0,1) source — injectable for deterministic tests. */
  constructor(rng: () => number = Math.random) {
    this.#rng = rng;
  }

  eval(expression: string): string {
    try {
      const p = new Parser(expression, this.#rng);
      const v = p.parseExpr();
      p.expectEnd();
      return formatResult(v, p.wasBool);
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : 'bad expression'}`;
    }
  }
}

function formatResult(v: number, wasBool: boolean): string {
  if (wasBool) return v === 1 ? 'true' : 'false';
  if (v % 1 === 0) return String(Math.trunc(v));
  return String(v);
}

/**
 * Recursive-descent parser/evaluator. Grammar (lowest→highest precedence):
 *   expr   := compare
 *   compare:= sum ( (> < >= <= == !=) sum )?
 *   sum    := term ( (+|-) term )*
 *   term   := unary ( (*|/|%) unary )*
 *   unary  := (-)? atom
 *   atom   := number | '(' expr ')' | 'random' '(' expr ',' expr ')'
 */
class Parser {
  i = 0;
  /** set when the top-level result came from a comparison. */
  wasBool = false;

  constructor(private readonly s: string, private readonly rng: () => number) {}

  parseExpr(): number {
    return this.#parseCompare();
  }

  #parseCompare(): number {
    const left = this.#parseSum();
    this.#ws();
    for (const op of ['>=', '<=', '==', '!=', '>', '<'] as const) {
      if (this.s.startsWith(op, this.i)) {
        this.i += op.length;
        const right = this.#parseSum();
        this.wasBool = true;
        const r =
          op === '>' ? left > right
          : op === '<' ? left < right
          : op === '>=' ? left >= right
          : op === '<=' ? left <= right
          : op === '==' ? left === right
          : left !== right;
        return r ? 1 : 0;
      }
    }
    return left;
  }

  #parseSum(): number {
    let v = this.#parseTerm();
    for (;;) {
      this.#ws();
      const c = this.#peek();
      if (c === '+') { this.i++; v += this.#parseTerm(); }
      else if (c === '-') { this.i++; v -= this.#parseTerm(); }
      else break;
    }
    return v;
  }

  #parseTerm(): number {
    let v = this.#parseUnary();
    for (;;) {
      this.#ws();
      const c = this.#peek();
      if (c === '*') { this.i++; v *= this.#parseUnary(); }
      else if (c === '/') { this.i++; v /= this.#parseUnary(); }
      else if (c === '%') { this.i++; v %= this.#parseUnary(); }
      else break;
    }
    return v;
  }

  #parseUnary(): number {
    this.#ws();
    if (this.#peek() === '-') { this.i++; return -this.#parseAtom(); }
    return this.#parseAtom();
  }

  #parseAtom(): number {
    this.#ws();
    const c = this.#peek();
    if (c == null) throw new Error('unexpected end');
    if (c === '(') {
      this.i++;
      const v = this.parseExpr();
      this.#ws();
      this.#expect(')');
      return v;
    }
    if (this.s.startsWith('random', this.i)) {
      this.i += 'random'.length;
      this.#ws(); this.#expect('(');
      const lo = this.parseExpr();
      this.#ws(); this.#expect(',');
      const hi = this.parseExpr();
      this.#ws(); this.#expect(')');
      const a = Math.trunc(lo);
      const b = Math.trunc(hi);
      if (b < a) throw new Error('random(a,b) needs a<=b');
      return a + Math.floor(this.rng() * (b - a + 1)); // inclusive
    }
    // number
    const start = this.i;
    while (/[0-9.]/.test(this.#peek() ?? '')) this.i++;
    if (this.i === start) {
      throw new Error(`expected a number at "${this.s.substring(Math.min(this.i, this.s.length))}"`);
    }
    const num = Number(this.s.substring(start, this.i));
    if (Number.isNaN(num)) throw new Error('bad number');
    return num;
  }

  expectEnd(): void {
    this.#ws();
    if (this.i < this.s.length) throw new Error(`unexpected "${this.s.substring(this.i)}"`);
  }

  #expect(ch: string): void {
    this.#ws();
    if (this.#peek() !== ch) throw new Error(`expected '${ch}'`);
    this.i++;
  }

  #peek(): string | undefined {
    return this.s[this.i];
  }

  #ws(): void {
    while (/\s/.test(this.#peek() ?? '')) this.i++;
  }
}
