const vscode = require('vscode');
console.log(vscode.window.activeTextEditor?.document.uri.scheme);
