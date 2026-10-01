---
status: accepted
---

# Flat frontmatter, push records for GitHub IDs, and messages that can't be edited

The schema for `.lhr/` files has to keep ADR 0003's rule that every write adds a file. It must also be easy for agents without our tools to write by hand, and it must record GitHub's IDs after a review round has already been written. The full field list is in [`docs/spec/file-format-v2.md`](../spec/file-format-v2.md).

- **Frontmatter is restricted YAML:** one `key: value` per line, scalars only, with dotted keys for groups (`anchor.path`). It is still valid YAML, so any parser reads it. Our own parser stays small and needs no new dependency.
- **GitHub IDs go in push records.** Each `review push` writes a new committed file, `.lhr/pushes/<id>.md`, that maps local thread and message IDs to GitHub's. Threads and messages are never rewritten to store them. For each ID, the latest record wins. Its map is a JSON block in the body, because only tools write it.
- **Messages can't be edited once submitted.** A correction is a new message. Drafts are local and can be edited freely.
- **Messages point to their round.** A message submitted in a review round carries `round: <round-id>`, and the round file holds only the verdict and summary. This amends ADR 0003, which had the round file list its messages.
- **Changing severity works like changing status.** `thread.md` holds the starting severity, and any message can change it; the latest one wins.
- **One format version for the tree** (`.lhr/format`), not one per file, because `lhr migrate` converts the whole tree at once. Unknown keys are ignored by readers and only warned about by `lhr check`, so newer tools can add fields without breaking older ones.
- **Nothing derivable is stored.** Timestamps come from file names, the reviewer from the opening message, status and severity from messages, and anchor state from the code. Nudge delivery stays local, and the inbox is derived from whose turn it is.

## Considered options

- **Full YAML with nesting** (the `yaml` package): neater grouping, but it adds a dependency, and agents writing by hand get indentation wrong.
- **JSON frontmatter:** easy to parse, but awkward to write by hand in a markdown file.
- **GitHub IDs in sidecar files inside each thread directory:** keeps the data close to its thread, but spreads one push across many files.
- **GitHub IDs in a local, gitignored file:** a teammate or CI would post the round a second time.
- **Edits through `supersedes:` messages:** possible to do without rewriting files, but heavier than reviews need, and GitHub reviewers rarely edit after submitting.
- **A format version in every file:** only useful if trees could mix versions, which `lhr migrate` rules out.

## Consequences

- Posted GitHub bodies end with a hidden `<!-- lhr:message=<id> -->` marker, so a lost push record can't cause duplicate posts either.
- Submitting a round writes the round file first, then the messages, so a message never points at a missing round.
- Values that need lists or several lines go in the body (the anchor snapshot, suggestions, the push map) or become comma-separated strings.
