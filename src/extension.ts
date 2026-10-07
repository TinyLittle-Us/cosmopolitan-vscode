import * as vscode from 'vscode';
import * as path from 'node:path';
import { ensureCosmocc } from './installer';
import { configureWorkspace, WORKSPACE_LAUNCH_CONFIGURATION } from './workspaceSetup';
import { WorkspaceBuildTaskProvider } from './workspaceTaskProvider';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Cosmopolitan');
	context.subscriptions.push(output);

	let setupInProgress: Promise<void> | undefined;
	let toolchainInProgress: ReturnType<typeof ensureCosmocc> | undefined;
	const getToolchain = (report?: (message: string) => void): ReturnType<typeof ensureCosmocc> => {
		toolchainInProgress ??= ensureCosmocc(context.globalStorageUri.fsPath, (message) => {
			output.appendLine(message);
			report?.(message);
		}).catch((error: unknown) => {
			toolchainInProgress = undefined;
			throw error;
		});
		return toolchainInProgress;
	};
	const setup = (): Promise<void> => {
		if (setupInProgress) {
			return setupInProgress;
		}
		setupInProgress = Promise.resolve(vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Setting up Cosmopolitan', cancellable: false },
			async (progress) => {
				const toolchain = await getToolchain((message) => progress.report({ message }));
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
		)).catch((error: unknown) => {
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
	context.subscriptions.push(vscode.commands.registerCommand('cosmopolitan.launch', async () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			void vscode.window.showErrorMessage('Open a workspace folder before launching Cosmopolitan.');
			return;
		}

		await setup();
		const started = await vscode.debug.startDebugging(folder, WORKSPACE_LAUNCH_CONFIGURATION);
		if (!started) {
			void vscode.window.showErrorMessage(`Could not start ${WORKSPACE_LAUNCH_CONFIGURATION}. Check the configured GDB path.`);
		}
	}));
	context.subscriptions.push(vscode.tasks.registerTaskProvider('cosmopolitan', new WorkspaceBuildTaskProvider(getToolchain)));
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void setup()));
	void setup();
}

export function deactivate(): void {}