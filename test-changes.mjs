import * as vscode from 'vscode';

export async function run() {
    try {
        console.log("Running test...");
        await vscode.commands.executeCommand('vscode.changes', 'Title', [
            [vscode.Uri.file('/tmp/a'), vscode.Uri.file('/tmp/b')]
        ]);
        console.log("TEST SUCCESS!");
    } catch (e) {
        console.error("TEST ERROR:", e.message);
    }
}
