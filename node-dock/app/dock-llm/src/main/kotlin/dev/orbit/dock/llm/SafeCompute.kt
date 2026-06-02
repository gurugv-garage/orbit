package dev.orbit.dock.llm

import kotlin.random.Random

/**
 * A SAFE evaluator for the [DockToolSchemas.compute] tool — the dock's bounded
 * stand-in for "run code". Handles exactly what a model needs to "pick a number
 * and branch": numbers, `+ - * / %`, parentheses, comparisons (`> < >= <= == !=`),
 * and `random(a,b)` (inclusive int). NOT a general interpreter — no variables,
 * calls, names, or statements; anything else is rejected. Pure + deterministic
 * given the [rng], so it's unit-testable.
 *
 * Returns a short result string the model reads back: a number, "true"/"false",
 * or "error: …". The model then speaks/acts on it (e.g. branch to "Hi"/"Bye").
 */
class SafeCompute(private val rng: Random = Random.Default) {

    fun eval(expression: String): String =
        runCatching {
            val p = Parser(expression, rng)
            val v = p.parseExpr()
            p.expectEnd()
            formatResult(v)
        }.getOrElse { "error: ${it.message ?: "bad expression"}" }

    private fun formatResult(v: Double): String = when {
        v == 1.0 && wasBool -> "true"
        v == 0.0 && wasBool -> "false"
        v % 1.0 == 0.0 -> v.toLong().toString()
        else -> v.toString()
    }

    // set by the parser when the top-level result came from a comparison
    private var wasBool = false

    /**
     * Recursive-descent parser/evaluator. Grammar (lowest→highest precedence):
     *   expr   := compare
     *   compare:= sum ( (> < >= <= == !=) sum )?
     *   sum    := term ( (+|-) term )*
     *   term   := unary ( (*|/|%) unary )*
     *   unary  := (-)? atom
     *   atom   := number | '(' expr ')' | 'random' '(' expr ',' expr ')'
     */
    private inner class Parser(val s: String, val rng: Random) {
        var i = 0

        fun parseExpr(): Double = parseCompare()

        private fun parseCompare(): Double {
            val left = parseSum()
            ws()
            for (op in listOf(">=", "<=", "==", "!=", ">", "<")) {
                if (s.startsWith(op, i)) {
                    i += op.length
                    val right = parseSum()
                    wasBool = true
                    val r = when (op) {
                        ">" -> left > right; "<" -> left < right
                        ">=" -> left >= right; "<=" -> left <= right
                        "==" -> left == right; "!=" -> left != right
                        else -> error("op")
                    }
                    return if (r) 1.0 else 0.0
                }
            }
            return left
        }

        private fun parseSum(): Double {
            var v = parseTerm()
            while (true) {
                ws(); val c = peek() ?: break
                if (c == '+') { i++; v += parseTerm() }
                else if (c == '-') { i++; v -= parseTerm() }
                else break
            }
            return v
        }

        private fun parseTerm(): Double {
            var v = parseUnary()
            while (true) {
                ws(); val c = peek() ?: break
                if (c == '*') { i++; v *= parseUnary() }
                else if (c == '/') { i++; v /= parseUnary() }
                else if (c == '%') { i++; v %= parseUnary() }
                else break
            }
            return v
        }

        private fun parseUnary(): Double {
            ws()
            if (peek() == '-') { i++; return -parseAtom() }
            return parseAtom()
        }

        private fun parseAtom(): Double {
            ws()
            val c = peek() ?: error("unexpected end")
            if (c == '(') { i++; val v = parseExpr(); ws(); expect(')'); return v }
            if (s.startsWith("random", i)) {
                i += "random".length; ws(); expect('(')
                val lo = parseExpr(); ws(); expect(',')
                val hi = parseExpr(); ws(); expect(')')
                val a = lo.toInt(); val b = hi.toInt()
                if (b < a) error("random(a,b) needs a<=b")
                return rng.nextInt(a, b + 1).toDouble()    // inclusive
            }
            // number
            val start = i
            while (peek()?.let { it.isDigit() || it == '.' } == true) i++
            if (i == start) error("expected a number at \"${s.substring(i.coerceAtMost(s.length))}\"")
            return s.substring(start, i).toDouble()
        }

        fun expectEnd() { ws(); if (i < s.length) error("unexpected \"${s.substring(i)}\"") }
        private fun expect(ch: Char) { ws(); if (peek() != ch) error("expected '$ch'"); i++ }
        private fun peek(): Char? = s.getOrNull(i)
        private fun ws() { while (peek()?.isWhitespace() == true) i++ }
    }
}
