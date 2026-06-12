# Server brain — extension capabilities (pi-native)

How the dock brain is *extended* — using **only the extension surface pi.dev
documents** ([pi.dev/docs/latest](https://pi.dev/docs/latest)). This is the
companion to [SERVER-BRAIN-IMPL.md](SERVER-BRAIN-IMPL.md) (the conversational/
embodiment agent) and inherits its tenancy, grants, and lifecycle model.

**Scope rule for this doc: nothing new is invented here.** Every capability
below is a feature pi already ships; the design work is *exposing* pi's feature
behind orbit's policy/validation seams (the `brainGrants` doctrine), not adding
agent machinery. If pi doesn't document it, it isn't in this doc.

> **Status — a committed goal, not yet built.** Today the brain uses the pi SDK
> as a *constrained* conversational loop: a fixed toolset
> ([`modules/brain/tools.ts`](../orbit-station/server/src/modules/brain/tools.ts)),
> no skills, no extensions, no model self-selection, and the model reads
> human-set config but never writes it. This doc records which of pi's
> documented extension features the brain will expose, and the gate for each.

> **VERIFIED against the installed package (`@earendil-works/pi-agent-core@0.79.1`,
> 2026-06-12) — read this before building.** Two facts the pi.dev docs page hides
> that change *how* we expose these:
> 1. **We build on raw `Agent`, not `AgentHarness`.**
>    [`session.ts`](../orbit-station/server/src/modules/brain/session.ts) imports
>    `Agent` and drives it by mutating `agent.state.tools` / `agent.state.model`
>    / `agent.state.systemPrompt` directly. **All** of pi's runtime extension
>    methods — `setModel`, `setTools(tools, activeToolNames)`, `setActiveTools`,
>    `setThinkingLevel`, skills/prompt-templates via `AgentHarnessResources` —
>    live on **`AgentHarness`**, the higher-level host, *not* on bare `Agent`.
>    So adopting them is a **layer decision**: (a) migrate the brain from `Agent`
>    to `AgentHarness`, or (b) replicate the few bits we want against `Agent`
>    (we already do this for tools + model via `state.*`, so model-select and a
>    hand-rolled skill block are reachable without the harness).
> 2. **`registerTool` / `ExtensionAPI` is the pi *TUI's* shape — NOT a method in
>    this package.** The installed surface is `setTools` / `setActiveTools`
>    (on `AgentHarness`) or, as we do today, assigning `agent.state.tools`. Tool
>    naming in this doc means *that*, not `registerTool`.
>
> Net: the pi code is installed and importable (`loadSkills`, `AgentHarness`,
> `setModel` all re-exported from the package root), but **nothing is wired**,
> and Skills in particular need a system-prompt change (§1a) and a host (raw
> `Agent` has no automatic skills surface).

---

## 0. pi's documented extension surface (the menu)

From pi.dev/docs/latest, the extensibility features pi documents:

| pi feature | What pi says it is |
|---|---|
| **Extensions** | TypeScript modules that register tools/commands/shortcuts/flags/renderers/providers and subscribe to lifecycle events. *Run with full system permissions; execute arbitrary code.* (This is the **TUI `ExtensionAPI`** — see the verified banner: the installed package's runtime surface is `AgentHarness`/`state.*`, not `registerTool`.) |
| **Skills** | Self-contained `SKILL.md` capability packages the agent loads **on-demand** (progressive disclosure: name+description in the prompt, full body read when matched); invoked as `/skill:name`. |
| **Prompt Templates** | Reusable prompts that expand from slash commands. |
| **Custom Models** | Add model entries for supported provider APIs. |
| **Custom Providers** | Implement custom provider APIs / OAuth via `registerProvider`. |
| **Pi Packages** | Bundle & share extensions, skills, prompts, themes. |
| **Themes / Keybindings / TUI Components** | Terminal-UI customization. |
| **SDK / RPC / JSON-stream** | Embed pi, or drive it over stdin/stdout. |

**What the brain can use:** the brain *embeds the SDK* (it is not the pi TUI), so
the TUI-only features (**Themes, Keybindings, TUI Components**) don't apply, and
**Prompt Templates / Pi Packages / RPC** are pi-host conveniences the station
doesn't need. That leaves the three that are real extension points for an
embedded agent:

- **Skills** — on-demand capability packs. **✅ DONE (2026-06-12)** — per-dock,
  hosted on raw `Agent`, installable from the console (§4 TODO, `skills.ts`).
- **Extensions** — `registerTool` + `on(event)` (the brain already does the
  equivalent in-process; pi's extension API is the documented shape for more).
  *Not yet exposed for dock-/third-party-authored modules.*
- **Custom Models / Custom Providers** — model + provider self-config.
  *Not yet exposed (the human sets `brainModel`).*

Everything below is one of those three. Nothing else.

---

## 1. The three exposable capabilities (pi-native), each grant-gated

The `brainGrants` doctrine generalizes ([IMPL.md §2](SERVER-BRAIN-IMPL.md)):
**exposure is policy, not possibility.** A new config family `brainExtensions`
(json, default all-false per dock) gates each pi feature independently:

```
brainExtensions = { "<dock>": { skills?: bool, tools?: bool, models?: bool } }
```

A dock with no entry behaves byte-identically to today.

### 1a. Skills (pi **Skills** — on-demand `SKILL.md` packs)

- **pi mechanism, verbatim:** a skill is a directory with a `SKILL.md`
  (frontmatter `name` 1–64 `[a-z0-9-]`, `description` ≤1024 chars; optional
  `allowed-tools`, `disable-model-invocation`, `metadata`). pi scans skill
  locations at startup, puts name+description in the system prompt (progressive
  disclosure), and loads the full body on match. Invoked `/skill:name`.
- **How the brain exposes it:** `loadSkills(env, dirs)` over a per-dock root
  `.data/brain/<dock>/skills/` (tenant-scoped) plus an optional shared station
  pack dir. Gated by `brainExtensions.<dock>.skills`; ungated docks load no
  skills. Lowest-risk surface — skills are prose + `allowed-tools`, not
  arbitrary code.
- **⚠️ NEEDS A SYSTEM-PROMPT CHANGE (verified).** Skills *are* a prompt
  mechanism: progressive disclosure injects each skill's `name` + `description`
  into the **system prompt** (as XML), and the model reads the full `SKILL.md`
  on match. `AgentHarness` builds that block automatically; **raw `Agent` does
  not** — so on our current layer,
  [`prompt.ts`](../orbit-station/server/src/modules/brain/prompt.ts)
  `buildSystemPrompt` must gain a skills block (available skills + how to invoke)
  and `loadSkills` must be hosted by us. Because the dock prompt is deliberately
  terse and small-model-tuned (see `prompt.ts` header), this block must be
  re-tested on the live cheap model, not just added.
- **What it buys the dock:** new behaviors / domain workflows / personas added
  as a pack, no station code change — pi's intended use of Skills.

### 1b. Tools & lifecycle (pi **Extensions** — `registerTool` / `on(event)`)

- **pi mechanism — as installed (0.79.1), NOT the docs-site shape:** the
  pi.dev page describes a TUI `ExtensionAPI` with `pi.registerTool` /
  `pi.on(event)`; **that API is not in this package.** What the installed package
  actually gives us: a tool is `{ name, label, description, parameters (Typebox),
  execute(toolCallId, args) }` (exactly what `buildDockTools` already returns);
  the tool *set* is managed via `AgentHarness.setTools(tools, activeToolNames)` /
  `setActiveTools(names)` — or, on raw `Agent` as we do today, by assigning
  `agent.state.tools`. Lifecycle subscription is `agent.subscribe(...)` (the
  events the brain already consumes). **pi's warning still stands: extension
  modules run with full system permissions and execute arbitrary code.**
- **How the brain exposes it:** the brain *already* builds tools in-process
  (`buildDockTools`) and subscribes to events (`agent.subscribe`) — that is the
  embedded-SDK equivalent of an Extension, and it's first-party. The new
  capability is loading **dock-/third-party-authored** tool modules, gated by
  `brainExtensions.<dock>.tools` (and isolated — see SECURITY).
- **SECURITY (pi's own warning is the design constraint):** because pi extensions
  are arbitrary code with full permissions, a dock-loadable extension is **never
  loaded into the live station process** under a near-term plan. Same posture pi
  implies for untrusted extensions: trusted/first-party extensions only in
  process; anything dock- or third-party-authored runs isolated (separate
  process, no prod creds/sockets) with changes surfaced for promotion — not
  hot-loaded. The in-process tool authoring the brain does today stays
  first-party.

### 1c. Models & providers (pi **Custom Models** / **Custom Providers**)

- **pi mechanism — as installed (0.79.1):** `AgentHarness.setModel(model)` /
  `getModel()` / `setThinkingLevel(level)` at runtime. (Provider
  registration/OAuth is the pi-host's job; on raw `Agent` we set
  `agent.state.model` directly, which is what we already do each turn.) **Custom
  Models** = add model entries for supported provider APIs; **Custom Providers**
  = custom APIs/OAuth.
- **How the brain exposes it:** the brain already resolves + assigns a model per
  turn (`#resolveModel` → `agent.state.model`, supporting `provider/modelId` and
  `openai-compatible/<model>@<baseUrl>`) — that *is* the Custom Model surface,
  driven by the human-set `brainModel` config. Letting the **brain** switch model
  (call `setModel`, or assign `state.model`) is gated by
  `brainExtensions.<dock>.models`; provider/key registration stays human-only —
  `apiKeyFor` reads station env, and the model never sees or adds a key.

---

## 2. Design principles (unchanged from the grants model)

1. **Exposure is policy** — `brainExtensions` default-off per dock per feature;
   no grant = today's behavior, exactly.
2. **Tenant-scoped** — a dock's skills dir / model selection is its own; never
   another dock's, never global station state.
3. **Validate at the boundary** — a model-selected `brainModel` resolves through
   the existing `resolveModel`; an unknown model fails the same way a bad config
   value does. Skills validate via pi's own loader (frontmatter rules).
4. **Applied next-turn** — the skill/tool/model set is re-derived at turn start
   (`session.ts`), exactly like config today; a running turn never reconfigures
   itself.
5. **pi's permission warning is load-bearing** — Extensions are arbitrary code;
   dock-/third-party-authored ones are isolated, not hot-loaded (§1b).

---

## 3. Wiring summary (the seams already exist)

| pi feature | Brain seam today | Add for self-extension |
|---|---|---|
| Skills | — (none); raw `Agent` has **no** skills host | `loadSkills` in `#ensureSession`; per-dock `.data/brain/<dock>/skills/`; gate `brainExtensions.skills`; **+ `buildSystemPrompt` skills block** (progressive disclosure — raw `Agent` won't inject it for us) |
| Tools / events | `buildDockTools` + `agent.subscribe` (in-process Extension equivalent) | gate `brainExtensions.tools`; isolate any non-first-party extension (§1b) |
| Models / providers | `resolveModel` / `brainModel` config + `apiKeyFor` (Custom Model surface) | gate `brainExtensions.models` for brain-driven `setModel`; provider/keys stay human-only |

New config: `brainExtensions` (json, `tags: ['station']`, default `{}`), same
shape and place as `brainGrants` in
[`registry.ts`](../orbit-station/server/src/modules/config/registry.ts).

---

## 4. TODO

**Layer decision (RESOLVED — raw `Agent`):**
- [x] decided **raw `Agent`**, not `AgentHarness`. `AgentHarness` owns its own
      session/phase/queue/compaction and would force a rewrite of our tuned turn
      lifecycle (supersede, our `SessionStore`, abort handling). Instead we host
      pi's `loadSkills` + `formatSkillInvocation` ourselves against `Agent` —
      a few lines at the per-turn assembly. (`AgentHarness` stays an option if we
      ever want its prompt-templates/steering machinery.)

**Skills (pi Skills — DONE, landed 2026-06-12):**
- [x] `brainSkills` config gate (registry + read in `session.ts#loadSkills`,
      default on)
- [x] per-dock skills root `.data/brain/<dock>/skills/` (tenancy = the folder)
- [x] host `loadSkills` + `invoke_skill` tool in the embedded `Agent`
      (`skills.ts`), re-derived per turn so an install applies next-turn
- [x] **`buildSystemPrompt` skills block** (progressive disclosure: names+descs
      in the prompt, full body via `invoke_skill`)
- [x] console: per-dock skill list / install (paste `SKILL.md`) / remove
      (`web/src/modules/Skills.tsx` + `GET|POST|DELETE /api/brain/:dock/skills`)
- [x] tests: install/list/remove round-trip, lane guard, bad-frontmatter
      rejection, **skill rides the turn system prompt + tool offered**
      (`skills.test.ts`); verified live via REST against a running station
- [ ] re-test the terse small-model prompt on the live cheap model (needs a key)
- [ ] optional: shared station pack dir (currently per-dock only)

**Tools / Extensions (pi Extensions):**
- [ ] gate `brainExtensions.tools`; keep first-party in-process tools as-is
      (`buildDockTools` → `state.tools` / `setTools`, **not** `registerTool`)
- [ ] isolation harness for any dock-/third-party extension (pi's
      arbitrary-code warning → never hot-load into the live station)

**Models / Providers (pi Custom Models/Providers):**
- [ ] gate `brainExtensions.models` for brain-driven `setModel`/`state.model`
- [ ] provider registration + keys stay human-only (no model-facing path)

**Cross-cutting:**
- [ ] tenancy isolation: one dock's skills/model selection never touches another
- [ ] reconcile this doc with IMPL.md as features land

---

## 5. Decision log

- **Expose only pi's documented extension features** — Skills, tools
  (`setTools`/`state.tools`), Custom Models/Providers (`setModel`/`state.model`).
  Nothing orbit-invented; the brain embeds the pi SDK, so this is *using* pi's
  surface, not building new agent machinery. *(2026-06-12)*
- **Verified against `pi-agent-core@0.79.1`:** the pi.dev `registerTool` /
  `ExtensionAPI` is the **TUI's** API, not this package's — the installed runtime
  surface is `AgentHarness` (`setModel`/`setTools`/skills host) or raw `Agent`
  `state.*`. The brain uses raw `Agent`, so adopting these is a layer decision
  (migrate to `AgentHarness`, or replicate against `Agent`). *(2026-06-12)*
- **Skills require a system-prompt change** — progressive disclosure injects
  skill name+description into the system prompt; `AgentHarness` does this
  automatically, raw `Agent` does not, so on our layer `buildSystemPrompt` grows
  a skills block (and the terse small-model prompt must be re-tested).
  *(2026-06-12)*
- **TUI-only and pi-host features are out of scope** — Themes, Keybindings, TUI
  Components, Prompt Templates, Pi Packages, RPC don't apply to an embedded SDK
  agent driven over the station WS. *(2026-06-12)*
- **`brainGrants` doctrine generalizes to extensions** — one `brainExtensions`
  gate family, default-off per dock per feature; ungated = today's behavior.
  *(2026-06-12)*
- **pi's "extensions run arbitrary code with full permissions" warning sets the
  Extensions guardrail** — first-party tools in-process (as today); any
  dock-/third-party-authored extension runs isolated, never hot-loaded into the
  live station. *(2026-06-12)*
- **Provider keys/registration stay human-only** — the model may *select* among
  configured models (pi `setModel`, gated) but never adds a provider, key, or
  base URL; `apiKeyFor` reads station env. *(2026-06-12)*
