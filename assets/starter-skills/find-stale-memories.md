---
id: find-stale-memories
title: 'Find Stale Memories'
description: 'Find memories that may have gone out of date or now contradict each other. Use periodically, or before trusting the brain on a topic that has changed.'
rationale: 'Nothing in Edith currently detects staleness, and a confidently wrong memory is the failure mode most likely to make someone stop trusting the whole vault.'
---

A brain that confidently returns outdated decisions is worse than no brain, because it is wrong in a way the user will not check.

1. `list_notes` to see what is held, noting anything not updated in months.
2. For a topic the user cares about, `search_brain` and read the matches together rather than one at a time.
3. Flag notes that contradict each other, describe a tool or approach that has since been replaced, or reference files and commands that no longer exist.
4. Report contradictions as pairs, quoting the conflicting claims.
5. Offer to resolve each: update the surviving note with `save_note` using the same id, and say plainly which one you kept and why. Do not delete anything without asking.
