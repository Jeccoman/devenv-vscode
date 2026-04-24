# DevEnv VS Code Extension

This is the standalone VS Code extension for DevEnv.

## MVP features

- Scans `.nvmrc`, `.node-version`, `.python-version`, `package.json`, `pyproject.toml`, `devcontainer.json`, Dockerfiles, compose files, and GitHub Actions workflows
- Detects Node and Python drift across local setup, containers, and CI
- Surfaces drift warnings as diagnostics and quick fixes
- Shows environment health in the status bar
- Adds a DevEnv sidebar inspector for issues and detected signals
- Generates a starter `devenv.yaml`

## Commands

- `DevEnv: Scan Workspace`
- `DevEnv: Check Drift`
- `DevEnv: Generate devenv.yaml`
- `DevEnv: Fix Drift`

## Demo workspace

Open `demo-workspace` to test the extension against a repo with intentional Node, Python, container, and CI drift.

Expected behavior:

- the inspector shows multiple runtime conflicts
- diagnostics appear in version and config files
- quick fixes offer a one-click alignment path
- `DevEnv: Generate devenv.yaml` produces a canonical starter spec

## Development

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open `demo-workspace` or a repo with mixed Node or Python version declarations.
4. Use the DevEnv activity bar view to inspect issues and signals.
5. Run the DevEnv commands from the command palette or quick fixes.
6. Run `pnpm install`.
7. Run `pnpm package` to build a `.vsix`.

## Publishing

Use `PUBLISHING.md` for the Marketplace checklist and publish commands.
