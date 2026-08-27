---
id: review-a-pr
title: 'Review A PR'
description: 'Review a pull request for correctness, design and risk. Use when asked to review a PR, a branch, or a diff before merging.'
rationale: 'Reviewing is a repeated, high-value task where the common failure is commenting on style while a correctness bug goes through.'
---

Correctness first. Style last, and briefly.

1. **Read the description, then ignore it.** Judge what the diff does, not what it claims to do. A mismatch between the two is itself the most valuable finding.
2. **Read the diff in context.** Open the surrounding file for anything non-trivial - a change that looks correct in isolation is routinely wrong given the code above it.
3. **Hunt for correctness bugs.** Off-by-one, unhandled errors, null and empty cases, race conditions, resource leaks, changed semantics for existing callers. For each, state a concrete failure: the input, and the wrong output or crash.
4. **Ask what is missing.** Tests for the new path, the error path, the migration for changed on-disk data, callers not updated. Absence is harder to see than error and is where the real defects hide.
5. **Check the blast radius.** Who else calls this? Does the change alter a contract - an API shape, a file format, a config key - that something outside the diff depends on?
6. **Then design**, and only where it matters: duplication that will drift, a seam in the wrong place, a file that has grown into two responsibilities.
7. **Report ranked by severity**, most serious first, each with file and line. Say plainly when something is a preference rather than a defect, and say plainly when the PR is fine.
