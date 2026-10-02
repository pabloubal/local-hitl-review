import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';

const EXT = path.resolve(__dirname, '..');

// Pane-scoped list rows: `.pane-body .monaco-list-row` alone mixes in rows
// from every Source Control view.
export const CHANGED_FILES = '.pane:has(> .pane-header[aria-label^="Local HITL Review"]) .monaco-list-row';
export const SUMMARY = '.pane:has(> .pane-header[aria-label^="Review Feedback Summary"]) .monaco-list-row';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

// `main` has src/app.ts and README.md; `feature/review-me` edits app.ts and
// adds src/new.ts. The extension auto-detects `main` as the base branch.
function makeFixture(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@example.invalid');
  git(dir, 'config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature/review-me');
  fs.writeFileSync(
    path.join(dir, 'src/app.ts'),
    'export function add(a: number, b: number) {\n  // TODO validate input\n  return a + b + 0;\n}\n',
  );
  fs.writeFileSync(path.join(dir, 'src/new.ts'), 'export const answer = 42;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'feature work');
}

const SETTINGS = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'git.openRepositoryInParentFolders': 'never',
  'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  // macOS defaults to native menus and dialogs, which are outside the DOM.
  'window.menuStyle': 'custom',
  'window.dialogStyle': 'custom',
};

/** A disposable VS Code window on a fresh fixture repo, plus user-level helpers. */
export class VSCode {
  /** Checkpoints recorded with `checkpoint`, compared as one approved file. */
  private readonly checkpoints: string[] = [];

  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly workspace: string,
  ) {}

  /** Run a command the way a user does: F1, its palette title, Enter. */
  async palette(title: string): Promise<void> {
    const row = this.page.locator(`.quick-input-widget .monaco-list-row[aria-label^="${title}" i]`).first();
    // Context-dependent commands (e.g. Add Comment in a just-opened diff) are
    // registered a beat late, so reopen the palette a few times.
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.page.keyboard.press('F1');
      await this.page.locator('.quick-input-widget input').fill(`>${title}`);
      try {
        await row.waitFor({ state: 'visible', timeout: 1500 });
        await row.click();
        return;
      } catch {
        await this.page.keyboard.press('Escape');
      }
    }
    throw new Error(`palette has no command starting with "${title}"`);
  }

  /** Comment widgets sync their input to the extension host asynchronously. */
  async type(text: string): Promise<void> {
    await this.page.keyboard.insertText(text);
    await this.page.waitForTimeout(500);
  }

  /**
   * Put comment `n` of the open thread into edit mode and select its text.
   * Text typed in the first ~1s after Edit shows in the box but Save writes the
   * old body, and no DOM signal marks the input as ready, so wait it out.
   */
  async editComment(n: number): Promise<void> {
    await this.page.locator(`.review-widget .review-comment:nth-child(${n}) .action-label[aria-label^="Edit"]`).click();
    await this.page.waitForTimeout(1500);
    await this.page.keyboard.press('ControlOrMeta+A');
  }

  changedFile(name: string): Locator {
    return this.page.locator(`${CHANGED_FILES}[aria-label*="${name}"]`);
  }

  /** Open the diff of a changed file and comment on the line containing `lineText`. */
  async addComment(file: string, lineText: string, body: string): Promise<void> {
    await this.changedFile(file).click();
    await this.page.locator('.editor.modified .view-line', { hasText: lineText }).click();
    await this.palette('Comments: Add Comment on Current Selection');
    await expect(this.page.locator('.review-widget .comment-form')).toBeVisible();
    await this.type(body);
    await this.page.keyboard.press('ControlOrMeta+Enter');
    await expect(this.page.locator('.review-widget .review-comment')).toHaveCount(1);
  }

  /** `.feedback/*.review` files, the extension's persisted state. */
  reviewFiles(): string {
    const dir = path.join(this.workspace, '.feedback');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.review'))
      .sort()
      .map((f) => `### ${f}\n${fs.readFileSync(path.join(dir, f), 'utf8').trimEnd()}`)
      .join('\n\n') || '(no .review files)';
  }

  feedbackDir(): string[] {
    return fs.readdirSync(path.join(this.workspace, '.feedback')).sort();
  }

  /** Visible text of every match, one per line. */
  async texts(selector: string, attr?: 'aria-label'): Promise<string> {
    const els = this.page.locator(selector);
    const out = attr
      ? await els.evaluateAll((all, a) => all.map((e) => e.getAttribute(a) ?? ''), attr)
      : await els.allInnerTexts();
    return out.map((s) => s.replace(/ /g, ' ').trimEnd()).join('\n');
  }

  /**
   * Changed-files rows as `<aria-label> [<badge>]`. The badge (status letter,
   * or open-comment count) is CSS `::after` content, invisible to innerText.
   */
  async changedFiles(): Promise<string> {
    const rows = await this.page.locator(CHANGED_FILES).evaluateAll((all) =>
      all.map((r) => {
        const label = (r.getAttribute('aria-label') ?? '').replace(/, has actions$/, '').trim();
        const el = r.querySelector('.monaco-decoration-badge');
        const badge = el ? getComputedStyle(el, '::after').content.replace(/^"|"$/g, '') : '';
        return badge && badge !== 'none' ? `${label} [${badge}]` : label;
      }),
    );
    return rows.join('\n');
  }

  /**
   * Record a named checkpoint. Values are normalized (ids, timestamps, shas,
   * temp paths) so the approved file holds only what a reviewer should judge.
   */
  checkpoint(name: string, parts: Record<string, string | string[]>): void {
    const body = Object.entries(parts)
      .map(([k, v]) => `### ${k}\n${Array.isArray(v) ? v.join('\n') : v}`)
      .join('\n\n');
    this.checkpoints.push(`## ${name}\n\n${this.normalize(body)}\n`);
  }

  approvedText(): string {
    return this.checkpoints.join('\n');
  }

  private normalize(s: string): string {
    return s
      .split(this.workspace).join('<workspace>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<timestamp>')
      .replace(/\b\d{10,}-[0-9a-f]{4,}\.review\b/g, '<id>.review')
      .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>');
  }
}

async function launch(testInfo: TestInfo): Promise<{ vscode: VSCode; userData: string }> {
  const executablePath = process.env.E2E_CODE_PATH;
  if (!executablePath) throw new Error('E2E_CODE_PATH unset; run through playwright.config.ts');
  const workspace = testInfo.outputPath('fixture');
  makeFixture(workspace);
  // VS Code's IPC socket lives in the profile and macOS caps socket paths at
  // 103 chars, so the profile gets a short temp dir.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lhr-e2e-'));
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify(SETTINGS, null, 2));

  const app = await _electron.launch({
    executablePath,
    args: [
      workspace,
      `--extensionDevelopmentPath=${EXT}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(userData, 'extensions')}`,
      '--disable-extensions',
      '--new-window',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-telemetry',
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu-sandbox'] : []),
    ],
  });
  await app.context().tracing.start({ screenshots: true, snapshots: true, title: testInfo.title });
  const page = await app.firstWindow();
  await page.locator('.monaco-workbench .part.sidebar').waitFor();

  // The extension activates when its view becomes visible: open Source Control
  // and expand the view, then wait for the changed files to load.
  await page.keyboard.press('Control+Shift+G');
  const header = page.locator('.pane-header[aria-label^="Local HITL Review"]');
  await header.waitFor();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const vscode = new VSCode(app, page, workspace);
  await expect(vscode.changedFile('src/app.ts')).toBeVisible({ timeout: 30_000 });
  return { vscode, userData };
}

function collectLogs(userData: string, dest: string): void {
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/Local HITL Review|exthost\.log$|renderer\.log$/.test(e.name)) {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(p, path.join(dest, `${path.basename(path.dirname(p))}-${e.name}`));
      }
    }
  };
  walk(path.join(userData, 'logs'));
}

export const test = base.extend<{ vscode: VSCode }>({
  vscode: async ({}, use, testInfo) => {
    const { vscode, userData } = await launch(testInfo);
    await use(vscode);

    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) {
      await testInfo.attach('final-screen', { body: await vscode.page.screenshot(), contentType: 'image/png' });
      const trace = testInfo.outputPath('trace.zip');
      await vscode.app.context().tracing.stop({ path: trace });
      await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
    } else {
      await vscode.app.context().tracing.stop();
    }
    await vscode.app.close();
    if (failed) collectLogs(userData, testInfo.outputPath('logs'));
    fs.rmSync(userData, { recursive: true, force: true });
  },
});

/** Compare every checkpoint the test recorded against its approved file. */
test.afterEach(async ({ vscode }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus || !vscode.approvedText()) return;
  expect(vscode.approvedText()).toMatchSnapshot(`${testInfo.title}.md`);
});

export { expect };
