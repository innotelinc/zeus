# The unified voice console — information architecture

Design note for bringing the voice estate under **one** console. It is written
before the code moves, because the decisions below are the ones that are
expensive to reverse: which app is the shell, which surfaces are rebuilt and
which are embedded, and which layer owns each fact.

The estate today is five products with five UIs and no shared navigation:

| Product | UI | Stack | What it is for |
| --- | --- | --- | --- |
| Asterisk | none | C | the thing that actually answers calls |
| FreePBX | Module Admin / its own GUI | PHP | administration of Asterisk |
| AvantFax | its own GUI (legacy) | PHP | fax |
| Dograh | `dograh-ui` | React | voice agents, interview flows, workflows |
| Capstone dashboard | `dashboard` + `dashboard-backend` | Next.js + FastAPI | estate-wide administration |
| Zeus portal | `app.zeus.innotel.us` | Next.js | the customer's own phone system |

An operator doing one job — "why did this DID not answer" — has to know which
of those five holds the answer, and today the answer is *all of them*.

## 1. The shape

**The Zeus portal is the shell.** One app owns the frame — session, nav,
design system, and the customer's own screens — and every other surface is a
**module** inside it. Modules come in two kinds, and the distinction is the
whole design:

- **Owned module** — screens this repo builds and this repo can change. Voice
  (Dograh agents and workflows), Numbers, Softphone, Fax, Voicemail, Contacts,
  Messages, Billing, Health.
- **Proxied module** — an app that stays its own deployment because rewriting
  it would be years of work for no operator benefit: FreePBX and AvantFax.
  They are reached through the edge under the portal's zone, SSO'd by the same
  gateway, and **linked and framed, never re-implemented**.

A proxied module is a deliberate debt, so it is named as one: the portal links
to FreePBX for what FreePBX owns (trunks, routes, Module Admin), and does not
pretend to own it by drawing a screen that writes to it.

**The Capstone dashboard is merged into the portal,** not proxied. It is the
one admin surface whose job overlaps the portal's directly — agents,
workflows, runs, call transcripts — and keeping both means every agent fact
has two owners. Its screens become owned modules; `dashboard-backend`'s
endpoints either move behind portal routes or are called by them server-side.

## 2. Navigation

One left rail, grouped by the question an operator is asking, not by the
product that answers it. This is the fix for "which of the five holds this".

| Group | Items | Answers |
| --- | --- | --- |
| **Today** | Overview, Live calls, Activity | what is happening right now |
| **Calls** | Numbers, Routing, Agents, Workflows, Hand-offs, Recordings | how a call is handled |
| **Inbox** | Voicemail, Fax, Messages | what arrived and needs a person |
| **Account** | Plan, Billing, Numbers, Contacts, Settings | what the customer owns |
| **Estate** | PBX, Health, Trunks, Extensions, Admin | how the machine is doing |
| **Admin** (staff) | Tenants, Plans, Resellers, Modules | who has what |

Three rules hold the map together:

1. **Runs answer "what happened"; the plan answers "what should happen".**
   Routing shows the plan (per-DID → agent); Agents and Workflows show the
   things that plan points at; Live calls and Recordings show what actually
   occurred. A page never mixes the two.
2. **Every fact has one author.** The portal authors routing. FreePBX's own
   screens are read-only pointers for it. The voiceplane module was created
   because of this rule and is removed for the same reason — see §5.
3. **A proxied surface is labelled.** Anything that leaves the shell says so,
   so an operator is never confused about which product they are looking at.

## 3. Ownership of facts

| Fact | Authored in | Read by |
| --- | --- | --- |
| Which number belongs to which account | portal | portal, PBX route writer |
| Which agent/workflow a DID reaches | portal | dialplan (`ZEUS_CAPSTONE_TARGET`), Dograh |
| The agent's prompt, tools, voice | Dograh workflow | portal (read), dialplan (by exten) |
| Trunks, outbound routes, Module Admin | FreePBX | portal (read) |
| Call envelope (`AI_CALL_ID`, `AI_CONTEXT_TOKEN`) | dialplan at ingress | Dograh, portal context read |
| Call record, transcript, disposition | Dograh | portal |
| Fax in/out | AvantFax | portal (webhook + read) |

The AVA shape of this table is gone. There is no third voice engine: the
dialplan hands a call to **one** engine, Dograh, and the portal reads that
engine's records. `lib/ava.ts`, `lib/ava-voice-settings.ts` and the
`avaConfigured()` gate are deleted with it.

## 4. Design system

One implementation, no per-module drift:

- **Tokens** as CSS custom properties on `:root` (colour, radius, spacing,
  elevation), consumed by Tailwind, so a module cannot invent a palette.
- **A small primitive set** — `Card`, `Table`, `Field`, `Badge`, `EmptyState`,
  `Toolbar`, `Stat` — that every module composes. A module that needs a new
  primitive adds it to the set rather than to itself.
- **One state vocabulary**, used identically everywhere: `loading` (skeleton),
  `empty` (what to do next, not just "no data"), `refused` (why, and who can
  fix it), `stale` (when it was last true), `error`.
  The `refused` case matters most: the current code has a good instinct here
  (`AddonGate`'s `mode`) and the unified console generalises it, so a
  deployment-config problem never renders as a billing problem.

## 5. What gets deleted

- **The `voiceplane` FreePBX module** (`pbx/freepbx-modules/voiceplane/`,
  `pbx/install-freepbx-voiceplane.py`). It existed to put a voice-plane entry
  in FreePBX's admin menu. With one console that entry is a second front door
  to the same facts, its description still describes the AVA routing plan, and
  the framework has no other way to remove a menu item — so the module goes,
  and `fwconsole ma uninstall voiceplane` on the live PBX.
- **The AVA client surface** in the portal: `lib/ava.ts`,
  `lib/ava-voice-settings.ts`, the `avaConfigured()` gate, and the AVA fallback
  inside the context read.
- **The 824 entry point** and `[zeus-ai-*]` contexts once nothing routes to
  them (already unreachable; see the convergence doc).

## 6. Migration order

Each step is independently shippable and reversible.

1. **This document.**
2. **Remove the second front door** — delete the voiceplane module and its
   installer; uninstall it on the live PBX.
3. **Make the context read source-independent of AVA** — resolve the call from
   the portal's own channel vars, `voice_bindings`, and Dograh's records.
4. **Voice → Dograh** — `/dashboard/voice` reads Dograh's workflows and the
   account's bindings; `VoiceSection` loses its AVA assumptions; the AVA
   modules are deleted.
5. **The shell** — extract the frame (rail, tokens, primitives) so modules
   compose it, and move the existing dashboard sections onto it.
6. **Capstone merge** — bring the dashboard's agent/workflow/run screens in as
   modules, one at a time, each deleting its counterpart.
7. **Proxied modules** — FreePBX and AvantFax surfaced as labelled links under
   the estate group, SSO'd by the same gateway.

## 7. Non-goals

- **Rewriting FreePBX or AvantFax.** They own their jobs; the console points
  at them.
- **A second engine.** Dograh is the voice engine. Reintroducing a competitor
  to it is what produced the estate this document exists to collapse.
- **A new top-level app.** A third deployment would be a sixth UI, which is
  the problem.

## 8. Where this landed

| Step | Status |
| --- | --- |
| 2. Remove the second front door (the `voiceplane` module) | **Done** — the module and its installer are deleted. |
| 3. Context read independent of AVA | **Done** — resolved from the portal's own call store. |
| 4. Voice → Dograh | **Done** — `lib/dograh.ts`, `lib/voice-console.ts`. |
| 5. The shell | **Started** — `src/components/ui/` is the primitive set every screen composes; the rail, Estates map and the section headers are on it. Pane-style screens (Messages, Softphone) keep their own layouts. |
| 6. Capstone merge | **Started** — the customer-facing hand-off read is owned at `/dashboard/capstone`; Capstone's Agents and Workflows are merged into the owned `/dashboard/workflows`. The estate-operations pages (Services, Monitoring, Logs, Secrets, Users) remain in the Capstone dashboard, linked as a proxied surface. |
| 7. Proxied modules | **Done** — FreePBX, AvantFax, Dograh's flow editor, Workflow Studio and the Capstone dashboard are labelled links resolved by `proxiedLaunchers()`. |

`/dashboard` is the **Today** overview; the numbers moved to
`/dashboard/numbers` so the root answers "what is happening now" rather than
"what do I own". Agents and their calls live at `/dashboard/workflows`; the
Voice screen owns the routing plan and the live view.
