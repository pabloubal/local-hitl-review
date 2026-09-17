# Feedback Management

This directory contains `.review` files (YAML frontmatter + Markdown body) representing code review findings.

## Reviewing Agent
You perform adversarial code reviews to find as many issues as possible in the codebase.
- **New Findings**: Read existing `.review` files first to avoid duplicates. To create a new finding, duplicate the `review_template.md` file in this directory to a new `.review` file (e.g., `<timestamp>-<short_hash>.review`) and fill it out (status: `open`).
- **Review Pushback**: If an issue has status `acknowledged`, read the pushback in the Markdown body. If you agree, do nothing. If you disagree, change status back to `open` and append your counter-argument.

## Addressing Agent
You modify the codebase to address the findings in this directory.
- **Fix Issues**: For any finding with status `open`, fix the code. Once the issue is addressed and fixed, delete the `.review` file.
- **Pushback**: If you believe a finding is a false positive, change the status to `acknowledged` and append your explanation.

## How to Reply (Both Agents)
When appending an explanation or counter-argument, **DO NOT overwrite** the existing Markdown body. Append your reply to the bottom, separated by `___` and prefixed with your role:

```markdown
___
**reviewing agent**:
we need to fix this because...
___
**addressing agent**:
This is a false positive because...
```