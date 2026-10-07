import * as vscode from 'vscode';
import * as path from 'node:path';
import { ensureCosmocc } from './installer';
import { configureWorkspace } from './workspaceSetup';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Cosmopolitan');
	context.subscriptions.push(output);

	let setupInProgress: Promise<void> | undefined;
	const setup = (): Promise<void> => {
		if (setupInProgress) {
			return setupInProgress;
		}
		setupInProgress = vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Setting up Cosmopolitan', cancellable: false },
			async (progress) => {
				const toolchain = await ensureCosmocc(context.globalStorageUri.fsPath, (message) => progress.report({ message }));
				if (toolchain.shell) {
					process.env.PATH = [path.join(toolchain.root, 'bin'), process.env.PATH ?? ''].join(path.delimiter);
				}
				const folders = vscode.workspace.workspaceFolders ?? [];
				for (const folder of folders) {
					await configureWorkspace(folder, toolchain);
					output.appendLine(`Configured ${folder.name} to build with Cosmopolitan.`);
				}
				output.appendLine(`Cosmopolitan C compiler: ${toolchain.cCompiler}`);
				output.appendLine(`Cosmopolitan C++ compiler: ${toolchain.cppCompiler}`);
			}
		).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			output.appendLine(`Setup failed: ${message}`);
			void vscode.window.showErrorMessage(`Cosmopolitan setup failed: ${message}`, 'Show Output').then((choice) => {
				if (choice === 'Show Output') {
					output.show();
				}
			});
		}).finally(() => {
			setupInProgress = undefined;
		});
		return setupInProgress;
	};

	context.subscriptions.push(vscode.commands.registerCommand('cosmopolitan.setup', setup));
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void setup()));
	void setup();
}

export function deactivate(): void {}