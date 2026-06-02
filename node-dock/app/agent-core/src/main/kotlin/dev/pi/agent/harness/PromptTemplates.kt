package dev.pi.agent.harness

/**
 * Kotlin port of the pure (filesystem-free) helpers from pi-agent-core
 * `src/harness/prompt-templates.ts`: command-arg parsing and placeholder
 * substitution. The disk-loading entry points (`loadPromptTemplates`) depend on
 * the Node `ExecutionEnv` capability interface and are out of scope for this
 * port.
 */

data class PromptTemplate(
    val name: String,
    val content: String,
    val description: String? = null,
)

/** Parse an argument string using simple shell-style single and double quotes. */
fun parseCommandArgs(argsString: String): List<String> {
    val args = mutableListOf<String>()
    var current = StringBuilder()
    var inQuote: Char? = null

    for (char in argsString) {
        when {
            inQuote != null -> if (char == inQuote) inQuote = null else current.append(char)
            char == '"' || char == '\'' -> inQuote = char
            char == ' ' || char == '\t' -> if (current.isNotEmpty()) {
                args.add(current.toString()); current = StringBuilder()
            }
            else -> current.append(char)
        }
    }
    if (current.isNotEmpty()) args.add(current.toString())
    return args
}

/** Substitute placeholders ($1, $@, $ARGUMENTS, ${'$'}{@:N}, ${'$'}{@:N:L}) with args. */
fun substituteArgs(content: String, args: List<String>): String {
    var result = content

    // $N positional
    result = Regex("\\$(\\d+)").replace(result) { m ->
        args.getOrNull(m.groupValues[1].toInt() - 1) ?: ""
    }
    // ${@:N} and ${@:N:L} slices
    result = Regex("\\$\\{@:(\\d+)(?::(\\d+))?\\}").replace(result) { m ->
        var start = m.groupValues[1].toInt() - 1
        if (start < 0) start = 0
        val lengthStr = m.groupValues[2]
        if (lengthStr.isNotEmpty()) {
            args.drop(start).take(lengthStr.toInt()).joinToString(" ")
        } else {
            args.drop(start).joinToString(" ")
        }
    }
    val allArgs = args.joinToString(" ")
    result = result.replace("\$ARGUMENTS", allArgs)
    result = result.replace("\$@", allArgs)
    return result
}

/** Format a prompt template invocation with positional arguments. */
fun formatPromptTemplateInvocation(template: PromptTemplate, args: List<String> = emptyList()): String =
    substituteArgs(template.content, args)
