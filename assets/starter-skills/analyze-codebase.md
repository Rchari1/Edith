---
id: analyze-codebase
title: 'Analyze Codebase'
description: 'Build an accurate picture of an unfamiliar codebase before changing it. Use when opening a repository for the first time, returning to one after a long gap, or before any change whose blast radius is unclear.'
rationale: 'Landing in an unfamiliar repository is one of the most common starting points for real work, and doing it badly costs the whole task.'
---

Understand the shape before touching anything.

1. **Check the brain first.** `search_brain` for the project name and its main components. Past decisions and gotchas about this codebase may already be captured, and re-deriving them wastes the time they cost to learn.
2. **Find the entry points.** Read `package.json` scripts, `Makefile`, `pyproject.toml` or equivalent. How it is built, run and tested tells you more about its structure than the directory tree does.
3. **Map the real modules, not the folders.** Follow imports outward from the entry point. A directory named `utils` and a 900-line file doing the actual work look identical in `ls`.
4. **Read the tests.** They are the executable specification and they show the intended usage of every seam that matters.
5. **Learn the conventions from the code**, not from a style guide: error handling, naming, how state is held, what is injected versus imported. Match them when you write.
6. **Identify the risky parts** - anything with no tests, files that are unusually large, and any place where the same concept is expressed two different ways.
7. **Report what you found** as a short map: entry points, where the real logic lives, how to run it, and the two or three things that would surprise a newcomer. Offer to `save_note` anything durable.
