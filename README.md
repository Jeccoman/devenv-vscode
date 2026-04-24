# DevEnv VS Code Extension

Detect environment drift in a repository before it turns into setup churn, broken onboarding, or CI surprises.

DevEnv scans common runtime and container files, highlights mismatches inside VS Code, and helps you generate a starter `devenv.yaml`.

## What it does

- Scans `.nvmrc`, `.node-version`, `.python-version`, `package.json`, `pyproject.toml`, `devcontainer.json`, Dockerfiles, compose files, and GitHub Actions workflows
- Detects Node and Python drift across local setup, containers, and CI
- Surfaces drift warnings as diagnostics and quick fixes
- Shows environment health in the status bar
- Adds a DevEnv sidebar inspector for issues and detected signals
- Generates a starter `devenv.yaml`

## Install

Install from the VS Code Marketplace when published, or install the packaged `.vsix` locally.

```bash
pnpm install
pnpm package
```

Then in VS Code, run `Extensions: Install from VSIX...` and choose the generated file.

## Commands

- `DevEnv: Scan Workspace`
- `DevEnv: Check Drift`
- `DevEnv: Generate devenv.yaml`
- `DevEnv: Fix Drift`

## Try it locally

Open `demo-workspace` to test the extension against a repo with intentional Node, Python, container, and CI drift.

Expected behavior:

- the inspector shows multiple runtime conflicts
- diagnostics appear in version and config files
- quick fixes offer a one-click alignment path
- `DevEnv: Generate devenv.yaml` produces a canonical starter spec

## Use it

1. Open a repository in VS Code.
2. Run `DevEnv: Scan Workspace`.
3. Review issues in diagnostics, the status bar, and the DevEnv inspector.
4. Run `DevEnv: Fix Drift` or apply quick fixes where available.
5. Run `DevEnv: Generate devenv.yaml` to create a starter environment contract.

## Develop

1. Open this folder in VS Code.
2. Run `pnpm install`.
3. Press `F5` to launch an Extension Development Host.
4. Open `demo-workspace` or another repo with mixed runtime declarations.
