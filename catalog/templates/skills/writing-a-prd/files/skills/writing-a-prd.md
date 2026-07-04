---
description: Use when the user asks to write, structure, or critique a product requirements document (PRD) — a feature spec, a milestone plan, or a "what should we build" brief.
---

# Writing a PRD

A good PRD makes the decision, then justifies it. Lead with what you're building
and why it's worth doing; leave the implementation to the people who'll build it.

Follow these steps:

1. **State the problem in one paragraph.** Who hurts, how much, and how you know.
   No solution yet — if you can't name the pain, you're not ready to spec.
2. **Name the decision.** One or two sentences: what ships. A reader should be
   able to repeat it back after a single pass.
3. **Give the shape, not the code.** User-visible behavior, the key screens or
   API surfaces, the states that matter. Resist designing the database.
4. **Draw the boundary.** An explicit "not in scope" list is the most valuable
   part of most PRDs — it's where scope creep goes to die.
5. **List the risks and open questions.** The things that could make this wrong.
   Each one gets an owner or a spike, not hand-waving.
6. **Define done.** The observable check that says this shipped and works.

Keep it short. A PRD nobody finishes is a PRD that didn't happen.
