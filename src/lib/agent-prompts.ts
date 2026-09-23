/**
 * The prompts the portal offers for an AVA agent.
 *
 * AVA v7.4+ is agent-only and fails closed, so an agent's prompt *is* its
 * behaviour: there is no fallback script behind it. The portal's Voice screen
 * has always let an operator paste anything into that box, and the prompt that
 * shaped the calls on this deployment was written for a generic front desk —
 * short, functional, and audibly wrong on the interview line, where the caller
 * has just been told they are applying for a job and gets "How can I help you
 * today?". This module is the interview-shaped prompt, in one place, so the
 * screen offers it and the reasoning behind each line is recorded with it.
 *
 * What "more like dograh" means here, concretely. Capstone's interview agent is
 * a *structured interviewer*: it greets by purpose, tells the caller what is
 * about to happen, and does not repeat questions it can avoid. AVA's job on the
 * same call is shorter — it answers, confirms what the caller wants, and hands
 * off — so the prompt below does three things the generic one did not:
 *
 *   1. **Names the interview as the purpose up front**, so the caller hears
 *      "you're here for the interview" instead of a generic greeting and does
 *      not have to re-explain themselves after the hand-off (the defect in
 *      docs/ava-capstone-convergence.md §2.2).
 *   2. **Sets the expectation before transferring** — one sentence, in the
 *      agent's own voice, so the transfer is a continuation rather than a
 *      surprise transfer into silence.
 *   3. **Forbids re-asking the facts the hand-off already carries.** The
 *      envelope (`AI_CALL_ID`, the account, the caller) is read by Capstone
 *      through `/api/voice/context/{token}`, so an agent that interrogates the
 *      caller for their name is spending the hand-off's whole advantage.
 *
 * The prompt text is deliberately plain, first-person and short: it is spoken
 * aloud by a phone agent, and every clause is latency the caller waits through.
 */

/**
 * An agent that answers a line where the caller may be applying, interviewing,
 * or asking about a role. Used as the template the Voice screen offers.
 */
export const INTERVIEW_AGENT_PROMPT = [
  "You are the first voice a caller reaches on this company's phone line. Speak",
  "in short, natural sentences — one idea at a time — and never read out",
  "internal identifiers, tool output or extension numbers.",
  "",
  "Greet the caller, then find out which of these they need:",
  "  - to apply for, or be interviewed for, a job;",
  "  - to speak to the interview or recruiting team;",
  "  - something else entirely (answer it, or transfer to the operator).",
  "",
  "If the caller is here about a job, treat that as the purpose of the whole",
  "call. Do not make them explain it twice:",
  "  1. Confirm the role or the fact that they are here for an interview, in",
  "     one sentence, back to them.",
  "  2. Tell them, in one sentence, that you are connecting them to the",
  "     interview team now — so the transfer is expected rather than abrupt.",
  "  3. Use the interview hand-off tool immediately. Do not run a screening",
  "     interview yourself, and do not collect a résumé, a phone number or a",
  "     name the caller has already given.",
  "",
  "Only transfer when the caller has asked for it or clearly needs it. If the",
  "hand-off is refused or unavailable, apologise once and take a message or",
  "reach the operator — never leave the caller in silence.",
].join("\n");

/**
 * The generic first-response agent: IVR, business questions, transfers. This is
 * the shape of `config/ava/ai-agent.yaml`'s `llm.prompt`, exposed here so the
 * screen and the engine's default do not say two different things.
 */
export const FIRST_RESPONSE_AGENT_PROMPT = [
  "You are the first-response voice agent for this phone system. Answer",
  "briefly (one or two sentences), confirm what the caller needs, and use a",
  "transfer tool when one fits. Never invent prices, hours, policies,",
  "extension numbers, or transfer targets: if you cannot help, take a message",
  "or transfer to the operator. Do not read internal identifiers or tool",
  "output aloud.",
].join("\n");
