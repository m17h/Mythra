# Vibe Coding App Architecture

## Product Goal

Build a desktop AI coding app with:

- local-model support through LM Studio running as a server on a user-provided host/IP
- hosted-model support through OpenRouter
- file editing, chat, terminal access, and tool execution
- explicit tool permissions and workspace-scoped safety controls
- a polished, animated, pixel-art-influenced interface rather than a generic SaaS UI

## Recommended Stack

### Version 1

- Desktop shell: Electron
- App language: TypeScript end-to-end
- Frontend: React + Vite
- State: Zustand
- Styling: Tailwind CSS + CSS variables + hand-authored component styles
- Motion: Framer Motion
- Editor: Monaco Editor
- Terminal: xterm.js + node-pty
- Local persistence: SQLite via `better-sqlite3`
- Validation: Zod
- Logging: Pino
- Testing: Vitest + Playwright

### Why this stack

Electron is the right first choice for this product because the app needs:

- deep filesystem access
- long-running child processes
- PTY-backed terminal sessions
- git and shell integration
- streaming AI responses
- desktop packaging without fighting the platform

Tauri is a strong option later if bundle size becomes a primary goal, but it adds Rust to the critical path and slows down a solo-builder version 1 for a tool-heavy IDE product.

## Model Layer

Use a single provider abstraction with two adapters:

### 1. LM Studio adapter

- uses the OpenAI-compatible API
- user supplies host, port, and model identifier
- example base URL: `http://localhost:1234/v1`
- supports chat, streaming, and tool calls through the OpenAI-compatible surface

### 2. OpenRouter adapter

- uses `https://openrouter.ai/api/v1`
- supports OpenAI-style request shapes
- supports tools, `tool_choice`, and parallel tool calls

### Implementation rule

Use the official `openai` JavaScript SDK as the transport layer for both adapters. For LM Studio, swap `baseURL` to the local server. For OpenRouter, swap `baseURL` and API key. That keeps the app’s chat and tool pipeline unified.

## Core App Architecture

### Processes

#### Renderer process

- React UI
- file tree
- editor tabs
- chat panel
- tool approval modals
- settings and theme editor

#### Main process

- app lifecycle
- filesystem access
- secure credential handling
- spawning git, ripgrep, and shell commands
- PTY management
- IPC boundary enforcement

#### Worker or utility processes

- background indexing
- long-running agent loops
- search jobs
- diff generation
- embedding or RAG work later if needed

## Major Modules

### 1. Workspace module

- open local folders
- watch file changes with `chokidar`
- search files with `rg`
- read and write files through a permission-aware backend
- maintain recent workspaces and pinned projects

### 2. Chat and agent module

- conversation state
- streaming token rendering
- message attachments
- model presets
- prompt templates
- branchable chat threads
- abort, retry, and continue flows

### 3. Tool runtime

Build your own tool registry first.

Each tool should define:

- `id`
- `title`
- `description`
- `inputSchema`
- `requiresApproval`
- `run()`

Tool categories for version 1:

- read file
- write file
- search text
- list files
- run terminal command
- git status
- git diff
- apply patch

Then add MCP support as a second layer so the app can connect to MCP servers and surface external tools in the same permission UI.

### 4. Editor and diff module

- Monaco Editor for code editing
- Monaco Diff Editor for patch review
- inline decorations for AI edits
- staged accept or reject flows per hunk

### 5. Terminal module

- xterm.js in the UI
- `node-pty` in the backend
- one terminal per workspace or task
- command history, exit code, and active process status

### 6. Persistence module

Use SQLite tables for:

- workspaces
- chat sessions
- messages
- provider profiles
- model presets
- tool approvals
- command history
- theme definitions

Do not store raw provider secrets in plain text. Use OS credential storage or Electron safe storage for secrets and keep only profile metadata in SQLite.

## Tool Safety Model

This matters more than almost anything else.

Every tool execution should pass through:

1. workspace scope check
2. tool policy check
3. model request validation
4. user approval gate if required
5. execution
6. structured result logging

Recommended approval levels:

- always allow: read-only workspace tools
- ask every time: write, delete, terminal, network, git mutate
- blocked by default: global filesystem, arbitrary external network, privileged shell operations

## Visual Direction

### Visual thesis

Build an "arcade workstation" aesthetic: sharp pixel cues, luminous panels, dark atmospheric backgrounds, and precise motion, but with modern spacing and typography so it feels premium instead of gimmicky.

### Design rules

- use one dominant visual idea per screen
- keep the product workspace dense and calm, not card-heavy
- use pixel motifs as accents, not as the entire UI language
- make the editor and chat the heroes
- use lighting, glow, and depth instead of clutter

### Theme system

Use theme tokens in CSS variables:

- `--bg-0`, `--bg-1`, `--panel`
- `--text-0`, `--text-1`, `--muted`
- `--accent`, `--accent-2`, `--danger`
- `--glow-soft`, `--glow-hard`
- `--grid-color`, `--scanline-opacity`

Ship 3 themes at launch:

- Neon Grid: cyan, lime, deep navy
- Sunset Terminal: coral, amber, plum
- Ice Station: electric blue, mint, graphite

### Motion ideas

- panel lights easing in on app load
- soft scanline sweep during model streaming
- selected editor tab emitting a subtle glow pulse
- command execution causing a brief terminal bloom
- theme changes animating through token transitions instead of hard swaps

## Features To Skip In Version 1

Do not build these first:

- full VS Code extension compatibility
- remote container dev
- collaborative multiplayer editing
- full semantic code indexing across all languages
- complex agent swarms

Those are version 2 or 3 problems.

## Recommended Build Order

### Phase 1

- Electron shell
- React layout
- workspace open
- file tree
- Monaco editor
- SQLite setup
- theme system

### Phase 2

- provider settings
- LM Studio adapter
- OpenRouter adapter
- streaming chat UI
- message persistence

### Phase 3

- tool registry
- approval flow
- read and write tools
- terminal execution
- xterm.js panel

### Phase 4

- diff review UI
- git integration
- retry and continue flows
- model presets
- prompt library

### Phase 5

- MCP client support
- polish animations
- onboarding
- packaging and auto-updates

## Concrete Recommendation

If starting today, build version 1 with:

- Electron
- React
- TypeScript
- Vite
- Monaco
- xterm.js
- node-pty
- SQLite
- Zod
- Zustand
- Framer Motion

That gives you the fastest path to a serious coding product without overcomplicating the first build.

## Source Notes

- LM Studio documents OpenAI-compatible endpoints, including `POST /v1/chat/completions` and `POST /v1/responses`, and shows switching the base URL to the LM Studio host.
- LM Studio documents tool use through the OpenAI-compatible `tools` parameter.
- OpenRouter documents a unified API, OpenAI-compatible request shapes, and OpenAI SDK usage with `baseURL: "https://openrouter.ai/api/v1"`.
- OpenRouter documents `tools`, `tool_choice`, and `parallel_tool_calls`.
- Electron documents its main and renderer process model and the `utilityProcess` API for child processes with Node enabled.
- Tauri documents a smaller binary footprint and frontend flexibility, which makes it a valid later alternative if you decide bundle size matters more than speed of implementation.
