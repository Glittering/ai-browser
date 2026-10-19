#!/usr/bin/env node
// bin/ai-browser.cjs — package entry point.
//
//   ai-browser            launch the visible browser window (foreground)
//   ai-browser start      same
//   ai-browser mcp        run the MCP stdio server (used by MCP clients)
//   ai-browser skill      list / install bundled agent skills
//   ai-browser --version
//   ai-browser --help
//
// This file is CommonJS on purpose: bins run under whatever Node the user has,
// and the MCP server itself is ESM — loaded via dynamic import below.
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const pkg = require('../package.json');

const HELP = `ai-browser ${pkg.version}

Usage:
  ai-browser [start]          Launch the visible AI Browser window
  ai-browser mcp              Run the MCP stdio server (20 browse_* tools)
  ai-browser skill [list|install|print]
                              Install the bundled agent skills into your client
  ai-browser --version        Print version
  ai-browser --help           Show this help

The browser exposes:
  • MCP server over stdio (this command's "mcp" subcommand)
  • Raw WebSocket JSON-RPC on ws://localhost:9223 (ui.* methods)

Agent skills ship in this package. Install them once with "ai-browser skill install"
and every new session picks them up automatically — no manual instruction pasting.

Docs: https://github.com/Glittering/ai-browser
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'start';

  switch (command) {
    case 'start':
    case 'gui': {
      // Foreground GUI launch; exit code is forwarded inside the launcher.
      const { launchElectron } = require('../scripts/start.cjs');
      const child = launchElectron();
      child.on('exit', (code, signal) => {
        process.exit(code === null && signal ? 1 : (code ?? 0));
      });
      child.on('error', (e) => {
        console.error('[ai-browser] failed to launch Electron:', e.message);
        process.exit(1);
      });
      break;
    }
    case 'mcp': {
      // Importing the module starts the stdio server (its main() runs on load).
      const serverPath = path.join(__dirname, '..', 'src', 'main', 'mcp_server.js');
      await import(pathToFileURL(serverPath).href);
      break;
    }
    case 'skill': {
      // 技能装进客户端的技能目录 —— 装一次，之后每次新会话自动发现。
      const { run } = require('../scripts/skill.cjs');
      process.exit(run(argv.slice(1)));
      break;
    }
    case '--version':
    case '-v':
    case 'version':
      console.log(pkg.version);
      break;
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      process.stdout.write(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('[ai-browser]', err && err.stack ? err.stack : err);
  process.exit(1);
});
