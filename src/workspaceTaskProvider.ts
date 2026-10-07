import * as path from 'node:path';
import * as vscode from 'vscode';
import { CosmoccToolchain } from './installer';
import { WORKSPACE_BUILD_TASK_LABEL } from './workspaceSetup';

export class WorkspaceBuildTaskProvider implements vscode.TaskProvider {
	constructor(private readonly getToolchain: () => Promise<CosmoccToolchain>) {}

	async provideTasks(): Promise<vscode.Task[]> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) {
			return [];
		}

		const toolchain = await this.getToolchain();
		return Promise.all(folders.map((folder) => this.createWorkspaceTask(folder, toolchain)));
	}

	async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
		const folderUri = task.definition.workspaceFolder;
		if (task.definition.type !== 'cosmopolitan' || typeof folderUri !== 'string') {
			return undefined;
		}
		const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.toString() === folderUri);
		if (!folder) {
			return undefined;
		}
		return this.createWorkspaceTask(folder, await this.getToolchain());
	}

	private async createWorkspaceTask(folder: vscode.WorkspaceFolder, toolchain: CosmoccToolchain): Promise<vscode.Task> {
		const sourceFiles = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, '**/*.{c,cc,cpp,cxx}'),
			'**/{.git,node_modules,out,.vscode}/**'
		);
		const compilerPath = toolchain.cppCompiler;
		const outputPath = path.join(folder.uri.fsPath, `${path.basename(folder.uri.fsPath)}.exe`);
		const args = [
			...(toolchain.shell ? [compilerPath] : []),
			'-g',
			'-O0',
			...sourceFiles.map((sourceFile) => sourceFile.fsPath),
			'-o',
			outputPath
		];
		const options: vscode.ProcessExecutionOptions = {
			cwd: folder.uri.fsPath,
			...(toolchain.shell
				? {
					env: {
						PATH: [path.join(toolchain.root, 'bin'), process.env.PATH ?? ''].join(path.delimiter),
						TMPDIR: '.'
					}
				}
				: {})
		};
		const definition: vscode.TaskDefinition = {
			type: 'cosmopolitan',
			workspaceFolder: folder.uri.toString()
		};
		const execution = new vscode.ProcessExecution(toolchain.shell ?? compilerPath, args, options);
		const task = new vscode.Task(definition, folder, WORKSPACE_BUILD_TASK_LABEL, 'Cosmopolitan', execution, '$gcc');
		task.group = vscode.TaskGroup.Build;
		return task;
	}
}