import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  contributes: { keybindings: Keybinding[] };
};

describe('comment box keybindings', () => {
  // Keymap extensions (e.g. IntelliJ keybindings) bind cmd+enter to lineBreakInsert on
  // editorTextFocus, which shadows VS Code's built-in submit in the comment box (#56).
  it('binds cmd+enter / ctrl+enter to submit only inside our comment box', () => {
    const binding = manifest.contributes.keybindings.find(
      (k) => k.command === 'editor.action.submitComment',
    );
    assert.ok(binding, 'expected a keybinding for editor.action.submitComment');
    assert.equal(binding.key, 'ctrl+enter');
    assert.equal(binding.mac, 'cmd+enter');
    assert.match(binding.when ?? '', /\bcommentEditorFocused\b/);
    assert.match(binding.when ?? '', /\bcommentController == vscode-comment\b/);
  });
});
