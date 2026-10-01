---
status: accepted
---

# Threads are directories of append-only message files

Every writer (the extension, the `lhr` CLI, the MCP server, and agents writing files by hand) changes the review store by **adding a file**. No file is rewritten after it's created. Concurrent writers can't overwrite each other, two branches that both add replies merge without conflicts, and deleting one message can't take the rest of the thread with it (the cause of [#36](https://github.com/pabloubal/local-hitl-review/issues/36)).

```
.lhr/
  threads/<thread-id>/
    thread.md                          anchor + thread metadata, written once
    20261001T101500Z-human-a1b2.md     one file per message
    20261001T103012Z-agent-9f3c.md
  rounds/
    20261001T110000Z-r7k2.md           one file per submitted review round
  drafts/                              gitignored, local to one reviewer
```

- **One directory per thread.** `thread.md` holds the saved anchor and the thread's metadata. The anchor never changes (see the anchor-state decision), so `thread.md` never needs rewriting.
- **Message file names:** `<UTC timestamp>-<author>-<random>.md`, with the timestamp in `YYYYMMDDTHHMMSSZ` form. Names sort into message order and never collide, whether between writers or branches. An agent without our tools can make one with `date -u +%Y%m%dT%H%M%SZ`. Thread IDs use the same timestamp-plus-random scheme.
- **Status comes from messages.** A message may carry `status: resolved` (or `status: open`) in its frontmatter. The latest message that sets a status wins, and any later message without one reopens a resolved thread. "Whose turn" is the author of the last message.
- **Drafts never enter the shared tree.** Draft messages wait in `.lhr/drafts/`, which is gitignored. Submitting a review round moves them into their threads and writes one round file. Its frontmatter records the verdict, and its body is the review summary. Each submitted message carries `round: <round-id>`; the round file doesn't list them (amended by ADR 0005). Agents that read the tree can't see a draft.

## Considered options

- **One file per thread, messages separated by markers.** Fewer files, but every reply rewrites the file, so concurrent writers race and branches conflict.
- **Sequence-numbered message files (`003-agent.md`).** Easier to read, but two writers or two branches both create `003`.
- **Status as a field in `thread.md`.** Simpler to read, but it makes `thread.md` mutable and brings back the conflicts above.
- **Drafts in place with a `draft: true` flag.** Every reader would have to filter drafts, and submitting would rewrite files.

## Consequences

- Many small files. Readers list a directory and sort by name; that is cheap at review scale.
- The field lists for `thread.md`, messages and round files are in `docs/spec/file-format-v2.md`. GitHub IDs from `review push` go in push records (ADR 0005).
- Moving from `.feedback/` to `.lhr/` is part of the migration ticket.
