import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('pablo.local-hitl-review'));
  });

  test('Extension should activate successfully', async () => {
    const ext = vscode.extensions.getExtension('pablo.local-hitl-review');
    if (!ext) {
      assert.fail('Extension not found');
    }
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
