/**
 * Per-dock Skills (docs/SERVER-BRAIN-SELFMOD.md §1a) — pi's own skill engine,
 * hosted against the raw `Agent` we already drive.
 *
 * pi gives us `loadSkills` (parse SKILL.md, validate frontmatter) and
 * `formatSkillInvocation` (the on-invoke prompt body) for free. Tenancy is the
 * FOLDER: each dock loads only `.data/brain/<dock>/skills/`, so isolation falls
 * out of the path — dock A can never see dock B's skills. We add the two bits
 * raw `Agent` lacks that `AgentHarness` would have done for us:
 *   1. a system-prompt BLOCK listing available skills (progressive disclosure —
 *      name + description only, so the base prompt stays terse), and
 *   2. an `invoke_skill(name)` TOOL the model calls to pull a skill's full body
 *      on demand (returned as the tool result → folded into the loop).
 *
 * "Install a skill" is therefore just: write a SKILL.md into the dock's folder
 * (REST/console below) — the dock's NEXT session picks it up.
 */

import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSkills, formatSkillInvocation, type AgentTool, type Skill } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

const env = new NodeExecutionEnv({ cwd: process.cwd() });

/** keep dock names filesystem-safe (mirrors store.ts). */
function sanitize(dock: string): string {
  return dock.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function dockSkillsDir(root: string, dock: string): string {
  return join(root, sanitize(dock), 'skills');
}

export interface DockSkills {
  /** loaded skills, model-visible (disableModelInvocation excluded from the list). */
  skills: Skill[];
  /** the system-prompt block (empty string when no skills). */
  promptBlock: string;
  /** the on-demand `invoke_skill` tool, or undefined when the dock has none. */
  tool?: AgentTool<any>;
}

/**
 * Load a dock's skills and build the prompt block + invoke tool. Called at
 * session open (and cheap to re-call). Missing folder → empty (no error):
 * a dock with no skills behaves exactly as today.
 */
export async function loadDockSkills(root: string, dock: string): Promise<DockSkills> {
  const dir = dockSkillsDir(root, dock);
  const { skills } = await loadSkills(env, dir);
  const listed = skills.filter((s) => !s.disableModelInvocation);
  if (skills.length === 0) return { skills, promptBlock: '' };

  const lines = listed.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  const promptBlock = listed.length > 0
    ? `You have SKILLS — extra step-by-step capabilities you can pull up when a task matches one. `
      + `Available skills:\n${lines}\n`
      + `When a request matches a skill, call invoke_skill with its name to load the full instructions, then follow them.`
    : '';

  const byName = new Map(skills.map((s) => [s.name, s]));
  const tool: AgentTool<any> = {
    name: 'invoke_skill',
    label: 'invoke_skill',
    description: 'Load the full instructions for one of your named skills. Call this when a request matches a skill listed in your prompt; the result is the skill\'s instructions to follow.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'the skill name to load' } },
      required: ['name'],
    } as never,
    async execute(_toolCallId: string, params: any) {
      const name = (params as { name?: string })?.name;
      const skill = name ? byName.get(name) : undefined;
      if (!skill) {
        return {
          content: [{ type: 'text', text: `No skill named "${name ?? ''}". Available: ${[...byName.keys()].join(', ') || '(none)'}.` }],
          isError: true, details: undefined,
        };
      }
      return { content: [{ type: 'text', text: formatSkillInvocation(skill) }], details: undefined };
    },
  };

  return { skills, promptBlock, tool };
}

// ── console / REST helpers (install + manage) ────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

/** List a dock's installed skills (name + description), for the console. */
export async function listDockSkills(root: string, dock: string): Promise<SkillInfo[]> {
  const dir = dockSkillsDir(root, dock);
  const { skills } = await loadSkills(env, dir);
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    sizeBytes: (() => { try { return statSync(s.filePath).size; } catch { return 0; } })(),
  }));
}

/**
 * Install (or overwrite) a skill: write `<name>/SKILL.md` into the dock's
 * folder. Validated by re-loading — an invalid SKILL.md throws so the caller
 * can surface pi's diagnostic. Returns the parsed name on success.
 */
export async function installDockSkill(root: string, dock: string, content: string): Promise<string> {
  // peek the frontmatter name so the folder is named correctly; fall back to a
  // temp name and let the post-write load validate.
  const nameMatch = content.match(/^\s*name:\s*([a-z0-9-]{1,64})\s*$/im);
  const slug = nameMatch?.[1] ?? `skill-${Date.now().toString(36)}`;
  const skillDir = join(dockSkillsDir(root, dock), slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);

  // validate: re-load just this dock and confirm the new skill parsed cleanly.
  // match by the folder we just wrote (filePath contains /<slug>/SKILL.md).
  const { skills, diagnostics } = await loadSkills(env, dockSkillsDir(root, dock));
  const installed = skills.find((s) => s.filePath.includes(`/${slug}/`));
  if (!installed) {
    // bad frontmatter — roll back so a broken pack never lingers.
    rmSync(skillDir, { recursive: true, force: true });
    const why = diagnostics.map((d) => d.message).join('; ') || 'invalid SKILL.md (name/description required)';
    throw new Error(why);
  }
  return installed.name;
}

/** Remove an installed skill by name. Returns true if something was removed. */
export async function removeDockSkill(root: string, dock: string, name: string): Promise<boolean> {
  const { skills } = await loadSkills(env, dockSkillsDir(root, dock));
  const skill = skills.find((s) => s.name === name);
  if (!skill) return false;
  // skill.filePath = .../skills/<dir>/SKILL.md → remove the skill's own dir.
  // pi reports filePath ABSOLUTE while our dir is cwd-relative; resolve BOTH so
  // the containment guard (never delete outside the dock's lane) is correct.
  const skillDir = resolve(skill.filePath, '..');
  const skillsRoot = resolve(dockSkillsDir(root, dock));
  if (skillDir === skillsRoot || !skillDir.startsWith(skillsRoot + '/')) return false;
  rmSync(skillDir, { recursive: true, force: true });
  return true;
}
