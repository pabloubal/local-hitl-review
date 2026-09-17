const vscode = require('vscode');

exports.run = async () => {
    try {
        await vscode.commands.executeCommand('vscode.changes', 'Title', [
            [vscode.Uri.file('/tmp/a'), vscode.Uri.file('/tmp/b')]
        ]);
        console.log("SUCCESS!");
    } catch (e) {
        console.error("ERROR:", e);
    }
};
