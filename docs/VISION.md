# Vision & Mission: Local HITL Review

### ⚠️ The Problem
As AI agents become capable of writing and reviewing code autonomously, a disconnect has emerged in the workflow. Traditional chat interfaces remove the developer from their codebase, while dropping large automated changes directly into a repository bypasses granular human oversight. Meanwhile, traditional issue trackers (like Jira or GitHub Issues) are too heavy, decoupled from the local Git working tree, and not designed for rapid, inline collaboration between a local agent and a developer. 

There is no native, lightweight medium for a human to point at specific lines of code locally and say, *"I think this breaks,"* or for an agent to push back and say, *"No, this is intentional because..."*

### 👁️ Vision
**A seamless, local-first collaboration environment where AI agents and human developers review code together through transparent, git-native feedback loops directly within the editor.**

We envision a workflow where the friction between AI generation and human oversight is eliminated. By treating feedback as just another piece of data in the repository, developers and agents can communicate, debate, and resolve issues in the exact same context where the code is written.

### 🎯 Mission
**To bridge the gap between autonomous AI coding and human decision-making by providing a lightweight, text-based review system in VS Code.**

We empower developers to efficiently navigate, manage, and act on agent-generated feedback without leaving their flow. By anchoring reviews in simple, parseable files, we ensure that the system remains entirely transparent, version-controllable, and universally readable by both machines and humans.

### 🛠️ How We Solve It (The Strategy)

We solve this problem by treating **feedback as code** and integrating it directly into the developer's local environment. Our approach relies on three core pillars:

1. **The Medium: Local, File-Backed Storage** 
   Instead of an external database, feedback is stored in a `.feedback` directory as individual `.review` files (Markdown + YAML frontmatter). 
   * **For Humans:** It is branch-aware, moves with your Git commits, and works entirely offline.
   * **For Agents:** It is incredibly simple to parse, generate, and edit using standard file I/O operations, giving the agent a native voice in the repository.

2. **The Interface: Native IDE Integration**
   We bring the review to where the code lives. By hooking into VS Code’s native Comment API and Source Control (SCM) views, agent feedback looks and feels exactly like a standard GitHub Pull Request review. Developers can read comments inline, apply code suggestions directly from the thread, and navigate a tree view of unreviewed files—all without leaving their keyboard.

3. **The Loop: True Human-in-the-Loop (HITL) Workflow**
   We establish a concrete lifecycle for agent-human interaction. Agents generate findings (`open`), and the human developer curates them. The developer can apply the fix, change the severity, push back by replying in the thread, or mark the item as `acknowledged`/`resolved`. Because these actions instantly update the underlying `.review` files, the agent can immediately read the human's response and take the next step.

### 🧱 Core Principles
* **Lightweight:** We are not an issue tracker. We provide exactly the lifecycle states needed for a review round and nothing more.
* **Agent-Friendly:** Designed from the ground up for LLMs to read and write without complex API integrations.
* **Developer-Centric:** Zero UI clutter; if there is no `.feedback` folder, the extension stays completely out of your way.
