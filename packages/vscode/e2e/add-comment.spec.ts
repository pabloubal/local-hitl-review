import { expect, test } from './vscode';

test('add a comment from a diff', async ({ vscode }) => {
  const { page } = vscode;

  await test.step('open the diff of a changed file', async () => {
    await vscode.changedFile('src/app.ts').click();
    await expect(page.locator('.tab.active')).toHaveAttribute('aria-label', /app\.ts \(vs main ↔ Working\)/);
  });

  await test.step('open the comment widget on line 2', async () => {
    await page.locator('.editor.modified .view-line', { hasText: 'TODO validate' }).click();
    await vscode.palette('Comments: Add Comment on Current Selection');
    await expect(page.locator('.review-widget .comment-form')).toBeVisible();
  });

  await test.step('type and submit with the keyboard', async () => {
    await vscode.type('Validate both inputs are finite numbers. #high');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.review-widget .review-comment')).toHaveCount(1);
  });

  vscode.checkpoint('after submit', {
    'thread header': await vscode.texts('.review-widget .head'),
    comment: await vscode.texts('.review-widget .review-comment'),
    'changed files': await vscode.changedFiles(),
    '.feedback': vscode.feedbackDir(),
    'review files': vscode.reviewFiles(),
  });
});
