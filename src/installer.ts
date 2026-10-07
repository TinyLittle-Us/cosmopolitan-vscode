import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

const DOWNLOAD_URL = 'https://cosmo.zip/pub/cosmocc/cosmocc.zip';
const COSMOS_BIN_URL = 'https://cosmo.zip/pub/cosmos/bin';
const INSTALL_DIRECTORY = 'cosmocc';
const INSTALL_MARKER = '.cosmopolitan-install.json';
const WINDOWS_SHELL_TOOLS = [
	{ command: 'dash', archive: 'dash' },
	{ command: 'cat', archive: 'cat' },
	{ command: 'mkdir', archive: 'mkdir.ape' },
	{ command: 'less', archive: 'less' },
	{ command: 'kill', archive: 'kill' },
	{ command: 'cp', archive: 'cp.ape' },
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
		const cCompiler = findCompiler(extractedFiles, ['cosmocc', 'cosmocc.exe', 'x86_64-unknown-cosmo-cc.exe', 'x86_64-unknown-cosmo-cc']);
		const cppCompiler = findCompiler(extractedFiles, ['cosmoc++', 'cosmoc++.exe', 'x86_64-unknown-cosmo-c++.exe', 'x86_64-unknown-cosmo-c++']);
		if (!cCompiler || !cppCompiler) {
			throw new Error('The downloaded archive did not contain the expected cosmocc and cosmoc++ compiler drivers.');
		}
		const shell = process.platform === 'win32' ? await installWindowsShellTools(stagingPath, report) : undefined;

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
					settled = true;
					zipFile.close();
					resolve(extractedFiles);
				}
			});
			zipFile.on('entry', (entry) => {
				void (async () => {
					const relativeName = entry.fileName.replace(/\\/g, '/');
					const segments = relativeName.split('/');
					if (relativeName.startsWith('/') || segments.some((segment) => segment === '..' || segment.includes(':'))) {
						throw new Error(`Unsafe path in Cosmopolitan archive: ${entry.fileName}`);
					}
					const targetPath = path.resolve(destination, ...segments);
					if (path.relative(destination, targetPath).startsWith('..')) {
						throw new Error(`Unsafe path in Cosmopolitan archive: ${entry.fileName}`);
					}
					const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
					if ((unixMode & 0o170000) === 0o120000) {
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
								const writeStream = fs.createWriteStream(targetPath, { flags: 'wx' });
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

function findCompiler(files: string[], names: string[]): string | undefined {
	for (const name of names) {
		const match = files.find((file) => path.posix.basename(file).toLowerCase() === name.toLowerCase());
		if (match) {
			return match;
		}
	}
	return undefined;
}

async function installWindowsShellTools(stagingPath: string, report: (message: string) => void): Promise<string> {
	const binPath = path.join(stagingPath, 'bin');
	await fs.promises.mkdir(binPath, { recursive: true });
	for (const tool of WINDOWS_SHELL_TOOLS) {
		report(`Installing Windows shell support: ${tool.command}`);
		await download(`${COSMOS_BIN_URL}/${tool.archive}`, path.join(binPath, `${tool.command}.exe`), () => undefined);
	}
	const shellPath = path.join(binPath, 'dash.exe');
	await fs.promises.copyFile(shellPath, path.join(binPath, 'sh.exe'));
	return shellPath;
}