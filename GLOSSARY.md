# Local HITL Review

Local, human-in-the-loop code review between developers and coding agents: humans and agents discuss code in threads anchored to lines, and feedback flows back to the agent that wrote the code.

## Language

### Review

**Thread**:
A discussion attached to a specific piece of code, made of one or more messages.
_Avoid_: Comment (for the whole discussion), feedback item, finding, issue

**Handle**:
The short form of a thread's ID shown in `lhr` output and accepted as input: the first 4 to 6 characters of the ID's random part, as many as needed to be unique in the tree. Only threads have handles.
_Avoid_: Short ID (in prose; `shortId` is the JSON field), alias

**Message**:
A single entry in a thread, written by a human or an agent.
_Avoid_: Comment, reply (for the first entry), response

**Review round**:
A batch of draft threads and messages that a reviewer submits together, with a verdict.
_Avoid_: Review session, session, pass

**Draft**:
A thread or message the reviewer has written but not yet submitted in a review round, so agents can't see it yet.
_Avoid_: Pending comment

**Verdict**:
The reviewer's overall outcome for a review round: approve, comment, or request changes.
_Avoid_: Decision, result

**Resolved**:
A thread someone has marked done. It no longer counts as waiting on anyone and can be reopened.
_Avoid_: Closed, done, won't fix

**Turn**:
Who a thread is waiting on next, the reviewer or the agent. "Waiting on you" means it's the reviewer's turn.
_Avoid_: Assignee

**Severity**:
How serious a thread is: critical, high, medium or low, as set on its latest message.
_Avoid_: Priority

**Viewed**:
A reviewer's mark on a changed file meaning they've seen its current content. It clears when the content changes.
_Avoid_: Reviewed

### Anchoring

**Review root**:
The directory holding `.lhr/`, found by walking up from where `lhr` runs. It may be a repo toplevel, a plain directory containing several repos, or a directory inside a larger repo. Anchor paths are relative to it.
_Avoid_: Repo root, workspace

**Anchor**:
The saved, never-changing record of which code a thread was attached to when it was created.
_Avoid_: Position, location

**Anchor state**:
How a thread's anchor relates to the code as it is now: current, outdated, or orphaned.
_Avoid_: Staleness

**Current**:
The anchored code is unchanged, even if it has moved to other lines.

**Outdated**:
The anchored code itself has been edited since the thread was created.
_Avoid_: Stale, modified

**Orphaned**:
The anchored code or its file no longer exists.
_Avoid_: Deleted, lost

### Agents

**Agent session**:
One running or resumable conversation with a coding agent, such as a Claude Code session.
_Avoid_: Session (unqualified), agent run

**Nudge**:
A short notice sent to an agent session saying that submitted feedback is waiting for it.
_Avoid_: Notification, ping

**Inbox**:
The open, submitted threads where it's an agent's turn to reply. A thread leaves the inbox when an agent replies in it, not when it's read.
_Avoid_: Queue, unread
