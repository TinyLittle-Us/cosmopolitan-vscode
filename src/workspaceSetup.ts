import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import { CosmoccToolchain } from './installer';

export async function configureWorkspace(folder: vscode.WorkspaceFolder, toolchain: CosmoccToolchain): Promise<void> {
	const cppConfiguration = vscode.workspace.getConfiguration('C_Cpp', folder.uri);
	const compilerPath = toolchain.shell ?? toolchain.cCompiler;
	const compilerArgs = toolchain.shell
		? ['-c', `export PATH=${quoteShellPath(path.join(toolchain.root, 'bin'))}:"$PATH"; exec ${quoteShellPath(toolchain.cCompiler)} "$@"`, 'cosmocc']
		: [];
	await Promise.all([
		cppConfiguration.update('default.compilerPath', compilerPath, vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.compilerArgs', compilerArgs, vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.cStandard', 'c17', vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.cppStandard', 'c++20', vscode.ConfigurationTarget.WorkspaceFolder)
	]);
	await configureBuildTasks(folder, toolchain);
}

async function configureBuildTasks(folder: vscode.WorkspaceFolder, toolchain: CosmoccToolchain): Promise<void> {
	const vscodeDirectory = vscode.Uri.joinPath(folder.uri, '.vscode');
	const tasksUri = vscode.Uri.joinPath(vscodeDirectory, 'tasks.json');
	await vscode.workspace.fs.createDirectory(vscodeDirectory);

	let contents = '';
	try {
		contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(tasksUri));
	} catch {
		contents = '{\n\t"version": "2.0.0",\n\t"tasks": []\n}\n';
	}

	const errors: ParseError[] = [];
	const parsed = parse(contents, errors) as { tasks?: unknown } | undefined;
	if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
		throw new Error(`Cannot configure Cosmopolitan build tasks because ${tasksUri.fsPath} contains invalid JSONC.`);
	}
	const existingTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
	const managedLabels = new Set(['Cosmopolitan: Build C File', 'Cosmopolitan: Build C++ File']);
	const tasks = existingTasks.filter((task) => !task || typeof task !== 'object' || !managedLabels.has((task as { label?: string }).label ?? ''));
	tasks.push(createBuildTask('Cosmopolitan: Build C File', toolchain.cCompiler, toolchain));
	tasks.push(createBuildTask('Cosmopolitan: Build C++ File', toolchain.cppCompiler, toolchain));

	const formattingOptions = { insertSpaces: true, tabSize: 2 };
	let edits = modify(contents, ['version'], '2.0.0', { formattingOptions });
	contents = applyEdits(contents, edits);
	edits = modify(contents, ['tasks'], tasks, { formattingOptions });
	contents = applyEdits(contents, edits);
	await vscode.workspace.fs.writeFile(tasksUri, new TextEncoder().encode(contents));
}

function createBuildTask(label: string, compilerPath: string, toolchain: CosmoccToolchain): Record<string, unknown> {
	const command = toolchain.shell ?? compilerPath;
	const args = [
		...(toolchain.shell ? [compilerPath] : []),
		'-g',
		'-O0',
		'${file}',
		'-o',
		path.join('${fileDirname}', '${fileBasenameNoExtension}.exe')
	];
	return {
		label,
		type: 'process',
		command,
		args,
		options: {
			cwd: '${fileDirname}',
			...(toolchain.shell ? { env: { PATH: [path.join(toolchain.root, 'bin'), process.env.PATH ?? ''].join(path.delimiter) } } : {})
		},
		group: 'build',
		problemMatcher: '$gcc'
	};
}

function quoteShellPath(value: string): string {
	const posixPath = value.replace(/^([a-zA-Z]):[\\/]/, (_match, drive: string, rest: string) => `/${drive.toLowerCase()}/${rest}`).replace(/\\/g, '/');
	return `'${posixPath.replace(/'/g, "'\\''")}'`;
}