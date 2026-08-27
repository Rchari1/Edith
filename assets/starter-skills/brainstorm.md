---
id: brainstorm
title: 'Brainstorm'
description: 'Explore a problem and settle on an approach before writing code. Use when starting a feature, facing a design decision, or when the right shape of a solution is not yet obvious.'
rationale: 'Design decisions made without exploring alternatives are the ones most often rebuilt, and the reasoning behind them is exactly what a second brain exists to keep.'
---

Understand, then propose, then commit. Do not start coding during this.

1. **Check the brain.** `search_brain` for the problem area - a past decision or constraint may already settle part of this, and contradicting it accidentally is worse than not knowing.
2. **Establish what is actually being asked.** What has to be true when this is done? What is explicitly out of scope? Ask about the one or two things that would genuinely change the design, and make ordinary judgement calls yourself rather than interrogating.
3. **Name the constraints** that are real: existing data on disk, a public interface, performance, who maintains it.
4. **Propose two or three approaches**, not one. For each: how it works in a sentence, what it costs, and what it forecloses. Include the option of doing less than asked if that is genuinely better.
5. **Recommend one and say why**, including what would have to be true for a different choice to win.
6. **Name the thing most likely to be wrong** about the recommendation. A design with no stated risk has not been thought about hard enough.
7. **Once it is agreed, `save_note` the decision and the reasoning** - the reasoning is the durable half, and it is what stops the same discussion happening again in three months.
