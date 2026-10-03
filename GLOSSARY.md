# Local HITL Review

Local, human-in-the-loop code review between developers and coding agents: humans and agents discuss code in threads anchored to lines, and feedback flows back to the agent that wrote the code.

## Language

### Review

**Thread**:
A discussion attached to a specific piece of code, made of one or more messages.
_Avoid_: Comment (for the whole discussion), feedback item, finding, issue

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
