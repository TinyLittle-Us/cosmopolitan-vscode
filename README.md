<img style="padding: 8px; border-radius: 8px; box-shadow: 2px 2px 8px #abc; background-color: #def;" alt="Cosmopolitan Honey Badger in Visual Studio Code" src="cosmopolitan-vscode-banner.webp"/>

# Cosmopolitan C/C++ for VS Code

This extension installs the Cosmopolitan `cosmocc` toolchain from the official `https://cosmo.zip/pub/cosmocc/cosmocc.zip` distribution into VS Code's extension storage. On Windows, it also downloads the POSIX shell and required Cosmos utilities from `https://cosmo.zip/pub/cosmos/bin/`, as required by Cosmopolitan's shell-script compiler drivers. It does not require administrator privileges or modify the system `PATH`.

On activation, it configures each open workspace folder's `.vscode/settings.json` with the Cosmopolitan compiler and C/C++ language standards. It adds single-file and workspace build tasks to `.vscode/tasks.json`, preserving unrelated settings and tasks. Run **Cosmopolitan: Launch Workspace** from the Command Palette to build all C/C++ sources and start the generated launch configuration. Run **Cosmopolitan: Install Toolchain and Configure Workspace** to retry setup at any time.

The first setup downloads a large archive (currently about 442 MB) and requires network access to `cosmo.zip`. Build tasks use `-g -O0` and retain debug symbols. The generated GDB launch configuration uses `gdb` by default; install a Windows-compatible GDB and set `cosmopolitan.debuggerPath` to its executable path if it is not on `PATH`. Cosmopolitan emits a `.dbg` sidecar for source-level debugging; complete sidecar-aware debugging remains a future integration step.

## Build the extension

```sh
npm install
npm run compile
npm run package
```

`npm run package` runs the VS Code extension packaging tool and creates a `.vsix` file in the project directory. It invokes the `vscode:prepublish` hook to compile the extension first.

## Note about the license

ISC is a short, permissive open-source license, similar in spirit to MIT. It allows people to use, modify, and redistribute the software, provided they retain the copyright and permission notice. It also disclaims warranties and liability.

To preserve FOSS, the ISC license of this extension matches the Cosmopolitan repository. However, this extension and the Cosmopolitan repository are not licensed by the same parties.

## References

- [Cosmopolitan README](https://github.com/jart/cosmopolitan)
- [Cosmopolitan compiler downloads](https://cosmo.zip/pub/cosmocc/)