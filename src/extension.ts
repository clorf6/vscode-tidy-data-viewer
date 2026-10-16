import * as vscode from 'vscode';
import { registerSharedCommands } from './shared/openAs';
import { registerTableEditor } from './table/provider';
import { registerTreeEditor } from './tree/provider';
import { extendMarkdownIt } from './markdown/plugin';
import { registerMarkdownEditor } from './markdown/editor';

export function activate(ctx: vscode.ExtensionContext) {
  registerSharedCommands(ctx);
  registerTableEditor(ctx);
  registerTreeEditor(ctx);
  registerMarkdownEditor(ctx);
  // Picked up by the built-in Markdown preview (package.json "markdown.markdownItPlugins": true).
  return { extendMarkdownIt };
}

export function deactivate(): void {
  /* disposed via ctx.subscriptions */
}
