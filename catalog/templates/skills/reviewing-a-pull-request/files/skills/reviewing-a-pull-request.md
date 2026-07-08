---
description: Use when reviewing a pull request — deciding whether a change is correct, safe, and ready, and giving feedback that helps.
---

# Reviewing a pull request

A review protects the codebase and helps the author. Start from what the change is trying to do — read the linked issue — then judge whether it does that, cleanly, without breaking anything else.

- **Correctness first.** Does it do what it claims? Walk the edge cases, the error paths, and the inputs the author probably didn't try. Everything else is secondary to this.
- **Fit second.** Does it follow the patterns already in the repo, or invent a new one without reason? Consistency is a feature.
- **Then the rest.** Tests for the new behavior, security and performance where they matter, and clarity. Naming and style are real but low-stakes — don't lead with them.
- **Run it.** Check the branch out and run the repo's checks. "Tests pass" you observed beats "looks fine" you assumed.
- **Say what and why, and rank it.** Anchor each comment to a line, name the problem, and explain why it matters. Mark what blocks merge versus what's a suggestion, so the author knows what's required.
- **Approve when it's ready.** A review that never approves is noise. Blocking on nits erodes trust; missing a real bug erodes it faster.

A few sharp comments beat a wall of nitpicks.
