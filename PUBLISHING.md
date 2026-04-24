# Publishing DevEnv To The VS Code Marketplace

## Before you publish

1. Create or confirm the Marketplace publisher account that matches the `publisher` field in `package.json`.
2. Make sure the version in `package.json` is higher than the last published version.
3. Verify the extension icon and README look right in the packaged output.
4. Run the local checks:

```bash
pnpm install
pnpm check
pnpm publish:precheck
pnpm package
```

## Publish

Authenticate `vsce` with a Visual Studio Marketplace personal access token that has Marketplace publish permissions, then run:

```bash
pnpm publish:marketplace
```

For a pre-release publish:

```bash
pnpm package:pre-release
```

## What to verify after publishing

- Marketplace listing shows the correct icon and README
- Commands appear in the Command Palette
- The DevEnv activity bar icon and inspector render correctly
- `demo-workspace` still reproduces drift warnings in an Extension Development Host
