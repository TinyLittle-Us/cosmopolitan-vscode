import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import { CosmoccToolchain } from './installer';

export const WORKSPACE_BUILD_TASK_LABEL = 'Cosmopolitan: Build Workspace';
export const WORKSPACE_LAUNCH_CONFIGURATION = 'Cosmopolitan: Launch Workspace';

export async function configureWorkspace(folder: vscode.WorkspaceFolder, toolchain: CosmoccToolchain): Promise<void> {
	const cppConfiguration = vscode.workspace.getConfiguration('C_Cpp', folder.uri);
	const isWindows = Boolean(toolchain.shell);
	const compilerPath = isWindows ? '' : toolchain.cCompiler;
	const compilerArgs: string[] = [];
	const toolchainIncludes = isWindows
		? [path.join(toolchain.root, 'include'), path.join(toolchain.root, 'include', '**')]
		: [];
	const currentIncludes = cppConfiguration.get<string[]>('default.includePath', []);
	const includePath = [...new Set([...currentIncludes, ...toolchainIncludes])];
	const toolchainDefines = isWindows ? ['__COSMOPOLITAN__', '__COSMOCC__', '__FATCOSMOCC__'] : [];
	const currentDefines = cppConfiguration.get<string[]>('default.defines', []);
	const defines = [...new Set([...currentDefines, ...toolchainDefines])];
	await Promise.all([
		cppConfiguration.update('default.compilerPath', compilerPath, vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.compilerArgs', compilerArgs, vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.includePath', includePath, vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.defines', defines, vscode.ConfigurationTarget.WorkspaceFolder),
		...(isWindows
			? [cppConfiguration.update('default.intelliSenseMode', 'windows-gcc-x64', vscode.ConfigurationTarget.WorkspaceFolder)]
			: []),
		cppConfiguration.update('default.cStandard', 'c17', vscode.ConfigurationTarget.WorkspaceFolder),
		cppConfiguration.update('default.cppStandard', 'c++20', vscode.ConfigurationTarget.WorkspaceFolder)
	]);
	await configureBuildTasks(folder, toolchain);
	await configureLaunchConfiguration(folder);
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
	const managedLabels = new Set([
		'Cosmopolitan: Build C File',
		'Cosmopolitan: Build C++ File',
		WORKSPACE_BUILD_TASK_LABEL
	]);
	const tasks = existingTasks.filter((task) => !task || typeof task !== 'object' || !managedLabels.has((task as { label?: string }).label ?? ''));
	tasks.push(createBuildTask('Cosmopolitan: Build C File', toolchain.cCompiler, toolchain));
	tasks.push(createBuildTask('Cosmopolitan: Build C++ File', toolchain.cppCompiler, toolchain));
	tasks.push({
		label: WORKSPACE_BUILD_TASK_LABEL,
		type: 'cosmopolitan',
		workspaceFolder: folder.uri.toString(),
		group: 'build',
		problemMatcher: '$gcc'
	});

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
			...(toolchain.shell
				? {
					env: {
						PATH: [path.join(toolchain.root, 'bin'), process.env.PATH ?? ''].join(path.delimiter),
						TMPDIR: '.'
					}
				}
				: {})
		},
		group: 'build',
		problemMatcher: '$gcc'
	};
}

async function configureLaunchConfiguration(folder: vscode.WorkspaceFolder): Promise<void> {
	const vscodeDirectory = vscode.Uri.joinPath(folder.uri, '.vscode');
	const launchUri = vscode.Uri.joinPath(vscodeDirectory, 'launch.json');
	await vscode.workspace.fs.createDirectory(vscodeDirectory);

	let contents = '';
	try {
		contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(launchUri));
	} catch {
		contents = '{\n\t"version": "0.2.0",\n\t"configurations": []\n}\n';
	}

	const errors: ParseError[] = [];
	const parsed = parse(contents, errors) as { configurations?: unknown } | undefined;
	if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
		throw new Error(`Cannot configure Cosmopolitan launch settings because ${launchUri.fsPath} contains invalid JSONC.`);
	}
	const existingConfigurations = Array.isArray(parsed.configurations) ? parsed.configurations : [];
	const configurations = existingConfigurations.filter((configuration) =>
		!configuration || typeof configuration !== 'object' || (configuration as { name?: string }).name !== WORKSPACE_LAUNCH_CONFIGURATION
	);
	configurations.push({
		name: WORKSPACE_LAUNCH_CONFIGURATION,
		type: 'cppdbg',
		request: 'launch',
		program: '${workspaceFolder}/${workspaceFolderBasename}.exe',
		args: [],
		stopAtEntry: false,
		cwd: '${workspaceFolder}',
		environment: [],
		externalConsole: false,
		MIMode: 'gdb',
		miDebuggerPath: '${config:cosmopolitan.debuggerPath}',
		preLaunchTask: WORKSPACE_BUILD_TASK_LABEL
	});

	const formattingOptions = { insertSpaces: true, tabSize: 2 };
	let edits = modify(contents, ['version'], '0.2.0', { formattingOptions });
	contents = applyEdits(contents, edits);
	edits = modify(contents, ['configurations'], configurations, { formattingOptions });
	contents = applyEdits(contents, edits);
	await vscode.workspace.fs.writeFile(launchUri, new TextEncoder().encode(contents));
}

