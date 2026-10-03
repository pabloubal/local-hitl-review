---
status: accepted
---

# Thread IDs keep their format; the CLI shows and accepts short handles

Thread IDs are `<YYYYMMDDTHHMMSSZ>-<random6>` (ADR 0005, [`file-format-v2.md`](../spec/file-format-v2.md)). Every ID in a tree shares the start of its timestamp, so a "shortest unambiguous prefix" (issue 99) is often 13 or more characters, too long to type or to fit a list column. This ADR amends issue 99's "unique prefixes" rule. Display and input rules are in [`docs/spec/cli.md`](../spec/cli.md) § Input conventions.

- **The ID format does not change.** Files, names and the core API are untouched.
- **A handle is the first N characters of the 6-character random part**, from `[a-z2-7]`. N is at least 4 and grows until the handle is unique among the threads in the tree, like git's `core.abbrev=auto`. In `thread list` the ID column is therefore 4 to 6 characters wide.
- **Input accepts three forms:** a full ID, a prefix of the full ID, or a handle of 4 to 6 characters. A handle that matches several threads is exit `2` (`INVALID_INPUT`), listing the candidates and a correct example.
- **The forms can't collide.** A full ID always has `0` at position 2 (the year is `20xx`), and `0` is not in the random alphabet, so a handle never matches the start of a full ID.
- **JSON carries the full `id` and a `shortId` field holding the handle.** Handles are for display and input only; nothing stores them.
- **Threads only.** Messages are addressed within their thread, so they get no handles.

## Considered options

- **Content-hash IDs, like git commit SHAs:** rejected. Drafts are editable, so a content hash would change on every edit, forcing renames and breaking references. Creation time would have to move into the frontmatter, and sorting by name would no longer sort by time. It reworks the shipped file format, the core, the specs and the extension. Git already hashes content, and the 1.0 roadmap has no tamper-evidence requirement.
- **Shortest unambiguous prefix of the full ID (issue 99):** the timestamp prefix makes it long, and it changes length as threads are added.
- **A fixed-length handle:** either too short to be unique in a large tree or wasteful in a small one.

## Consequences

- A handle that is unique today can become ambiguous when a teammate's thread arrives through git. The failure is a clear exit `2` listing the candidates; full IDs never have this problem, so scripts should store those.
- The handle length depends on the tree, so the same thread can show a different `shortId` in two clones. That is intended, as with abbreviated git hashes.
- Reconsider content-hash IDs only if tamper evidence or content-addressed dedupe across clones is needed. That would be a new ADR and a format version bump.
