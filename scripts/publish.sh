#!/bin/bash
# Publish the current version to the VS Code Marketplace with a Microsoft Entra ID login (no Azure DevOps PAT).
# One-time setup: `azd auth login --use-device-code` (Azure Developer CLI) with the account that owns the publisher.
# vsce's credential chain tries Azure CLI before the slow probes; scripts/azshim/az answers that step from azd.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/scripts/azshim:$HOME/.local/bin:$HOME/.local/node/bin:$PATH" AZD_COLLECT_TELEMETRY=no
npm run package
VSIX="$(node -p "const p=require('./package.json'); p.name + '-' + p.version + '.vsix'")"
npx vsce publish --azure-credential --packagePath "$VSIX"
