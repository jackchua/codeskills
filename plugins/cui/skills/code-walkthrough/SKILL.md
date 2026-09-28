---
name: code-walkthrough
description: Write a Medium-style narrative walkthrough of a commit, or answer a pointed question about a specific line, function or decision in it. Use when the user asks to explain, walk through or understand a commit or file, runs /cui:walkthrough, or when the CUI server invokes a walkthrough or question job.
---

# Code walkthrough

The reader is the person who owns this codebase but did not type it. They are smart, they
know the language, and they have no idea why *this* code exists in *this* shape. Your job is
to hand them back ownership of the change.

Write like a good engineering blog post: a clear thread, real code, honest about trade-offs.
Not API documentation. Not a diff narration.

## Two modes

- **Walkthrough** — the whole commit, explained end to end.
- **Question** — one pointed question about a line, function or decision. Jump to
  [Answering questions](#answering-questions).

## Gather before writing

```bash
git show --stat <sha>                 # shape of the change
git show <sha>                        # the actual diff
git log -1 --format=%B <sha>          # message and PF trailers
git show <sha>^:path/to/file.ts       # the before, for anything non-trivial
```

Read the surrounding files, not only the diff. A walkthrough that can't say what the changed
function is called *by* is a walkthrough of a fragment. Check `.cui/blueprint.yaml` for the
boundary rules the change is operating under, and `.cui/product-functions.yaml` for the
milestone it serves.

## Structure

````markdown
# <A title that names the problem, not the files>

> **TL;DR** — two sentences. What changed, and the one thing worth knowing about it.
> `a1b2c3d` · 7 files · +412 −38 · PF-2 (progress)

## The problem

Why this commit exists. Start with the situation *before*: what didn't work, what was
awkward, what the user asked for. Two or three paragraphs. If a reader stops here they
should still understand why someone spent an afternoon on this.

## The approach

The shape of the solution in prose, before any code. What are the moving parts and how do
they fit? One short list or a small diagram if the structure is genuinely branching —
otherwise prose.

## Walking through it

The heart. Ordered by the reader's understanding, **not** by file path or diff order.
Start where the data enters and follow it.

Each section: a heading, a paragraph of setup, a snippet, then what to notice.

### Inferring column types from a sample

The generator can't ask the user what type each column is, so it guesses from the first
200 non-null values:

```ts
// src/data/infer.ts:34
function inferType(samples: string[]): ColumnType {
  if (samples.every(isIsoDate)) return 'timestamp'
  if (samples.every(isNumeric)) return 'numeric'
  return 'text'
}
```

Note the ordering: `isIsoDate` runs before `isNumeric` because `20240115` parses as both,
and a date guessed as a number is much harder to notice downstream than the reverse.

## Design decisions

The forks in the road, and why each went the way it did. This is the section that survives
longest, because the code shows *what* and only this shows *why*.

**Text histograms instead of a charting library.** A PNG per commit is 200KB in git forever
and unreadable in a diff. ASCII is neither. Trade-off: no interactivity, which nobody
wanted here.

**No connection pooling yet.** The seeder is single-threaded and runs for ten seconds. A
pool is the right answer at PF-4 when the API shares the connection; today it is one more
thing to configure. Revisit when `src/api` lands.

## What this doesn't do

Known gaps, deferred work, sharp edges. Be specific and honest — this is the section that
stops a future reader from assuming a guarantee that isn't there.

## Where to look next

Three or four file:line pointers, each with a one-line reason to go there.
````

## Voice

- Second person, present tense. "You'll notice the guard clause here" beats "It should be
  noted that a guard clause is present."
- Short paragraphs. Three or four sentences.
- Say the awkward thing. "This is uglier than it should be; the type inference really wants
  to be a state machine, but two passes was enough for now" tells the reader more than any
  amount of polish.
- Never pad. If the commit is small, the walkthrough is short. A 200-word walkthrough of a
  one-function change is a success, not a failure.

## Snippets

- **Real code, copied verbatim** from the repo. Never paraphrase or invent.
- Always precede with a `// path/to/file.ts:LINE` comment — the CUI turns these into links.
- 5–25 lines. Longer than that, split it and explain the halves.
- Elide with `// ...` and say what you cut: `// ... 30 lines of validation, unchanged`.
- Show the *before* only when the change is a replacement and the contrast carries the point.

## Diagrams

Only when the structure genuinely branches — a pipeline with stages, a state machine, a
request path across services. Draw it as ASCII inside a plain code fence: it renders
everywhere, diffs cleanly, and costs nothing. Do not diagram a linear sequence of three
function calls.

```
  CSV upload ──▶ infer types ──▶ validate ──┬──▶ persist ──▶ chart
                                            └──▶ reject (422, row numbers)
```

## Answering questions

The question arrives with a file, a line range, the commit sha, and usually the walkthrough
that prompted it. The reader is looking at that code right now.

1. **Answer the actual question in the first sentence.** No restating, no "great question".
2. **Then ground it** in the code — read the file at that commit (`git show <sha>:<path>`),
   read its callers and callees. Trace the real path, don't infer from names.
3. **Show the evidence.** Quote the relevant lines with their real line numbers.
4. **Answer the question behind the question** when there is one. "Why is this a Map?" is
   usually "would a plain object be fine?" — answer both, briefly.
5. **Say when you don't know.** "The retry count is 3 and I can't find a rationale in the
   history — it looks arbitrary" is a genuinely useful answer. Never invent a reason.

Length: as short as the question allows. A one-line question gets a one-paragraph answer
with one snippet. Only go long when the answer is genuinely structural.

If the question reveals a real bug, say so plainly and directly at the top — that outranks
finishing the explanation.

## Output

Markdown only, no front matter, starting at the `#` heading. When invoked as a CUI job,
write nothing to stdout except the markdown body — the server stores it verbatim.
