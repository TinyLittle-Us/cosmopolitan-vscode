import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

const DOWNLOAD_URL = 'https://cosmo.zip/pub/cosmocc/cosmocc.zip';
const COSMOS_BIN_URL = 'https://cosmo.zip/pub/cosmos/bin';
const INSTALL_DIRECTORY = 'cosmocc';
const INSTALL_MARKER = '.cosmopolitan-install.json';

interface WindowsShellTool {
	command: string;
	archive: string;
}

const WINDOWS_SHELL_TOOLS: WindowsShellTool[] = [
	{ command: 'dash', archive: 'dash' },
	{ command: 'cat', archive: 'cat' },
	{ command: 'mkdir', archive: 'mkdir.ape' },
	{ command: 'less', archive: 'less' },
	{ command: 'kill', archive: 'kill' },
	{ command: 'cp', archive: 'cp.ape' },
	{ command: 'mv', archive: 'mv.ape' },
	{ command: 'rm', archive: 'rm.ape' }
];

export interface CosmoccToolchain {
	root: string;
	cCompiler: string;
	cppCompiler: string;
	shell?: string;
}

interface InstallMarker {
	schema: number;
	url: string;
	cCompiler: string;
	cppCompiler: string;
	shell?: string;
}

interface ArchiveSymlink {
	path: string;
	target: string;
}

export async function ensureCosmocc(
	storagePath: string,
	report: (message: string) => void
): Promise<CosmoccToolchain> {
	const installPath = path.join(storagePath, INSTALL_DIRECTORY);
	const markerPath = path.join(installPath, INSTALL_MARKER);
	const cached = await readInstalledToolchain(installPath, markerPath);
	if (cached) {
		return cached;
	}

	await fs.promises.mkdir(storagePath, { recursive: true });
	const archivePath = path.join(storagePath, 'cosmocc.zip.part');
	const stagingPath = path.join(storagePath, 'cosmocc.installing');
	await fs.promises.rm(archivePath, { force: true });
	await fs.promises.rm(stagingPath, { recursive: true, force: true });

	try {
		report('Downloading cosmocc.zip from cosmo.zip');
		await download(DOWNLOAD_URL, archivePath, (bytes) => {
			report(`Downloaded ${(bytes / (1024 * 1024)).toFixed(0)} MB`);
		});

		report('Extracting Cosmopolitan');
		await fs.promises.mkdir(stagingPath, { recursive: true });
		const extractedFiles = await extractZip(archivePath, stagingPath);
		const cCompiler = findCompiler(extractedFiles, ['cosmocc', 'cosmocc.exe', 'unknown-unknown-cosmo-cc', 'x86_64-unknown-cosmo-cc.exe', 'x86_64-unknown-cosmo-cc']);
		const cppCompiler = findCompiler(extractedFiles, ['cosmoc++', 'cosmoc++.exe', 'unknown-unknown-cosmo-c++', 'x86_64-unknown-cosmo-c++.exe', 'x86_64-unknown-cosmo-c++']);
		if (!cCompiler || !cppCompiler) {
			throw new Error('The downloaded archive did not contain the expected cosmocc and cosmoc++ compiler drivers.');
		}
		const shell = process.platform === 'win32' ? await ensureWindowsShellTools(stagingPath, report) : undefined;

		const marker: InstallMarker = {
			schema: 2,
			url: DOWNLOAD_URL,
			cCompiler,
			cppCompiler,
			shell: shell ? path.relative(stagingPath, shell) : undefined
		};
		await fs.promises.writeFile(path.join(stagingPath, INSTALL_MARKER), JSON.stringify(marker, null, 2));
		await fs.promises.rm(installPath, { recursive: true, force: true });
		await fs.promises.rename(stagingPath, installPath);
		return {
			root: installPath,
			cCompiler: path.join(installPath, cCompiler),
			cppCompiler: path.join(installPath, cppCompiler),
			shell: shell ? path.join(installPath, path.relative(stagingPath, shell)) : undefined
		};
	} finally {
		await fs.promises.rm(archivePath, { force: true });
		await fs.promises.rm(stagingPath, { recursive: true, force: true });
	}
}

async function readInstalledToolchain(installPath: string, markerPath: string): Promise<CosmoccToolchain | undefined> {
	try {
		const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as InstallMarker;
		if (marker.schema !== 2 || marker.url !== DOWNLOAD_URL) {
			return undefined;
		}
		const cCompiler = path.join(installPath, marker.cCompiler);
		const cppCompiler = path.join(installPath, marker.cppCompiler);
		const shell = marker.shell ? path.join(installPath, marker.shell) : undefined;
		await Promise.all([
			fs.promises.access(cCompiler, fs.constants.X_OK),
			fs.promises.access(cppCompiler, fs.constants.X_OK),
			...(process.platform === 'win32' && shell ? [fs.promises.access(shell, fs.constants.X_OK)] : [])
		]);
		if (process.platform === 'win32' && !shell) {
			return undefined;
		}
		if (process.platform === 'win32') {
			await ensureWindowsShellTools(installPath, () => undefined);
		}
		return { root: installPath, cCompiler, cppCompiler, shell };
	} catch {
		return undefined;
	}
}

async function download(url: string, destination: string, onProgress: (bytes: number) => void, redirects = 0): Promise<void> {
	if (redirects > 5) {
		throw new Error('Too many redirects while downloading Cosmopolitan.');
	}
	await new Promise<void>((resolve, reject) => {
		const request = https.get(url, (response) => {
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume();
				const redirectedUrl = new URL(response.headers.location, url).toString();
				void download(redirectedUrl, destination, onProgress, redirects + 1).then(resolve, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Cosmopolitan download failed with HTTP ${response.statusCode ?? 'unknown'}.`));
				return;
			}

			let downloaded = 0;
			response.on('data', (chunk: Buffer) => {
				downloaded += chunk.length;
				onProgress(downloaded);
			});
			const output = fs.createWriteStream(destination);
			void pipeline(response, output).then(resolve, reject);
		});
		request.on('error', reject);
	});
}

async function extractZip(archivePath: string, destination: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		yauzl.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError, zipFile) => {
			if (openError || !zipFile) {
				reject(openError ?? new Error('Unable to open the Cosmopolitan archive.'));
				return;
			}

			const extractedFiles: string[] = [];
			const archiveSymlinks: ArchiveSymlink[] = [];
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				zipFile.close();
				reject(error);
			};

			zipFile.on('error', fail);
			zipFile.on('end', () => {
				if (!settled) {
					void materializeArchiveSymlinks(archiveSymlinks, destination).then((symlinkFiles) => {
						if (!settled) {
							settled = true;
							zipFile.close();
							resolve([...extractedFiles, ...symlinkFiles]);
						}
					}).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
				}
			});
			zipFile.on('entry', (entry) => {
				void (async () => {
					const relativeName = entry.fileName.replace(/\\/g, '/');
					const segments = relativeName.split('/');
					if (relativeName.startsWith('/') || segments.some((segment: string | string[]) => segment === '..' || segment.includes(':'))) {
						throw new Error(`Unsafe path in Cosmopolitan archive: ${entry.fileName}`);
					}
					const targetPath = path.resolve(destination, ...segments);
					if (path.relative(destination, targetPath).startsWith('..')) {
						throw new Error(`Unsafe path in Cosmopolitan archive: ${entry.fileName}`);
					}
					const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
					if ((unixMode & 0o170000) === 0o120000) {
						archiveSymlinks.push({ path: relativeName, target: await readSymlinkTarget(zipFile, entry) });
						zipFile.readEntry();
						return;
					}
					if (relativeName.endsWith('/')) {
						await fs.promises.mkdir(targetPath, { recursive: true });
					} else {
						await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
						await new Promise<void>((streamResolve, streamReject) => {
							zipFile.openReadStream(entry, (streamError, readStream) => {
								if (streamError || !readStream) {
									streamReject(streamError ?? new Error(`Unable to extract ${entry.fileName}.`));
									return;
								}
								const writeStream = fs.createWriteStream(targetPath, { flags: 'w' });
								void pipeline(readStream, writeStream).then(streamResolve, streamReject);
							});
						});
						if (unixMode & 0o111) {
							await fs.promises.chmod(targetPath, unixMode & 0o777);
						}
						extractedFiles.push(relativeName);
					}
					zipFile.readEntry();
				})().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
			});
			zipFile.readEntry();
		});
	});
}

async function readSymlinkTarget(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
	return new Promise((resolve, reject) => {
		zipFile.openReadStream(entry, (error, stream) => {
			if (error || !stream) {
				reject(error ?? new Error(`Unable to read symlink ${entry.fileName} from the archive.`));
				return;
			}
			const chunks: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
	});
}

async function materializeArchiveSymlinks(links: ArchiveSymlink[], destination: string): Promise<string[]> {
	const linksByPath = new Map<string, string>();
	for (const link of links) {
		const linkPath = path.resolve(destination, link.path);
		const targetPath = path.resolve(path.dirname(linkPath), link.target);
		if (!isWithinDirectory(destination, linkPath) || !isWithinDirectory(destination, targetPath)) {
			throw new Error(`Unsafe symlink in Cosmopolitan archive: ${link.path}`);
		}
		linksByPath.set(linkPath, targetPath);
	}

	const materialized: string[] = [];
	for (const [linkPath, targetPath] of linksByPath) {
		if (await copyArchiveLink(linkPath, targetPath, linksByPath, new Set())) {
			materialized.push(path.relative(destination, linkPath).split(path.sep).join('/'));
		}
	}
	return materialized;
}

async function copyArchiveLink(
	linkPath: string,
	targetPath: string,
	linksByPath: Map<string, string>,
	resolving: Set<string>
): Promise<boolean> {
	if (resolving.has(linkPath)) {
		throw new Error(`Cyclic symlink in Cosmopolitan archive: ${linkPath}`);
	}
	resolving.add(linkPath);
	try {
		try {
			await fs.promises.access(targetPath);
		} catch {
			const chainedTarget = linksByPath.get(targetPath);
			if (!chainedTarget || !await copyArchiveLink(targetPath, chainedTarget, linksByPath, resolving)) {
				return false;
			}
		}
		const targetStats = await fs.promises.stat(targetPath);
		await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
		if (targetStats.isDirectory()) {
			await fs.promises.cp(targetPath, linkPath, { recursive: true, force: true, dereference: true });
		} else {
			await fs.promises.copyFile(targetPath, linkPath);
			if (process.platform !== 'win32') {
				await fs.promises.chmod(linkPath, targetStats.mode & 0o777);
			}
		}
		return true;
	} finally {
		resolving.delete(linkPath);
	}
}

function isWithinDirectory(root: string, candidate: string): boolean {
	const relativePath = path.relative(root, candidate);
	return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function findCompiler(files: string[], names: string[]): string | undefined {
	for (const name of names) {
		const match = files.find((file) => path.posix.basename(file).toLowerCase() === name.toLowerCase());
		if (match) {
			return match;
		}
	}
	return undefined;
}

async function ensureWindowsShellTools(toolchainPath: string, report: (message: string) => void): Promise<string> {
	const binPath = path.join(toolchainPath, 'bin');
	await fs.promises.mkdir(binPath, { recursive: true });
	for (const tool of WINDOWS_SHELL_TOOLS) {
		const commandPath = path.join(binPath, tool.command);
		const executablePath = `${commandPath}.exe`;
		if (!await pathExists(commandPath)) {
			report(`Installing Windows shell support: ${tool.command}`);
			if (await pathExists(executablePath)) {
				await fs.promises.copyFile(executablePath, commandPath);
			} else {
				await download(`${COSMOS_BIN_URL}/${tool.archive}`, commandPath, () => undefined);
			}
		}
		if (!await pathExists(executablePath)) {
			await fs.promises.copyFile(commandPath, executablePath);
		}
	}
	const shellPath = path.join(binPath, 'dash.exe');
	const dashPath = path.join(binPath, 'dash');
	const shPath = path.join(binPath, 'sh');
	const shExecutablePath = path.join(binPath, 'sh.exe');
	if (!await pathExists(shPath)) {
		await fs.promises.copyFile(dashPath, shPath);
	}
	if (!await pathExists(shExecutablePath)) {
		await fs.promises.copyFile(shellPath, shExecutablePath);
	}
	return shellPath;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}