import { execFileSync } from 'node:child_process';
import { expect, test } from './vscode';

const WIDGET = '.review-widget';
const comment = (n: number): string => `${WIDGET} .review-comment:nth-child(${n})`;

test.beforeEach(async ({ vscode }) => {
  await vscode.addComment('src/app.ts', 'TODO validate', 'Validate both inputs. #high');
});

test('change severity and status', async ({ vscode }) => {
  const { page } = vscode;

  await test.step('set severity to Critical', async () => {
    await page.locator(`${WIDGET} .action-label[aria-label^="Change Severity"]`).click();
    await page.locator('.context-view .action-label', { hasText: 'Critical' }).click();
    await expect(page.locator(`${WIDGET} .head`)).toContainText('Critical');
  });
  vscode.checkpoint('after severity', {
    'thread header': await vscode.texts(`${WIDGET} .head`),
    'review files': vscode.reviewFiles(),
  });

  await test.step('set status to Resolved', async () => {
    await page.locator(`${WIDGET} .action-label[aria-label^="Change Status"]`).click();
    await page.locator('.context-view .action-label', { hasText: 'Resolved' }).click();
    await expect(page.locator(`${WIDGET} .review-comment`)).toBeHidden();
    // The badge falls back from the comment count to the status letter a beat later.
    await expect.poll(() => vscode.changedFiles()).toContain('M src/app.ts [M]');
  });
  vscode.checkpoint('after resolve', {
    'changed files': await vscode.changedFiles(),
    'review files': vscode.reviewFiles(),
  });

  await test.step('re-open the collapsed thread from its glyph', async () => {
    await page.locator('.comment-range-glyph.comment-thread').first().click();
    await expect(page.locator(`${WIDGET} .head`)).toBeVisible();
  });
  vscode.checkpoint('re-opened', { 'thread header': await vscode.texts(`${WIDGET} .head`) });
});

test('reply in a thread', async ({ vscode }) => {
  const { page } = vscode;
  await page.locator(`${WIDGET} .comment-form`).click();
  await vscode.type('Also reject NaN.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator(`${WIDGET} .review-comment`)).toHaveCount(2);

  vscode.checkpoint('after reply', {
    comments: await vscode.texts(`${WIDGET} .review-comment`),
    'review files': vscode.reviewFiles(),
  });
});

test('edit a comment', async ({ vscode }) => {
  const { page } = vscode;
  await vscode.editComment(1);
  await vscode.type('Validate inputs and reject NaN.');
  // Save advertises ⌘Enter. Clicking it can land on the hover left over from
  // the Edit click, which sits on top of the button.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator(comment(1))).toContainText('reject NaN');

  vscode.checkpoint('after edit', {
    comment: await vscode.texts(comment(1)),
    'review files': vscode.reviewFiles(),
  });
});

test('apply a suggestion', async ({ vscode }) => {
  const { page } = vscode;

  await test.step('replace the body with a suggestion block', async () => {
    await vscode.editComment(1);
    // One insert with an unindented code line: typed line by line, Monaco
    // auto-indents the closing fence and the parser rejects it (#87).
    await vscode.type('Use a guard.\n```suggestion\nif (!Number.isFinite(a + b)) throw new Error("bad");\n```');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator(comment(1))).toContainText('Use a guard.');
  });

  await test.step('apply it and save the file', async () => {
    await page.locator(`${comment(1)} .action-label[aria-label^="Apply Suggestion"]`).click();
    await expect(page.locator('.tab.active.dirty')).toBeVisible();
    await page.locator('.editor.modified .view-line').first().click();
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.locator('.tab.active.dirty')).toBeHidden();
  });

  vscode.checkpoint('after apply and save', {
    'git diff src/app.ts': execFileSync('git', ['diff', '--', 'src/app.ts'], { cwd: vscode.workspace }).toString(),
    'review files': vscode.reviewFiles(),
  });
});

test('delete a comment', async ({ vscode }) => {
  const { page } = vscode;
  await page.locator(`${WIDGET} .action-label[aria-label^="Delete"]`).click();
  await expect(page.locator('.monaco-dialog-box')).toContainText('Delete this review comment?');
  await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Delete' }).click();
  await expect(page.locator(`${WIDGET} .review-comment`)).toHaveCount(0);
  await expect.poll(() => vscode.changedFiles()).toContain('M src/app.ts [M]');

  vscode.checkpoint('after delete', {
    '.feedback': vscode.feedbackDir(),
    'changed files': await vscode.changedFiles(),
  });
});
