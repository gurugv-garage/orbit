package dev.pi.agent.harness

/**
 * Kotlin port of pi-agent-core `src/harness/system-prompt.ts` and the Skill
 * type from `harness/types.ts`.
 */

data class Skill(
    val name: String,
    val description: String,
    val content: String,
    val filePath: String,
    val disableModelInvocation: Boolean = false,
)

private fun escapeXml(value: String): String = value
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;")

/** Render the model-visible skills block for the system prompt. */
fun formatSkillsForSystemPrompt(skills: List<Skill>): String {
    val visible = skills.filter { !it.disableModelInvocation }
    if (visible.isEmpty()) return ""

    val lines = mutableListOf(
        "The following skills provide specialized instructions for specific tasks.",
        "Read the full skill file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    )
    for (skill in visible) {
        lines.add("  <skill>")
        lines.add("    <name>${escapeXml(skill.name)}</name>")
        lines.add("    <description>${escapeXml(skill.description)}</description>")
        lines.add("    <location>${escapeXml(skill.filePath)}</location>")
        lines.add("  </skill>")
    }
    lines.add("</available_skills>")
    return lines.joinToString("\n")
}
