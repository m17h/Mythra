import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { applyChatModelOverride, formatOverrideLabel } from '@renderer/lib/apply-model-override';
import { AppConfirmDialog } from './components/AppConfirmDialog';
import { AppSelect } from './components/AppSelect';
import { ChatPanel } from './components/ChatPanel';
import { ChangesPanel } from './components/ChangesPanel';
import { EditorPanel } from './components/EditorPanel';
import { FileTree } from './components/FileTree';
import { ModelSearch } from './components/ModelSearch';
import { SettingsPanel } from './components/SettingsPanel';
import { SystemPromptInfoDialog } from './components/SystemPromptInfoDialog';
import { SystemPromptModal } from './components/SystemPromptModal';
import { WizardSettingsPanel } from './components/WizardSettingsPanel';
import { WizardExportDialog } from './components/WizardExportDialog';
import { WizardSetupModal } from './components/WizardSetupModal';
import { NexusSetupModal } from './components/NexusSetupModal';
import { NexusSettingsPanel } from './components/NexusSettingsPanel';
import { OnboardingDialog } from './components/OnboardingDialog';
import logoIce from '../../Images/logo_ice.png';
import logoKiwi from '../../Images/logo_kiwi.png';
import logoNeonGrid from '../../Images/onboarding_1-1.png';
import logoSunset from '../../Images/logo_sunset.png';
import {
  defaultSettings,
  type AppSettings,
  type ChatActivity,
  type ChatAttachment,
  type ChatMessage,
  type ChatModelOverride,
  type ChatCompletionTokenUsage,
  type ChatTimelineEntry,
  type ModelInfo,
  type NexusProject,
  type NexusSetupRequest,
  type OpenFile,
  type ProviderKind,
  type SessionMode,
  type SavedChat,
  type SavedChatMeta,
  type ToolApprovalRequest,
  type WizardDocument,
  type WizardProfile,
  type WizardPromptApprovalRequest,
  type WizardSetupRequest,
  type WorkspaceChanges,
  type WorkspaceNode
} from '@shared/types';
import { patchSystemPromptInSettings } from '@shared/patch-system-prompt';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';
import { isAllowedCustomThemeTokenKey, isLikelyLightCssBackground, type ThemeId } from '@shared/themes';

function sidebarBrandLogoSrc(themeId: ThemeId | undefined): string {
  switch (themeId) {
    case 'sunset-terminal':
      return logoSunset;
    case 'ice-station':
      return logoIce;
    case 'kiwi':
      return logoKiwi;
    case 'neon-grid':
    case 'custom':
    default:
      return logoNeonGrid;
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);
const pathLabel = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

/** POSIX relative path from workspace root when `absolutePath` is under it; otherwise basename. */
function workspaceRelativeDisplay(workspaceRoot: string, absolutePath: string): string {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = absolutePath.replace(/\\/g, '/');
  const prefix = `${root}/`;
  if (abs === root) return '';
  if (abs.startsWith(prefix)) return abs.slice(prefix.length);
  return pathLabel(absolutePath);
}

/** POSIX-oriented path helpers for the renderer (no `node:path`; Vite treats it as external here). */
function pathNormSlashes(p: string) {
  return p.replace(/\\/g, '/');
}
function pathDirnameFs(p: string): string {
  const n = pathNormSlashes(p).replace(/\/+$/, '');
  const idx = n.lastIndexOf('/');
  if (idx <= 0) return n.startsWith('/') ? '/' : n;
  return n.slice(0, idx);
}
function pathBasenameFs(p: string): string {
  const n = pathNormSlashes(p).replace(/\/+$/, '');
  const idx = n.lastIndexOf('/');
  return idx === -1 ? n : n.slice(idx + 1);
}
function pathJoinFs(a: string, b: string): string {
  const x = pathNormSlashes(a).replace(/\/+$/, '');
  const y = pathNormSlashes(b).replace(/^\/+/, '');
  if (!x) return y;
  if (!y) return x;
  return `${x}/${y}`;
}

/** Loose match for comparing filesystem roots across slash variants. */
const pathsEqual = (a: string, b: string) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '') === b.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Nexus sends must resolve each member's **private** Wizard folder for Markdown injection.
 * Chat-list meta can briefly or mistakenly mirror the Nexus shared `workspaceRoot`; prefer disk + reject shared-folder mistaken profiles.
 */
function resolveWizardProfileForNexusTeam(
  diskWizard: WizardProfile | undefined,
  metaWizard: WizardProfile | undefined,
  nexusSharedRoot: string
): WizardProfile | undefined {
  const trimmedShared = nexusSharedRoot.trim();
  const mistakenForShared = (w: WizardProfile | undefined) =>
    Boolean(trimmedShared && w?.workspaceRoot?.trim() && pathsEqual(w.workspaceRoot, trimmedShared));

  const ordered: Array<WizardProfile | undefined> = [diskWizard, metaWizard];
  for (const w of ordered) {
    if (!w?.workspaceRoot?.trim()) continue;
    if (mistakenForShared(w)) continue;
    return w;
  }
  return undefined;
}

/**
 * When `workspaceRoot` was mistakenly set to the Nexus shared folder, infer this Wizard's real folder:
 * walk parents of known Markdown paths until the basename matches the sanitized display name.
 */
function deriveWizardPrivateRootFromDocuments(profile: WizardProfile, mistakenRoot: string): string | undefined {
  if (!pathsEqual(profile.workspaceRoot, mistakenRoot)) return undefined;
  const seg = sanitizeWizardFolderSegment(profile.name);
  if (!seg) return undefined;
  const segLower = seg.toLowerCase();

  for (const d of profile.documents ?? []) {
    if (!d.path?.trim()) continue;
    let dir = pathDirnameFs(d.path);
    for (let depth = 0; depth < 16; depth++) {
      try {
        if (pathBasenameFs(dir).toLowerCase() === segLower) {
          return dir;
        }
      } catch {
        break;
      }
      const parent = pathDirnameFs(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** If profile points at the Nexus shared folder, try sibling `<parent>/<sanitized wizard name>/` or doc-derived roots. */
async function repairWizardWorkspaceRootIfNeeded(
  profile: WizardProfile,
  nexusSharedRoot: string
): Promise<WizardProfile> {
  const shared = nexusSharedRoot.trim();
  if (!shared || !pathsEqual(profile.workspaceRoot, shared)) {
    return profile;
  }

  const sibling = pathJoinFs(pathDirnameFs(shared), sanitizeWizardFolderSegment(profile.name));
  const candidates = [deriveWizardPrivateRootFromDocuments(profile, shared), sibling].filter(
    (c): c is string => Boolean(c?.trim())
  );

  const tried = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!key || tried.has(key)) continue;
    tried.add(key);
    if (pathsEqual(key, shared)) continue;
    try {
      await window.electronAPI.listWizardDocuments(candidate);
      return { ...profile, workspaceRoot: candidate };
    } catch {
      /* folder missing or unreadable */
    }
  }
  return profile;
}

/** Remap absolute paths that lived under oldRoot to newRoot (same relative suffix). */
function workspaceAbsolutePathPrefixRemap(oldRoot: string, newRoot: string) {
  const norm = (s: string) => s.replace(/\\/g, '/');
  const oldBase = norm(oldRoot).replace(/\/+$/, '');
  const newBase = norm(newRoot).replace(/\/+$/, '');
  const oldLen = oldBase.length;
  return (p: string) => {
    const pn = norm(p);
    const prefix = `${oldBase}/`;
    if (pn === oldBase || pn.startsWith(prefix)) {
      const suffix = pn === oldBase ? '' : pn.slice(oldLen);
      return `${newBase}${suffix}`;
    }
    return p;
  };
}
const isEmbeddingModel = (modelId: string) => /embed|embedding/i.test(modelId);
const normalizeProviderBaseUrl = (kind: AppSettings['selectedProvider'], baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (kind !== 'lmstudio') return trimmed;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
};
const pickDefaultModel = (modelList: ModelInfo[], currentModel?: string) => {
  if (currentModel && modelList.some((m) => m.id === currentModel)) return currentModel;
  const preferred = modelList.find((m) => !isEmbeddingModel(m.id));
  return preferred?.id ?? modelList[0]?.id ?? '';
};

/** User stop/cancel excluded; detects typical fetch/socket errors when LM Studio (or upstream) disappears. */
const looksLikeProviderTransportError = (raw: string) => {
  if (raw === 'Request stopped.' || /\bstopped by user\b/i.test(raw)) return false;
  const m = raw.toLowerCase();
  return (
    m.includes('econnrefused') ||
    m.includes('econnreset') ||
    m.includes('enotfound') ||
    m.includes('enetunreach') ||
    m.includes('etimedout') ||
    m.includes('socket hang up') ||
    m.includes('fetch failed') ||
    m.includes('failed to fetch') ||
    (m.includes('network') && m.includes('error')) ||
    m.includes('load failed')
  );
};

const LM_STUDIO_CATALOG_PROBE_MS = 35_000;

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];
const needsSearchApiKeyNotice = (settings: AppSettings) => {
  if (settings.search.provider === 'duckduckgo') return false;
  const hasAny =
    settings.search.tavilyApiKey.trim().length > 0 || settings.search.braveApiKey.trim().length > 0;
  return !hasAny;
};

const chatTitle = (messages: ChatMessage[]) => {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New Chat';
  const text = first.content.trim();
  return text.length > 48 ? `${text.slice(0, 48)}...` : text || 'New Chat';
};

const resolveChatTitle = (messages: ChatMessage[], titleOverride: string | null | undefined) => {
  const t = titleOverride?.trim();
  if (t) return t;
  return chatTitle(messages);
};

const sessionTitle = (messages: ChatMessage[], fallback = 'New session') => {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return fallback;
  const text = first.content.trim();
  return text.length > 42 ? `${text.slice(0, 42)}...` : text || fallback;
};

const buildWizardSystemPrompt = (wizard: WizardProfile) => {
  const outsideOn = Boolean(wizard.allowOutsideWorkspace);
  const pathRules = outsideOn
    ? `- Path-based file tools may read/write/delete/rename/outline targets outside this folder using ../ or absolute local paths when needed (cloud-sync folders stay blocked). list_files, workspace search, apply_patch, git diff, and shell commands still run only under: ${wizard.workspaceRoot}`
    : `- Path-based file tools stay inside your workspace folder (${wizard.workspaceRoot}) unless the user enables **Allow paths outside workspace** in Inspector → Wizard settings. If they ask you to edit or read arbitrary paths or another Wizard’s folder, explain this limit and tell them they can turn that setting on—or copy files here, export/import a bundle, switch Wizards, or paste content.`;

  return `${wizard.systemPrompt}

Mythra Wizard runtime:
- You are currently associated with your private Wizard workspace: ${wizard.workspaceRoot}
${pathRules}
- At the start of every message in a session, Mythra injects the current contents of every \`.md\` file in your workspace (below your system prompt). Core docs are listed first; read or re-read specific files with tools if the user edits them mid-chat.
- When asked about your identity, memory, tools, corrections, or other workspace Markdown, prefer those files—they may appear in the injected block or only on disk.
- Do not use app theme tools unless the user explicitly asks to change Mythra's visual theme.`;
};

const buildNexusSystemPrompt = (leader: WizardProfile, nexus: NexusProject, teamNames: string[]) => {
  const missionTrimmed = nexus.mission.trim();
  const missionLines = missionTrimmed
    ? `Nexus project mission (from project settings — treat as authoritative unless the user explicitly changes goals in chat):\n${missionTrimmed}`
    : `Nexus project mission is not set yet. Ask the user what this project should accomplish, or they can define it under Inspector → Settings → Nexus.`;

  const collab =
    nexus.parallelWizardResponses === true
      ? '- **Parallel Nexus:** When Mythra runs multiple teammate streams on one message, everyone answers concurrently—you cannot rely on seeing drafts first. Coordinate explicitly in writing (ownership, sequencing, WAITING/BLOCKED).\n'
      : '- **Relay Nexus:** Teammates answer **one stream at a time** in a single combined assistant message; they can read earlier segments before speaking. End a round with `[NEXUS_END]` when the Nexus is done with this user message, or `[NEXUS_CONTINUE]` to hand off another turn.\n';

  return `${leader.systemPrompt}

Mythra Nexus runtime:
- You are the leader Wizard for Nexus project "${nexus.name}".
- ${missionLines}
- The shared project workspace for all file tools is: ${nexus.workspaceRoot}
- Your private Wizard documents and every teammate's private Wizard documents are injected as read-only context. Use them to understand each Wizard's identity, strengths, memory, and corrections.
- The team is: ${teamNames.join(', ')}.
${collab}- Start by making a concise plan. Delegate tasks to specific Wizards by name when useful, and explain why.
- **Leader coordination:** Assign owners by name and file/path scope where helpful. When work must pause until another Wizard finishes something, say clearly **WAITING ON [Wizard]:** reason so teammates idle correctly or pick alternate tasks you assign. When independent tracks can proceed safely (different files / non-overlapping scope), say **PARALLEL OK** for those tracks.
- If a teammate's injected docs suggest they are better suited for a task, adjust assignments and say so.
- Treat this as a collaborative project room: include short messages addressed to teammates, task assignments, status updates, and a clear next action.
- Only edit files in the shared Nexus workspace unless the user explicitly asks you to update a Wizard's private docs in a separate Wizard session.`;
};

const buildNexusResponderSystemPrompt = (
  wizard: WizardProfile,
  nexus: NexusProject,
  teamNames: string[],
  role: 'leader' | 'member',
  conversationMode: 'parallel' | 'relay'
) => {
  const missionTrimmed = nexus.mission.trim();
  const missionLines = missionTrimmed
    ? `Nexus project mission (from project settings):\n${missionTrimmed}`
    : `No Nexus mission text is configured yet — ask the user for project goals if you need direction.`;

  const parallelLeader =
    '- **Parallel Nexus:** Mythra runs **one concurrent model stream per Wizard** on each user message (two or more teammates). Everyone replies **at the same time**—you cannot see teammate drafts until their messages appear.\n' +
    '- **Your leader responsibilities:** Assign tasks by Wizard name with ownership (who touches which areas/files when possible). When something must wait on another Wizard\'s deliverable, say **WAITING ON [Wizard]:** reason so nobody guesses whether to idle. Delegate alternate tasks so teammates aren\'t blocked unnecessarily. When tracks are independent and safe to overlap, say **PARALLEL OK** for those tracks.\n';

  const parallelMember =
    '- **Parallel Nexus:** Mythra runs **one concurrent stream per Wizard** on each message—assume teammates answer **simultaneously** and you usually cannot see their reply yet.\n' +
    '- **Follow the Nexus leader\'s routing.** If your task depends on another Wizard\'s output, write **WAITING ON [Wizard]:** what you need—avoid duplicating their work. If you have parallel-ready work (leader said PARALLEL OK or it\'s clearly disjoint files/tools), execute without blocking.\n';

  const relayLeader =
    '- **Relay Nexus:** Mythra streams **one Wizard at a time** per user message inside this combined assistant reply. Read segments above before you speak—you can respond to teammates and ask clarifying questions.\n' +
    '- The user may send follow-up lines while another teammate is still streaming; those messages appear before your next turn—read them and coordinate (for example the leader can check whether someone is stuck).\n' +
    '- When another teammate should speak next on this user message, end with `[NEXUS_CONTINUE]` alone on its own last line. When the Nexus should stop discussing this user message, end with `[NEXUS_END]` alone on its own last line.\n' +
    '- When the user calls someone out **by Wizard display name** (or `@ThatName`) in a queued mid-relay message, Mythra usually routes the **next** stream to that teammate—reply directly if it was you.\n';

  const relayMember =
    '- **Relay Nexus:** You speak after earlier teammate segments in this same assistant reply—read them before answering.\n' +
    '- The user may interrupt with new chat lines while someone else is streaming; those lines appear before your next turn—answer them explicitly when they mention you or the situation.\n' +
    '- If the user addresses you **by name** or `@yourName`, treat that as your cue to respond next even when others were busy.\n' +
    '- Ask teammates questions when helpful. Use `[NEXUS_CONTINUE]` alone on its own last line if more discussion is needed; use `[NEXUS_END]` alone on its own last line when you believe this user message is fully addressed.\n';

  const modeLeader = conversationMode === 'parallel' ? parallelLeader : relayLeader;
  const modeMember = conversationMode === 'parallel' ? parallelMember : relayMember;

  return `${wizard.systemPrompt}

Mythra Nexus runtime:
- You are ${wizard.name}, responding directly inside Nexus project "${nexus.name}".
- Your Nexus role is: ${role === 'leader' ? 'leader' : 'team member'}.
- ${missionLines}
- The shared project workspace for all file tools is: ${nexus.workspaceRoot}
- Your private Wizard documents and every teammate's private Wizard documents are injected as read-only context. Use them to understand identity, strengths, memory, and corrections.
- The team is: ${teamNames.join(', ')}.
${role === 'leader' ? modeLeader : modeMember}
- Answer as yourself, in first person, and focus on the user's latest request.
- Prefer splitting files/paths across teammates when parallelizing so simultaneous edits collide less often.
- If another Wizard is better suited for part of the work, say so clearly and suggest how to split it.
- Only edit files in the shared Nexus workspace unless the user explicitly asks you to update your private docs in a separate Wizard session.`;
};

interface WizardDocsContextResult {
  message: ChatMessage | null;
  loaded: Array<{ name: string; ok: boolean }>;
}

const buildWizardDocsContext = async (wizard: WizardProfile): Promise<WizardDocsContextResult> => {
  let docs: WizardDocument[];
  try {
    docs = await window.electronAPI.listWizardDocuments(wizard.workspaceRoot);
  } catch {
    return { message: null, loaded: [] };
  }

  const mdDocs = docs.filter((doc) => /\.md$/i.test(doc.path));
  if (mdDocs.length === 0) return { message: null, loaded: [] };

  const loaded: Array<{ name: string; ok: boolean }> = [];
  const parts = await Promise.all(
    mdDocs.map(async (doc) => {
      const displayPath =
        workspaceRelativeDisplay(wizard.workspaceRoot, doc.path) || doc.label || pathLabel(doc.path);
      try {
        const file = await window.electronAPI.readWizardDocument(wizard.workspaceRoot, doc.path);
        loaded.push({ name: displayPath, ok: true });
        return `## ${displayPath}\n${file.content}`;
      } catch {
        loaded.push({ name: displayPath, ok: false });
        return `## ${displayPath}\n[Could not read this document.]`;
      }
    })
  );
  return {
    loaded,
    message: {
      id: `wizard-docs-${Date.now()}`,
      role: 'system',
      content: [
        'Wizard Markdown workspace documents are injected below (every .md file Mythra could find under this workspace). Treat them as current private context; use read_file if something may have changed since this injection.',
        ...parts
      ].join('\n\n'),
      status: 'done'
    }
  };
};

const buildNexusDocsContext = async (
  team: Array<{ id: string; wizard: WizardProfile; role: 'leader' | 'member' }>
): Promise<WizardDocsContextResult> => {
  const loaded: Array<{ name: string; ok: boolean }> = [];
  const parts: string[] = [];
  for (const member of team) {
    const result = await buildWizardDocsContext(member.wizard);
    loaded.push(
      ...result.loaded.map((doc) => ({
        name: `${member.wizard.name}/${doc.name}`,
        ok: doc.ok
      }))
    );
    if (result.message) {
      parts.push(`## ${member.role === 'leader' ? 'Leader' : 'Member'}: ${member.wizard.name}\n${result.message.content}`);
    }
  }
  if (parts.length === 0) return { message: null, loaded };
  return {
    loaded,
    message: {
      id: `nexus-docs-${Date.now()}`,
      role: 'system',
      content: [
        'Nexus team private Wizard Markdown documents are injected below as read-only context. Use them to coordinate role fit, memory, style, and corrections while doing project work only in the shared Nexus workspace.',
        ...parts
      ].join('\n\n'),
      status: 'done'
    }
  };
};

type DiffLineKind = 'same' | 'add' | 'remove';

const diffPromptLines = (before: string, after: string) => {
  const a = (before || '[empty]').split('\n');
  const b = (after || '[empty]').split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const left: Array<{ text: string; kind: DiffLineKind }> = [];
  const right: Array<{ text: string; kind: DiffLineKind }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      left.push({ text: a[i]!, kind: 'same' });
      right.push({ text: b[j]!, kind: 'same' });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      right.push({ text: b[j]!, kind: 'add' });
      j += 1;
    } else if (i < a.length) {
      left.push({ text: a[i]!, kind: 'remove' });
      i += 1;
    }
  }
  return { left, right };
};

const stripNexusRelayControlMarkers = (raw: string) =>
  raw.replace(/\[\s*NEXUS_(?:END|CONTINUE)\s*\]/gi, '').trimEnd();

const parseNexusRelayWantsEnd = (raw: string) => /\[\s*NEXUS_END\s*\]/i.test(raw);

const sortNexusTeamLeaderFirst = <T extends { id: string }>(team: T[], leaderWizardId: string) =>
  [...team].sort((a, b) => {
    if (a.id === leaderWizardId && b.id !== leaderWizardId) return -1;
    if (b.id === leaderWizardId && a.id !== leaderWizardId) return 1;
    return 0;
  });

/** Member row used in Nexus relay streams (subset of `nexusResponders` item). */
type NexusRelayResponder = { id: string; wizard: WizardProfile; role: 'leader' | 'member' };

function isWizardNameMentionedInText(displayName: string, haystack: string): boolean {
  const name = displayName.trim();
  if (name.length < 2) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = haystack.trim();
  if (!t) return false;
  if (new RegExp(`@${escaped}(?:\\s|$|[,:;.!?])`, 'i').test(t)) return true;
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(t);
}

/**
 * When the user queued messages mid-relay (often calling someone out), route the next stream to that teammate
 * when exactly one Wizard display name matches; otherwise fall back to round-robin.
 */
function pickNexusRelaySpeakerForQueuedTurn(
  ordered: NexusRelayResponder[],
  roundRobinPick: NexusRelayResponder,
  queuedSlice: ChatMessage[]
): NexusRelayResponder {
  if (queuedSlice.length === 0) return roundRobinPick;
  const text = queuedSlice.map((m) => m.content ?? '').join('\n');
  if (!text.trim()) return roundRobinPick;

  const hits = ordered.filter((m) => isWizardNameMentionedInText(m.wizard.name, text));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    const lower = text.toLowerCase();
    let best = hits[0]!;
    let bestPos = Infinity;
    for (const m of hits) {
      const nm = m.wizard.name.trim().toLowerCase();
      const atIdx = lower.indexOf(`@${nm}`);
      const bareIdx = lower.indexOf(nm);
      const idx = atIdx !== -1 ? atIdx : bareIdx === -1 ? Infinity : bareIdx;
      if (idx < bestPos) {
        bestPos = idx;
        best = m;
      }
    }
    return best;
  }
  return roundRobinPick;
}

const chatFingerprint = (messages: ChatMessage[], timeline: ChatTimelineEntry[]) =>
  JSON.stringify({ messages, timeline });

const stripDuplicateNexusSpeakerLabel = (name: string, raw: string) => {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw.replace(new RegExp(`^\\s*${escaped}\\s*:\\s*`, 'i'), '').trim();
};

const formatNexusMultiResponseContent = (group: NexusMultiResponseGroup) =>
  group.responders
    .map(({ requestId, name }) => {
      const raw = group.contentByRequestId.get(requestId)?.trim() ?? '';
      const content = stripDuplicateNexusSpeakerLabel(name, raw);
      return `**${name}:**\n${content || 'Thinking...'}`;
    })
    .join('\n\n');

const formatNexusMultiResponseReasoning = (group: NexusMultiResponseGroup) =>
  group.responders
    .map(({ requestId, name }) => {
      const reasoning = group.reasoningByRequestId.get(requestId)?.trim();
      return reasoning ? `${name}:\n${reasoning}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

const formatRelativeDate = (ts: number) => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

interface FileBuffer extends OpenFile {
  dirty: boolean;
}

type InspectorTab = 'editor' | 'changes' | 'settings';
type SettingsInspectorScope = 'general' | 'wizard' | 'nexus';
type SidebarTab = 'chats' | 'wizards' | 'files';
type WizardsSidebarPane = 'wizards' | 'nexus';

interface InFlightChat {
  chatId: string;
  requestId: string;
  messages: ChatMessage[];
  timeline: ChatTimelineEntry[];
}

interface NexusMultiResponseGroup {
  chatId: string;
  messageId: string;
  requestIds: Set<string>;
  pending: Set<string>;
  responders: Array<{ requestId: string; name: string }>;
  messageIdByRequestId: Map<string, string>;
  contentByRequestId: Map<string, string>;
  reasoningByRequestId: Map<string, string>;
  timeline: ChatTimelineEntry[];
  /** When true, `chat:done` / `chat:error` must not finalize the parent Nexus bubble—the sequential orchestrator will. */
  suppressFinalizeUntilOrchestrator?: boolean;
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsStatus, setSettingsStatus] = useState('Load a provider profile, then refresh models.');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>();
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceNode[]>([]);
  const [buffers, setBuffers] = useState<Record<string, FileBuffer>>({});
  const buffersRef = useRef<Record<string, FileBuffer>>({});
  buffersRef.current = buffers;
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** Last reported token totals from an completed provider response (streaming include_usage). */
  const [lastTokenUsage, setLastTokenUsage] = useState<ChatCompletionTokenUsage | null>(null);
  /** After at least one model-catalog fetch (success or fail); used so we show "Disconnected" instead of "Waiting" only once we know. */
  const [modelCatalogSettled, setModelCatalogSettled] = useState(false);
  const [chatThreadBackgroundUrl, setChatThreadBackgroundUrl] = useState<string | null>(null);
  const chatThreadBackgroundUrlRef = useRef<string | null>(null);

  /** Latest values each render so send uses up-to-date system prompt, workspace, and active file (no new chat required). */
  const settingsRef = useRef<AppSettings | null>(null);
  const workspaceRootRef = useRef<string | undefined>(undefined);
  const activeFilePathRef = useRef<string | undefined>(undefined);
  const chatSessionIdRef = useRef<string>('');
  settingsRef.current = settings;
  workspaceRootRef.current = workspaceRoot;
  activeFilePathRef.current = activeFilePath;

  const sidebarBrandLogo = useMemo(() => sidebarBrandLogoSrc(settings?.ui.themeId), [settings?.ui.themeId]);

  /** New id on “New chat”; matches saved chat id when a thread is loaded — sent to the model as a fresh thread boundary. */
  const [chatSessionId, setChatSessionId] = useState(() => uid());
  chatSessionIdRef.current = chatSessionId;

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatTimeline, setChatTimeline] = useState<ChatTimelineEntry[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string>();
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const chatStreamingRef = useRef(false);

  const [activeChatId, setActiveChatId] = useState<string>();
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const inFlightChatsRef = useRef<Map<string, InFlightChat>>(new Map());
  const nexusMultiResponseGroupsRef = useRef<Map<string, NexusMultiResponseGroup>>(new Map());
  const finalizeNexusMultiResponseUiRef = useRef<(group: NexusMultiResponseGroup, usage?: ChatCompletionTokenUsage) => void>(
    () => {}
  );
  /** User messages typed during Nexus relay; injected before the next teammate stream. */
  const nexusQueuedUserTurnsRef = useRef<ChatMessage[]>([]);
  /** When true, composer accepts queued sends while relay streaming (sequential Nexus only). */
  const nexusRelayComposeUnlockedRef = useRef(false);
  /** Footer progress: who is streaming and since when (epoch ms). */
  const [nexusRelayProgress, setNexusRelayProgress] = useState<{ wizardName: string; segmentStartedAt: number } | null>(null);
  const [chatList, setChatList] = useState<SavedChatMeta[]>([]);
  /** Provider whose catalog to show in “This chat” model override (when enabled). */
  const [overrideModelProvider, setOverrideModelProvider] = useState<ProviderKind>('lmstudio');
  const [overrideModels, setOverrideModels] = useState<ModelInfo[]>([]);
  const [chatModelExpanded, setChatModelExpanded] = useState(false);
  /** Per-chat model override before the thread is saved (no activeChatId). Copied to disk on first send / persist. */
  const [newChatModelOverride, setNewChatModelOverride] = useState<ChatModelOverride | null>(null);
  const newChatModelOverrideRef = useRef<ChatModelOverride | null>(null);
  newChatModelOverrideRef.current = newChatModelOverride;
  chatStreamingRef.current = chatStreaming;

  const [inlineTerminalLogs, setInlineTerminalLogs] = useState('');
  const [inlineTerminalJobId, setInlineTerminalJobId] = useState<string>();
  const inlineTerminalJobIdRef = useRef<string | undefined>(undefined);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('settings');
  const [settingsInspectorScope, setSettingsInspectorScope] = useState<SettingsInspectorScope>('general');
  const settingsInspectorWizardIdRef = useRef<string | undefined>(undefined);
  const settingsInspectorNexusIdRef = useRef<string | undefined>(undefined);
  const lastInspectorTabRef = useRef<InspectorTab>(inspectorTab);
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChanges | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chats');
  const [wizardsSidebarPane, setWizardsSidebarPane] = useState<WizardsSidebarPane>('wizards');
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showWizardSetup, setShowWizardSetup] = useState(false);
  const [showNexusSetup, setShowNexusSetup] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showWebSearchNotice, setShowWebSearchNotice] = useState(false);
  const [showSystemPromptModal, setShowSystemPromptModal] = useState(false);
  const [showSystemPromptHelp, setShowSystemPromptHelp] = useState(false);
  const [showConnectionHelp, setShowConnectionHelp] = useState(false);
  const [searchSettingsFocusKey, setSearchSettingsFocusKey] = useState(0);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState('');
  const [wizardDraft, setWizardDraft] = useState<WizardProfile | null>(null);
  const [nexusDraft, setNexusDraft] = useState<NexusProject | null>(null);
  const [wizardExportChat, setWizardExportChat] = useState<SavedChatMeta | null>(null);
  const [wizardDeleteTarget, setWizardDeleteTarget] = useState<SavedChatMeta | null>(null);
  const [nexusDeleteTarget, setNexusDeleteTarget] = useState<SavedChatMeta | null>(null);
  const [wizardSessionDeleteTarget, setWizardSessionDeleteTarget] = useState<SavedChatMeta | null>(null);
  const [nexusSessionDeleteTarget, setNexusSessionDeleteTarget] = useState<SavedChatMeta | null>(null);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] = useState<{
    workspaceRoot: string;
    label: string;
    variant: 'wizard' | 'nexus';
  } | null>(null);
  const [wizardPromptApproval, setWizardPromptApproval] = useState<WizardPromptApprovalRequest | null>(null);
  const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [expandedWizardIds, setExpandedWizardIds] = useState<Set<string>>(new Set());
  const [expandedNexusIds, setExpandedNexusIds] = useState<Set<string>>(new Set());

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wizardAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nexusAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wizardDraftRef = useRef<WizardProfile | null>(null);
  const nexusDraftRef = useRef<NexusProject | null>(null);
  const lastContentFingerprintRef = useRef<string | null>(null);
  const skipNextRenameCommitRef = useRef(false);
  activeChatIdRef.current = activeChatId;
  activeRequestIdRef.current = activeRequestId;

  const findInFlightByChatId = (chatId: string | undefined) => {
    if (!chatId) return undefined;
    for (const item of inFlightChatsRef.current.values()) {
      if (item.chatId === chatId) return item;
    }
    return undefined;
  };

  const showInFlightIfActive = (snapshot: InFlightChat) => {
    if (activeChatIdRef.current !== snapshot.chatId) return;
    setChatMessages(snapshot.messages);
    setChatTimeline(snapshot.timeline);
    setChatStreaming(true);
    setActiveRequestId(snapshot.requestId);
  };

  const updateInFlightMessage = (requestId: string, recipe: (msg: ChatMessage) => ChatMessage) => {
    const snapshot = inFlightChatsRef.current.get(requestId);
    if (!snapshot) {
      setChatMessages((current) => current.map((m) => (m.id === requestId ? recipe(m) : m)));
      updateTimelineMessage(requestId, recipe);
      return undefined;
    }

    snapshot.messages = snapshot.messages.map((m) => (m.id === requestId ? recipe(m) : m));
    snapshot.timeline = snapshot.timeline.map((entry) =>
      entry.type === 'message' && entry.message.id === requestId
        ? { ...entry, message: recipe(entry.message) }
        : entry
    );
    showInFlightIfActive(snapshot);
    return snapshot;
  };

  /** Coalesce SSE chunks into one React refresh per animation frame — reduces Electron IPC/React churn vs per-token renders. */
  const streamFlushRafRef = useRef<number | null>(null);
  const streamPendingDeltaRef = useRef<Map<string, { text: string; reasoning: string }>>(new Map());
  const flushStreamingDeltaBufferRef = useRef<() => void>(() => {});

  flushStreamingDeltaBufferRef.current = () => {
    const map = streamPendingDeltaRef.current;
    if (map.size === 0) return;
    const entries = [...map.entries()];
    map.clear();
    for (const [requestId, { text, reasoning }] of entries) {
      if (!text && !reasoning) continue;
      updateInFlightMessage(requestId, (m) => ({
        ...m,
        content: text ? `${m.content}${text}` : m.content,
        reasoning: reasoning ? `${m.reasoning ?? ''}${reasoning}` : m.reasoning,
        status: 'streaming' as const
      }));
    }
  };

  const cancelStreamDeltaFlushAndFlushNow = () => {
    if (streamFlushRafRef.current != null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    flushStreamingDeltaBufferRef.current();
  };

  const appendActivity = (activity: ChatActivity) => {
    const nexusGroup = nexusMultiResponseGroupsRef.current.get(activity.requestId);
    const routedRequestId = nexusGroup?.messageIdByRequestId.get(activity.requestId) ?? nexusGroup?.messageId;
    const routedActivity = routedRequestId ? { ...activity, requestId: routedRequestId } : activity;
    const entry: ChatTimelineEntry = { id: `activity-${routedActivity.id}`, type: 'activity', activity: routedActivity };
    const snapshot = inFlightChatsRef.current.get(activity.requestId);
    const routedSnapshot = nexusGroup ? inFlightChatsRef.current.get(nexusGroup.messageId) : snapshot;
    if (routedSnapshot) {
      routedSnapshot.timeline = [...routedSnapshot.timeline, entry];
      showInFlightIfActive(routedSnapshot);
      return;
    }
    setChatTimeline((current) => [...current, entry]);
  };

  const updateTimelineMessage = (messageId: string, recipe: (msg: ChatMessage) => ChatMessage) => {
    setChatTimeline((current) =>
      current.map((entry) =>
        entry.type === 'message' && entry.message.id === messageId ? { ...entry, message: recipe(entry.message) } : entry
      )
    );
  };

  const addNexusMultiResponseMessage = (group: NexusMultiResponseGroup, requestId: string, name: string) => {
    const messageId = group.messageIdByRequestId.get(requestId) ?? requestId;
    group.messageIdByRequestId.set(requestId, messageId);
    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: 'Thinking...',
      status: 'streaming',
      assistantDisplayName: name
    };
    const entry: ChatTimelineEntry = { id: `message-${messageId}`, type: 'message', message };
    const snapshot = inFlightChatsRef.current.get(group.messageId);
    if (snapshot && !snapshot.messages.some((m) => m.id === messageId)) {
      snapshot.messages = [...snapshot.messages, message];
      snapshot.timeline = [...snapshot.timeline, entry];
      showInFlightIfActive(snapshot);
    }
  };

  const updateNexusMultiResponseMessage = (
    group: NexusMultiResponseGroup,
    status: ChatMessage['status'],
    requestIdFilter?: string
  ) => {
    const targetRequestIds = requestIdFilter ? new Set([requestIdFilter]) : group.requestIds;
    const responderByRequestId = new Map(group.responders.map((responder) => [responder.requestId, responder.name]));
    const recipe = (m: ChatMessage): ChatMessage => ({
      ...m
    });
    const snapshot = inFlightChatsRef.current.get(group.messageId);
    if (snapshot) {
      snapshot.messages = snapshot.messages.map((m) => {
        const requestId = [...targetRequestIds].find((rid) => group.messageIdByRequestId.get(rid) === m.id);
        if (!requestId) return m;
        const name = responderByRequestId.get(requestId) ?? m.assistantDisplayName ?? 'Wizard';
        const raw = group.contentByRequestId.get(requestId)?.trim() ?? '';
        const content = stripDuplicateNexusSpeakerLabel(name, raw);
        const reasoning = group.reasoningByRequestId.get(requestId)?.trim() || undefined;
        return {
          ...recipe(m),
          content: content || 'Thinking...',
          reasoning,
          status: status === 'streaming' ? (group.pending.has(requestId) ? 'streaming' : 'done') : status
        };
      });
      snapshot.timeline = snapshot.timeline.map((entry) =>
        entry.type === 'message'
          ? {
              ...entry,
              message:
                snapshot.messages.find((m) => m.id === entry.message.id) ??
                entry.message
            }
          : entry
      );
      showInFlightIfActive(snapshot);
      return snapshot;
    }
    setChatMessages((current) =>
      current.map((m) => {
        const requestId = [...targetRequestIds].find((rid) => group.messageIdByRequestId.get(rid) === m.id);
        if (!requestId) return m;
        const name = responderByRequestId.get(requestId) ?? m.assistantDisplayName ?? 'Wizard';
        const raw = group.contentByRequestId.get(requestId)?.trim() ?? '';
        const content = stripDuplicateNexusSpeakerLabel(name, raw);
        const reasoning = group.reasoningByRequestId.get(requestId)?.trim() || undefined;
        return {
          ...m,
          content: content || 'Thinking...',
          reasoning,
          status: status === 'streaming' ? (group.pending.has(requestId) ? 'streaming' : 'done') : status
        };
      })
    );
    for (const requestId of targetRequestIds) {
      const messageId = group.messageIdByRequestId.get(requestId);
      if (messageId) {
        updateTimelineMessage(messageId, (m) => {
          const name = responderByRequestId.get(requestId) ?? m.assistantDisplayName ?? 'Wizard';
          const raw = group.contentByRequestId.get(requestId)?.trim() ?? '';
          const content = stripDuplicateNexusSpeakerLabel(name, raw);
          const reasoning = group.reasoningByRequestId.get(requestId)?.trim() || undefined;
          return {
            ...m,
            content: content || 'Thinking...',
            reasoning,
            status: status === 'streaming' ? (group.pending.has(requestId) ? 'streaming' : 'done') : status
          };
        });
      }
    }
    return undefined;
  };

  const refreshChatList = useCallback(async () => {
    const list = await window.electronAPI.listChats();
    setChatList(list);
  }, []);

  const refreshWorkspaceChanges = useCallback(async (rootOverride?: string) => {
    const root = rootOverride ?? workspaceRootRef.current;
    if (!root) {
      setWorkspaceChanges(null);
      return;
    }
    setChangesLoading(true);
    try {
      setWorkspaceChanges(await window.electronAPI.getWorkspaceChanges(root));
    } finally {
      setChangesLoading(false);
    }
  }, []);

  const saveChatSnapshot = useCallback(
    async (chatId: string, msgs: ChatMessage[], tl: ChatTimelineEntry[]) => {
      const disk = await window.electronAPI.loadChat(chatId);
      if (!disk) return;
      await window.electronAPI.saveChat({
        ...disk,
        title: resolveChatTitle(msgs, disk.titleOverride),
        messages: msgs,
        timeline: tl,
        updatedAt: Date.now()
      });
      await refreshChatList();
    },
    [refreshChatList]
  );

  finalizeNexusMultiResponseUiRef.current = (group, usage) => {
    const snapshot = updateNexusMultiResponseMessage(group, 'done');
    if (snapshot && usage && activeChatIdRef.current === snapshot.chatId) {
      setLastTokenUsage(usage);
    }
    if (activeChatIdRef.current === group.chatId) {
      setChatStreaming(false);
      setActiveRequestId(undefined);
    }
    for (const rid of group.requestIds) {
      nexusMultiResponseGroupsRef.current.delete(rid);
    }
    const finalSnapshot = inFlightChatsRef.current.get(group.messageId) ?? snapshot;
    if (finalSnapshot) {
      void saveChatSnapshot(finalSnapshot.chatId, finalSnapshot.messages, finalSnapshot.timeline).finally(() => {
        if (inFlightChatsRef.current.get(group.messageId) === finalSnapshot) {
          inFlightChatsRef.current.delete(group.messageId);
        }
      });
    }
  };

  const activeChatMeta = useMemo(
    () => (activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined),
    [activeChatId, chatList]
  );
  const normalChatList = useMemo(() => chatList.filter((c) => (c.kind ?? 'normal') === 'normal'), [chatList]);
  const wizardChatList = useMemo(() => chatList.filter((c) => c.kind === 'wizard'), [chatList]);
  const nexusProjectList = useMemo(() => chatList.filter((c) => c.kind === 'nexus'), [chatList]);
  const wizardSessionsByWizardId = useMemo(() => {
    const map = new Map<string, SavedChatMeta[]>();
    for (const chat of chatList) {
      if (chat.kind !== 'wizard-session' || !chat.wizardId) continue;
      const list = map.get(chat.wizardId) ?? [];
      list.push(chat);
      map.set(chat.wizardId, list);
    }
    return map;
  }, [chatList]);
  const nexusSessionsByNexusId = useMemo(() => {
    const map = new Map<string, SavedChatMeta[]>();
    for (const chat of chatList) {
      if (chat.kind !== 'nexus-session' || !chat.nexusId) continue;
      const list = map.get(chat.nexusId) ?? [];
      list.push(chat);
      map.set(chat.nexusId, list);
    }
    return map;
  }, [chatList]);

  /** Wizard selected from sidebar (settings/workspace) without an active chat thread. */
  const [sidebarFocusedWizardId, setSidebarFocusedWizardId] = useState<string | undefined>(undefined);
  /** Nexus project selected from sidebar without an active room thread. */
  const [sidebarFocusedNexusId, setSidebarFocusedNexusId] = useState<string | undefined>(undefined);

  const sidebarWizardListMeta = useMemo(
    () =>
      sidebarFocusedWizardId
        ? wizardChatList.find((c) => c.id === sidebarFocusedWizardId)
        : undefined,
    [sidebarFocusedWizardId, wizardChatList]
  );

  const sidebarNexusListMeta = useMemo(
    () =>
      sidebarFocusedNexusId
        ? nexusProjectList.find((c) => c.id === sidebarFocusedNexusId)
        : undefined,
    [sidebarFocusedNexusId, nexusProjectList]
  );

  const activeWizardMeta = useMemo(() => {
    if (activeChatMeta?.kind === 'wizard-session' && activeChatMeta.wizardId) {
      return chatList.find((c) => c.id === activeChatMeta.wizardId && c.kind === 'wizard');
    }
    if (activeChatMeta?.kind === 'wizard') {
      return activeChatMeta;
    }
    return sidebarWizardListMeta;
  }, [activeChatMeta, chatList, sidebarWizardListMeta]);
  const activeWizard = activeWizardMeta?.wizard ?? null;
  const activeNexusMeta = useMemo(() => {
    if (activeChatMeta?.kind === 'nexus-session' && activeChatMeta.nexusId) {
      return chatList.find((c) => c.id === activeChatMeta.nexusId && c.kind === 'nexus');
    }
    if (activeChatMeta?.kind === 'nexus') return activeChatMeta;
    return sidebarNexusListMeta;
  }, [activeChatMeta, chatList, sidebarNexusListMeta]);
  const activeNexus = activeNexusMeta?.nexus ?? null;

  useEffect(() => {
    setWizardDraft(activeWizard);
  }, [activeChatId, activeWizard]);

  useEffect(() => {
    setNexusDraft(activeNexus);
  }, [activeChatId, activeNexus]);

  useEffect(() => {
    const id = activeWizardMeta?.id;
    if (!id) {
      settingsInspectorWizardIdRef.current = undefined;
      return;
    }
    const prev = settingsInspectorWizardIdRef.current;
    if (prev !== id) {
      settingsInspectorWizardIdRef.current = id;
      if (prev === undefined) setSettingsInspectorScope('wizard');
    }
  }, [activeWizardMeta?.id]);

  useEffect(() => {
    const id = activeNexusMeta?.id;
    if (!id) {
      settingsInspectorNexusIdRef.current = undefined;
      setSettingsInspectorScope((s) => (s === 'nexus' ? 'general' : s));
      return;
    }
    const prev = settingsInspectorNexusIdRef.current;
    if (prev !== id) {
      settingsInspectorNexusIdRef.current = id;
      if (prev === undefined) setSettingsInspectorScope('nexus');
    }
  }, [activeNexusMeta?.id]);

  useEffect(() => {
    wizardDraftRef.current = wizardDraft;
  }, [wizardDraft]);

  useEffect(() => {
    nexusDraftRef.current = nexusDraft;
  }, [nexusDraft]);

  useEffect(() => {
    if (wizardAutosaveTimerRef.current) {
      clearTimeout(wizardAutosaveTimerRef.current);
      wizardAutosaveTimerRef.current = null;
    }
  }, [activeWizardMeta?.id]);

  useEffect(() => {
    if (nexusAutosaveTimerRef.current) {
      clearTimeout(nexusAutosaveTimerRef.current);
      nexusAutosaveTimerRef.current = null;
    }
  }, [activeNexusMeta?.id]);

  const effectiveModelOverride = useMemo((): ChatModelOverride | null => {
    if (activeChatId) return activeChatMeta?.modelOverride ?? null;
    return newChatModelOverride;
  }, [activeChatId, activeChatMeta?.modelOverride, newChatModelOverride]);

  const showWizardHubPlaceholder = useMemo(
    () =>
      sidebarTab === 'wizards' &&
      wizardsSidebarPane === 'wizards' &&
      !sidebarFocusedWizardId &&
      activeChatMeta?.kind !== 'wizard-session' &&
      activeChatMeta?.kind !== 'nexus-session',
    [sidebarTab, wizardsSidebarPane, sidebarFocusedWizardId, activeChatMeta?.kind]
  );

  const chatSessionSubheading = useMemo(() => {
    if (
      sidebarTab === 'wizards' &&
      wizardsSidebarPane === 'nexus' &&
      !sidebarFocusedNexusId &&
      activeChatMeta?.kind !== 'wizard-session' &&
      activeChatMeta?.kind !== 'nexus-session'
    ) {
      return 'Select a Nexus project to get started';
    }
    if (
      sidebarTab === 'wizards' &&
      wizardsSidebarPane === 'wizards' &&
      !sidebarFocusedWizardId &&
      activeChatMeta?.kind !== 'wizard-session' &&
      activeChatMeta?.kind !== 'nexus-session'
    ) {
      return 'Select a Wizard to get started';
    }
    if (activeWizard) {
      const session =
        activeChatMeta?.kind === 'wizard-session'
          ? activeChatMeta.title
          : !activeChatId && sidebarFocusedWizardId && activeWizardMeta?.id === sidebarFocusedWizardId
            ? 'New session on first send'
            : activeChatMeta?.kind === 'wizard'
              ? 'Home'
              : 'Home';
      return `${activeWizard.name} · ${session} · ${pathLabel(activeWizard.workspaceRoot)}`;
    }
    if (activeNexus) {
      const session =
        activeChatMeta?.kind === 'nexus-session'
          ? activeChatMeta.title
          : !activeChatId && sidebarFocusedNexusId && activeNexusMeta?.id === sidebarFocusedNexusId
            ? 'New room on first send'
            : 'Project room';
      const leaderName = chatList.find((chat) => chat.id === activeNexus.leaderWizardId)?.wizard?.name ?? 'Leader';
      return `${activeNexus.name} · ${session} · ${leaderName} leads · ${pathLabel(activeNexus.workspaceRoot)}`;
    }
    if (chatMessages.length === 0) {
      if (newChatModelOverride?.model) {
        return `New conversation · ${formatOverrideLabel(newChatModelOverride, pathLabel)}`;
      }
      return 'New conversation';
    }
    if (activeChatId) {
      const meta = chatList.find((c) => c.id === activeChatId);
      if (meta?.title) {
        const base = meta.title;
        if (meta.modelOverride?.model) {
          return `${base} · ${formatOverrideLabel(meta.modelOverride, pathLabel)}`;
        }
        return base;
      }
    }
    return chatTitle(chatMessages);
  }, [
    activeChatId,
    activeChatMeta,
    activeWizard,
    activeWizardMeta?.id,
    activeNexus,
    chatList,
    chatMessages,
    newChatModelOverride,
    pathLabel,
    sidebarFocusedWizardId,
    sidebarFocusedNexusId,
    wizardsSidebarPane,
    activeNexusMeta?.id,
    sidebarTab
  ]);

  const persistCurrentChat = useCallback(
    async (msgs: ChatMessage[], tl: ChatTimelineEntry[], chatId?: string) => {
      if (msgs.length === 0) return;
      const id = chatId ?? uid();
      const fp = chatFingerprint(msgs, tl);
      if (fp === lastContentFingerprintRef.current) {
        if (chatId) return id;
        return;
      }
      const now = Date.now();
      const existing = chatList.find((c) => c.id === id);
      const disk = chatId ? await window.electronAPI.loadChat(chatId) : null;
      const nameOverride =
        disk != null
          ? disk.titleOverride ?? null
          : existing?.titleOverride == null || existing.titleOverride === ''
            ? null
            : existing.titleOverride;
      const createdAt = disk?.createdAt ?? existing?.createdAt ?? now;
      const kind = disk?.kind ?? existing?.kind ?? 'normal';
      const wizard = disk?.wizard ?? existing?.wizard ?? null;
      const wizardId = disk?.wizardId ?? existing?.wizardId ?? null;
      const nexus = disk?.nexus ?? existing?.nexus ?? null;
      const nexusId = disk?.nexusId ?? existing?.nexusId ?? null;
      const chat: SavedChat = {
        id,
        kind,
        title:
          kind === 'wizard-session' || kind === 'nexus-session'
            ? sessionTitle(msgs, nameOverride ?? undefined)
            : resolveChatTitle(msgs, nameOverride),
        titleOverride: nameOverride == null || nameOverride === '' ? null : nameOverride.trim() || null,
        messages: msgs,
        timeline: tl,
        createdAt,
        updatedAt: now,
        pinned: disk?.pinned ?? existing?.pinned ?? false,
        modelOverride: disk?.modelOverride ?? existing?.modelOverride ?? (chatId ? null : (newChatModelOverrideRef.current ?? null)),
        wizard,
        wizardId,
        nexus,
        nexusId
      };
      await window.electronAPI.saveChat(chat);
      lastContentFingerprintRef.current = fp;
      if (!chatId) setActiveChatId(id);
      await refreshChatList();
      return id;
    },
    [chatList, refreshChatList]
  );

  const debouncedSave = useCallback(
    (msgs: ChatMessage[], tl: ChatTimelineEntry[], chatId?: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void persistCurrentChat(msgs, tl, chatId);
      }, 1500);
    },
    [persistCurrentChat]
  );

  const appliedCustomTokensRef = useRef(new Set<string>());

  useEffect(() => {
    const boot = async () => {
      const loaded = await window.electronAPI.loadSettings();
      setSettings(loaded);
      settingsRef.current = loaded;
      setShowOnboarding(!loaded.ui.onboardingCompleted);
      await refreshChatList();
    };
    void boot();
  }, []);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    appliedCustomTokensRef.current.forEach((k) => root.style.removeProperty(k));
    appliedCustomTokensRef.current.clear();
    root.dataset.theme = settings.ui.themeId;

    if (settings.ui.themeId === 'custom' && settings.ui.customThemeTokens) {
      for (const [key, val] of Object.entries(settings.ui.customThemeTokens)) {
        if (!isAllowedCustomThemeTokenKey(key)) continue;
        root.style.setProperty(key, val);
        appliedCustomTokensRef.current.add(key);
      }
    }

    if (settings.ui.themeId === 'custom') {
      const bgToken = settings.ui.customThemeTokens?.['--bg-0'];
      const customLight =
        bgToken == null || String(bgToken).trim() === '' ? true : isLikelyLightCssBackground(String(bgToken));
      if (customLight) {
        root.dataset.customLight = 'true';
      } else {
        delete root.dataset.customLight;
      }
      root.style.colorScheme = customLight ? 'light' : 'dark';
    } else {
      delete root.dataset.customLight;
      root.style.removeProperty('color-scheme');
    }
  }, [settings]);

  useEffect(() => {
    const preset = settings?.ui.chatThreadBackgroundPreset ?? null;
    const path = settings?.ui.chatThreadBackgroundPath?.trim();

    if (!preset && !path) {
      if (chatThreadBackgroundUrlRef.current) {
        URL.revokeObjectURL(chatThreadBackgroundUrlRef.current);
        chatThreadBackgroundUrlRef.current = null;
      }
      setChatThreadBackgroundUrl(null);
      return;
    }

    const customThemeLight =
      settings?.ui.themeId !== 'custom'
        ? false
        : (() => {
            const bgToken = settings.ui.customThemeTokens?.['--bg-0'];
            return bgToken == null || String(bgToken).trim() === '' ? true : isLikelyLightCssBackground(String(bgToken));
          })();

    const request =
      preset === 'mystic' && settings
        ? ({
            source: 'builtin',
            presetId: 'mystic',
            themeId: settings.ui.themeId,
            customThemeLight
          } as const)
        : path
          ? ({ source: 'userFile', path } as const)
          : null;

    if (!request) {
      if (chatThreadBackgroundUrlRef.current) {
        URL.revokeObjectURL(chatThreadBackgroundUrlRef.current);
        chatThreadBackgroundUrlRef.current = null;
      }
      setChatThreadBackgroundUrl(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const res = await window.electronAPI.readChatThreadBackground(request);
      if (cancelled) return;
      if (!res.ok) {
        if (chatThreadBackgroundUrlRef.current) {
          URL.revokeObjectURL(chatThreadBackgroundUrlRef.current);
          chatThreadBackgroundUrlRef.current = null;
        }
        setChatThreadBackgroundUrl(null);
        return;
      }
      let blob: Blob;
      try {
        blob = await fetch(`data:${res.mime};base64,${res.dataBase64}`).then((r) => r.blob());
      } catch {
        setChatThreadBackgroundUrl(null);
        return;
      }
      const url = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      if (chatThreadBackgroundUrlRef.current) {
        URL.revokeObjectURL(chatThreadBackgroundUrlRef.current);
      }
      chatThreadBackgroundUrlRef.current = url;
      setChatThreadBackgroundUrl(url);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    settings?.ui.chatThreadBackgroundPreset,
    settings?.ui.chatThreadBackgroundPath,
    settings?.ui.themeId,
    settings?.ui.customThemeTokens?.['--bg-0']
  ]);

  useEffect(() => {
    return () => {
      if (chatThreadBackgroundUrlRef.current) {
        URL.revokeObjectURL(chatThreadBackgroundUrlRef.current);
        chatThreadBackgroundUrlRef.current = null;
      }
    };
  }, []);

  const openRouterKeyForEffect = settings?.selectedProvider === 'openrouter' ? settings.providers.openrouter.apiKey : null;
  const lmstudioBaseForCatalog =
    settings?.selectedProvider === 'lmstudio' ? (settings.providers.lmstudio.baseUrl ?? '').trim() : null;

  useEffect(() => {
    if (!settings) return;
    void refreshModels(settings);
  }, [settings?.selectedProvider, openRouterKeyForEffect, lmstudioBaseForCatalog]);

  /**
   * LM Studio has no long-lived connection — the UI “Connected” state comes from the last catalog fetch.
   * Re-probe on focus, when the window becomes visible, and on an interval so turning the server off updates the status
   * without switching providers.
   */
  useEffect(() => {
    if (!settings || settings.selectedProvider !== 'lmstudio') return;

    const poke = () => {
      void refreshModelsRef.current();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') poke();
    };

    window.addEventListener('focus', poke);
    document.addEventListener('visibilitychange', onVisibility);
    const intervalId = window.setInterval(poke, LM_STUDIO_CATALOG_PROBE_MS);

    return () => {
      window.removeEventListener('focus', poke);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(intervalId);
    };
  }, [settings?.selectedProvider, lmstudioBaseForCatalog]);

  useEffect(() => {
    if (!settings) return;
    if (activeChatId) {
      setOverrideModelProvider(activeChatMeta?.modelOverride?.provider ?? settings.selectedProvider);
    } else {
      setOverrideModelProvider(newChatModelOverride?.provider ?? settings.selectedProvider);
    }
  }, [activeChatId, activeChatMeta?.modelOverride?.provider, newChatModelOverride?.provider, settings]);

  useEffect(() => {
    if (!settings) {
      setOverrideModels([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI.listModels(settings, overrideModelProvider).then((list) => {
      if (!cancelled) setOverrideModels(list);
    });
    return () => {
      cancelled = true;
    };
  }, [settings, overrideModelProvider]);

  useEffect(() => {
    const offChunk = window.electronAPI.onCommandChunk((payload) => {
      if (payload.jobId && payload.jobId === inlineTerminalJobIdRef.current) {
        setInlineTerminalLogs((c) => c + payload.chunk);
      }
    });
    const offDone = window.electronAPI.onCommandDone((payload) => {
      if (payload.jobId && payload.jobId === inlineTerminalJobIdRef.current) {
        setInlineTerminalJobId(undefined);
        inlineTerminalJobIdRef.current = undefined;
        setInlineTerminalLogs((c) => c + `\n[process exited ${payload.code ?? 'signal'}]\n`);
      }
    });
    const offDelta = window.electronAPI.onChatDelta(({ requestId, delta, reasoningDelta }) => {
      const nexusGroup = nexusMultiResponseGroupsRef.current.get(requestId);
      if (nexusGroup) {
        if (delta) {
          nexusGroup.contentByRequestId.set(
            requestId,
            `${nexusGroup.contentByRequestId.get(requestId) ?? ''}${delta}`
          );
        }
        if (reasoningDelta) {
          nexusGroup.reasoningByRequestId.set(
            requestId,
            `${nexusGroup.reasoningByRequestId.get(requestId) ?? ''}${reasoningDelta}`
          );
        }
        updateNexusMultiResponseMessage(nexusGroup, 'streaming', requestId);
        return;
      }
      const map = streamPendingDeltaRef.current;
      const cur = map.get(requestId) ?? { text: '', reasoning: '' };
      if (delta) cur.text += delta;
      if (reasoningDelta) cur.reasoning += reasoningDelta;
      map.set(requestId, cur);
      if (streamFlushRafRef.current == null) {
        streamFlushRafRef.current = window.requestAnimationFrame(() => {
          streamFlushRafRef.current = null;
          flushStreamingDeltaBufferRef.current();
        });
      }
    });
    const offDoneChat = window.electronAPI.onChatDone(({ requestId, content, reasoning, usage }) => {
      cancelStreamDeltaFlushAndFlushNow();
      const nexusGroup = nexusMultiResponseGroupsRef.current.get(requestId);
      if (nexusGroup) {
        nexusGroup.contentByRequestId.set(requestId, content);
        if (reasoning !== undefined) nexusGroup.reasoningByRequestId.set(requestId, reasoning);
        nexusGroup.pending.delete(requestId);

        if (nexusGroup.suppressFinalizeUntilOrchestrator) {
          updateNexusMultiResponseMessage(nexusGroup, 'streaming', requestId);
          if (usage && activeChatIdRef.current === nexusGroup.chatId) {
            setLastTokenUsage(usage);
          }
          return;
        }

        const snapshot = updateNexusMultiResponseMessage(
          nexusGroup,
          nexusGroup.pending.size === 0 ? 'done' : 'streaming',
          requestId
        );
        if (snapshot && usage && activeChatIdRef.current === snapshot.chatId) {
          setLastTokenUsage(usage);
        }
        if (nexusGroup.pending.size === 0) {
          finalizeNexusMultiResponseUiRef.current(nexusGroup, usage);
        }
        return;
      }
      const snapshot = updateInFlightMessage(requestId, (m) => {
        const next: ChatMessage = { ...m, content, status: 'done' as const };
        if (reasoning !== undefined) next.reasoning = reasoning;
        else if (m.reasoning !== undefined) next.reasoning = m.reasoning;
        return next;
      });
      if (snapshot) {
        if (usage && activeChatIdRef.current === snapshot.chatId) {
          setLastTokenUsage(usage);
        }
        if (activeChatIdRef.current === snapshot.chatId) {
          setChatStreaming(false);
          setActiveRequestId(undefined);
        }
        void saveChatSnapshot(snapshot.chatId, snapshot.messages, snapshot.timeline).finally(() => {
          if (inFlightChatsRef.current.get(requestId) === snapshot) {
            inFlightChatsRef.current.delete(requestId);
          }
        });
        return;
      }
      setChatStreaming(false);
      setActiveRequestId(undefined);
    });
    const offError = window.electronAPI.onChatError(({ requestId, error }) => {
      cancelStreamDeltaFlushAndFlushNow();
      const nexusGroup = nexusMultiResponseGroupsRef.current.get(requestId);
      if (nexusGroup) {
        nexusGroup.contentByRequestId.set(requestId, `Error: ${error}`);
        nexusGroup.pending.delete(requestId);
        appendActivity({
          id: uid(),
          requestId: nexusGroup.messageId,
          kind: error === 'Request stopped.' ? 'stopped' : 'error',
          message: error === 'Request stopped.' ? 'Model stopped.' : `Model error: ${error}`
        });

        if (nexusGroup.suppressFinalizeUntilOrchestrator) {
          updateNexusMultiResponseMessage(nexusGroup, 'streaming', requestId);
          return;
        }

        const snapshot = updateNexusMultiResponseMessage(
          nexusGroup,
          nexusGroup.pending.size === 0 ? 'done' : 'streaming',
          requestId
        );
        if (nexusGroup.pending.size === 0) {
          finalizeNexusMultiResponseUiRef.current(nexusGroup);
        }
        return;
      }
      const s = settingsRef.current;
      if (s?.selectedProvider === 'lmstudio' && looksLikeProviderTransportError(error)) {
        void refreshModelsRef.current();
      }

      const snapshot = updateInFlightMessage(requestId, (m) => ({
        ...m,
        content: error,
        status: 'error',
        role: 'assistant'
      }));
      appendActivity({
        id: uid(),
        requestId,
        kind: error === 'Request stopped.' ? 'stopped' : 'error',
        message: error === 'Request stopped.' ? 'Model stopped.' : `Model error: ${error}`
      });
      if (snapshot) {
        if (activeChatIdRef.current === snapshot.chatId) {
          setChatStreaming(false);
          setActiveRequestId(undefined);
        }
        void saveChatSnapshot(snapshot.chatId, snapshot.messages, snapshot.timeline).finally(() => {
          if (inFlightChatsRef.current.get(requestId) === snapshot) {
            inFlightChatsRef.current.delete(requestId);
          }
        });
        return;
      }
      setChatStreaming(false);
      setActiveRequestId(undefined);
    });
    const offActivity = window.electronAPI.onChatActivity((payload) => {
      appendActivity(payload);
    });
    const offSettingsUpdated = window.electronAPI.onSettingsUpdated((next) => {
      setSettings(next);
    });
    const offChatsUpdated = window.electronAPI.onChatsUpdated(() => {
      void refreshChatList();
    });
    const offWizardPromptApproval = window.electronAPI.onWizardPromptApprovalRequest((payload) => {
      setWizardPromptApproval(payload);
    });
    const offToolApproval = window.electronAPI.onToolApprovalRequest((payload) => {
      setToolApprovalRequest(payload);
    });
    const offWorkspaceChanged = window.electronAPI.onWorkspaceChanged(
      async ({ root, fileWritten, fileDeleted }) => {
        const latestTree = await window.electronAPI.getWorkspaceTree(root);
        setWorkspaceTree(latestTree);
        void refreshWorkspaceChanges(root);

        const wDraft = wizardDraftRef.current;
        if (wDraft && pathsEqual(wDraft.workspaceRoot, root)) {
          try {
            const docs = await window.electronAPI.listWizardDocuments(root);
            const wid = activeWizardMeta?.id;
            const cur = wizardDraftRef.current;
            if (wid && cur && pathsEqual(cur.workspaceRoot, root)) {
              const full = await window.electronAPI.loadChat(wid);
              if (full?.kind === 'wizard' && full.wizard) {
                const merged: WizardProfile = { ...full.wizard, documents: docs };
                setWizardDraft(merged);
                wizardDraftRef.current = merged;
                await window.electronAPI.saveChat({ ...full, wizard: merged, updatedAt: Date.now() });
              }
            }
          } catch {
            /* ignore */
          }
        }

        if (!fileWritten && activeFilePathRef.current) {
          const activeKey = activeFilePathRef.current;
          const buf = buffersRef.current[activeKey];
          if (!buf?.dirty) {
            try {
              const reloaded = await window.electronAPI.openFile(root, activeKey);
              setBuffers((current) => ({
                ...current,
                [activeKey]: { ...reloaded, dirty: false }
              }));
            } catch {
              // active file may have been removed or become unreadable
            }
          }
        }

        if (fileDeleted) {
          setBuffers((c) => {
            const key = Object.keys(c).find((k) => k === fileDeleted || c[k].path === fileDeleted);
            if (key == null) return c;
            const { [key]: _removed, ...rest } = c;
            setActiveFilePath((a) => (a != null && (a === key || a === fileDeleted) ? undefined : a));
            return rest;
          });
        }

        if (fileWritten) {
          try {
            const reloaded = await window.electronAPI.openFile(root, fileWritten);
            setBuffers((current) => {
              const key = Object.keys(current).find(
                (k) => k === fileWritten || k === reloaded.path || current[k].path === reloaded.path
              );
              if (key == null) return current;
              return { ...current, [key]: { ...reloaded, dirty: false } };
            });
          } catch {
            // File may be missing or not UTF-8; tree is already up to date
          }
        }
      }
    );
    return () => {
      cancelStreamDeltaFlushAndFlushNow();
      offChunk();
      offDone();
      offDelta();
      offDoneChat();
      offError();
      offActivity();
      offSettingsUpdated();
      offChatsUpdated();
      offWizardPromptApproval();
      offToolApproval();
      offWorkspaceChanged();
    };
  }, [activeWizardMeta?.id, refreshChatList, refreshWorkspaceChanges]);

  useEffect(() => {
    if (chatMessages.length > 0 && !chatStreaming) {
      debouncedSave(chatMessages, chatTimeline, activeChatId);
    }
  }, [activeChatId, chatMessages, chatStreaming, chatTimeline, debouncedSave]);

  const chooseWorkspace = async () => {
    const result = await window.electronAPI.chooseWorkspace();
    if (!result) return;
    setWorkspaceRoot(result.root);
    setWorkspaceTree(result.tree);
    setInlineTerminalLogs((c) => c + `\n[workspace attached: ${result.root}]\n`);
    void refreshWorkspaceChanges(result.root);
  };

  const openLastWorkspace = async () => {
    const result = await window.electronAPI.openLastWorkspace();
    if (!result) {
      setSettingsStatus('Last workspace folder is missing or was moved. Use Open workspace to pick a folder.');
      return;
    }
    setWorkspaceRoot(result.root);
    setWorkspaceTree(result.tree);
    setInlineTerminalLogs((c) => c + `\n[workspace attached: ${result.root}]\n`);
    void refreshWorkspaceChanges(result.root);
    setSettingsStatus('');
  };

  const clearWorkspace = () => {
    if (!workspaceRoot) return;
    if (activeWizard || activeNexus) {
      setSettingsStatus('Wizard and Nexus workspaces stay attached while selected.');
      return;
    }
    void window.electronAPI.detachWorkspace().finally(() => {
      setWorkspaceRoot(undefined);
      setWorkspaceTree([]);
      setWorkspaceChanges(null);
      setBuffers({});
      setActiveFilePath(undefined);
      setInlineTerminalLogs((c) => c + '\n[workspace cleared]\n');
    });
  };

  const activateWorkspace = async (root: string) => {
    const result = await window.electronAPI.activateWorkspace(root);
    setWorkspaceRoot(result.root);
    setWorkspaceTree(result.tree);
    setWorkspaceChanges(null);
    setBuffers({});
    setActiveFilePath(undefined);
    void refreshWorkspaceChanges(result.root);
    return result;
  };

  const isWizardOwnedWorkspaceRoot = useCallback(
    (root: string) =>
      wizardChatList.some(
        (w) => w.kind === 'wizard' && w.wizard?.workspaceRoot && pathsEqual(w.wizard.workspaceRoot, root)
      ) ||
      nexusProjectList.some(
        (n) => n.kind === 'nexus' && n.nexus?.workspaceRoot && pathsEqual(n.nexus.workspaceRoot, root)
      ),
    [nexusProjectList, wizardChatList]
  );

  /** When leaving Wizard/Nexus context, detach that owned folder rather than treating it as the normal sidebar workspace. */
  const switchAwayFromWizardMountedWorkspace = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root || !isWizardOwnedWorkspaceRoot(root)) return;

    await window.electronAPI.detachWorkspace();
    setWorkspaceRoot(undefined);
    setWorkspaceTree([]);
    setWorkspaceChanges(null);
    setBuffers({});
    setActiveFilePath(undefined);
  }, [isWizardOwnedWorkspaceRoot]);

  const openFile = async (target: string) => {
    if (!workspaceRoot) return;
    if (buffers[target]) {
      setActiveFilePath(target);
      return;
    }
    const file = await window.electronAPI.openFile(workspaceRoot, target);
    setBuffers((current) => ({ ...current, [target]: { ...file, dirty: false } }));
    setActiveFilePath(target);
    setInspectorTab('editor');
  };

  const saveActiveFile = async () => {
    if (!workspaceRoot || !activeFilePath) return;
    const activeBuffer = buffers[activeFilePath];
    if (!activeBuffer || activeBuffer.imagePreview) return;
    const saved = await window.electronAPI.saveFile(workspaceRoot, activeFilePath, activeBuffer.content);
    setBuffers((current) => ({ ...current, [activeFilePath]: { ...saved, dirty: false } }));
    void refreshWorkspaceChanges(workspaceRoot);
  };

  const refreshModels = async (settingsOverride?: AppSettings) => {
    const activeSettings = settingsOverride ?? settingsRef.current;
    if (!activeSettings) return;

    setModelCatalogSettled(false);

    if (activeSettings.selectedProvider === 'openrouter') {
      const key = activeSettings.providers.openrouter.apiKey?.trim() ?? '';
      if (!key) {
        setModels([]);
        setSettingsStatus('OpenRouter: add an API key in Settings; the catalog loads after the key is set.');
        setModelCatalogSettled(true);
        return;
      }
    }

    try {
      setSettingsStatus('Loading model catalog...');
      const modelList = await window.electronAPI.listModels(activeSettings, activeSettings.selectedProvider);
      setModels(modelList);
      const defaultModel = pickDefaultModel(modelList, activeSettings.providers[activeSettings.selectedProvider].model);
      const normalizedBaseUrl = normalizeProviderBaseUrl(
        activeSettings.selectedProvider,
        activeSettings.providers[activeSettings.selectedProvider].baseUrl
      );
      if (defaultModel && defaultModel !== activeSettings.providers[activeSettings.selectedProvider].model) {
        setSettings((c) =>
          c
            ? {
                ...c,
                providers: {
                  ...c.providers,
                  [activeSettings.selectedProvider]: {
                    ...c.providers[activeSettings.selectedProvider],
                    model: defaultModel,
                    baseUrl: normalizedBaseUrl
                  }
                }
              }
            : c
        );
      } else if (normalizedBaseUrl !== activeSettings.providers[activeSettings.selectedProvider].baseUrl) {
        setSettings((c) =>
          c
            ? {
                ...c,
                providers: {
                  ...c.providers,
                  [activeSettings.selectedProvider]: {
                    ...c.providers[activeSettings.selectedProvider],
                    baseUrl: normalizedBaseUrl
                  }
                }
              }
            : c
        );
      }
      if (modelList.length > 0) {
        setSettingsStatus(`Connected. ${modelList.length} models available. Active: ${defaultModel || 'none'}.`);
      } else {
        setSettingsStatus(
          activeSettings.selectedProvider === 'lmstudio'
            ? 'Connected, but no models returned. Load a model in LM Studio first.'
            : 'Connected, but OpenRouter returned no models for this profile.'
        );
      }
    } catch (error) {
      setModels([]);
      const message = error instanceof Error ? error.message : 'Failed to load models.';
      setSettingsStatus(`Connection failed: ${message}`);
    } finally {
      setModelCatalogSettled(true);
    }
  };

  const refreshModelsRef = useRef(refreshModels);
  refreshModelsRef.current = refreshModels;

  const persistSettingsToDisk = async (next: AppSettings) => {
    const saved = await window.electronAPI.saveSettings(next);
    setSettings(saved);
  };

  const SETTINGS_AUTOSAVE_MS = 450;
  const WIZARD_AUTOSAVE_MS = 450;
  const NEXUS_AUTOSAVE_MS = 450;

  const flushSettingsAutosaveTimer = () => {
    if (settingsAutosaveTimerRef.current) {
      clearTimeout(settingsAutosaveTimerRef.current);
      settingsAutosaveTimerRef.current = null;
    }
  };

  const flushWizardAutosaveTimer = () => {
    if (wizardAutosaveTimerRef.current) {
      clearTimeout(wizardAutosaveTimerRef.current);
      wizardAutosaveTimerRef.current = null;
    }
  };

  const flushNexusAutosaveTimer = () => {
    if (nexusAutosaveTimerRef.current) {
      clearTimeout(nexusAutosaveTimerRef.current);
      nexusAutosaveTimerRef.current = null;
    }
  };

  const handleSettingsPanelChange = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    flushSettingsAutosaveTimer();
    settingsAutosaveTimerRef.current = setTimeout(() => {
      settingsAutosaveTimerRef.current = null;
      void (async () => {
        try {
          const latest = settingsRef.current;
          if (!latest) return;
          const saved = await window.electronAPI.saveSettings(latest);
          setSettings(saved);
          settingsRef.current = saved;
          setSettingsStatus('Saved.');
        } catch (e) {
          const m = e instanceof Error ? e.message : 'Save failed';
          setSettingsStatus(`Could not save settings: ${m}`);
        }
      })();
    }, SETTINGS_AUTOSAVE_MS);
  }, []);

  const handleWebSearchChange = useCallback(async (next: boolean) => {
    flushSettingsAutosaveTimer();
    const s = settingsRef.current;
    if (!s) return;
    const updated: AppSettings = { ...s, ui: { ...s.ui, webSearch: next } };
    settingsRef.current = updated;
    setSettings(updated);
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
      settingsRef.current = saved;
      if (next && needsSearchApiKeyNotice(saved)) {
        setShowWebSearchNotice(true);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Web search setting not saved: ${m}`);
    }
  }, []);

  const persistWizardProjectsParentFolder = useCallback(async (folder: string) => {
    flushSettingsAutosaveTimer();
    const s = settingsRef.current;
    if (!s) return;
    const updated: AppSettings = {
      ...s,
      ui: { ...s.ui, wizardProjectsParentFolder: folder }
    };
    settingsRef.current = updated;
    setSettings(updated);
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
      settingsRef.current = saved;
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Could not save Wizards folder: ${m}`);
      throw e;
    }
  }, []);

  const jumpToSearchSettings = useCallback(() => {
    setShowWebSearchNotice(false);
    setInspectorTab('settings');
    setSearchSettingsFocusKey((key) => key + 1);
  }, []);

  const handleSessionModeToggle = useCallback(async () => {
    flushSettingsAutosaveTimer();
    const s = settingsRef.current;
    if (!s) return;
    const nextMode: SessionMode = s.ui.sessionMode === 'talk' ? 'agent' : 'talk';
    const updated: AppSettings = { ...s, ui: { ...s.ui, sessionMode: nextMode } };
    settingsRef.current = updated;
    setSettings(updated);
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
      settingsRef.current = saved;
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Session mode not saved: ${m}`);
    }
  }, []);

  const persistAfterPresetAction = async (next: AppSettings) => {
    flushSettingsAutosaveTimer();
    try {
      await persistSettingsToDisk(next);
      setSettingsStatus('Saved.');
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Could not save settings to disk: ${m}`);
    }
  };

  const completeOnboarding = useCallback(async () => {
    setShowOnboarding(false);
    const current = settingsRef.current;
    if (!current || current.ui.onboardingCompleted) return;
    const next = { ...current, ui: { ...current.ui, onboardingCompleted: true } };
    setSettings(next);
    settingsRef.current = next;
    try {
      await persistSettingsToDisk(next);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Onboarding completion not saved: ${m}`);
    }
  }, []);

  const addChatAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    const nextAttachments = await Promise.all(
      Array.from(files).map(
        (file) =>
          new Promise<ChatAttachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ id: uid(), name: file.name, mimeType: file.type || 'image/*', dataUrl: String(reader.result) });
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          })
      )
    );
    setChatAttachments((c) => [...c, ...nextAttachments]);
  };

  const startNewChat = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSidebarFocusedWizardId(undefined);
    setSidebarFocusedNexusId(undefined);
    await switchAwayFromWizardMountedWorkspace();
    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    setNewChatModelOverride(null);
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;
    setSidebarTab('chats');
    setShowNewMenu(false);
  };

  const handleChatsTabClick = () => {
    setSidebarTab('chats');
    const meta = activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined;
    const comingFromWizardContext = Boolean(
      sidebarFocusedWizardId ||
        sidebarFocusedNexusId ||
        meta?.kind === 'wizard' ||
        meta?.kind === 'wizard-session' ||
        meta?.kind === 'nexus' ||
        meta?.kind === 'nexus-session'
    );
    if (comingFromWizardContext) void startNewChat();
  };

  const loadChat = async (id: string, opts?: { expandWizardInSidebar?: boolean }) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const chat = await window.electronAPI.loadChat(id);
    if (!chat) return;

    /** Opening any saved conversation clears “wizard selected, no chat” sidebar focus. */
    setSidebarFocusedWizardId(undefined);
    setSidebarFocusedNexusId(undefined);
    const parentWizard =
      chat.kind === 'wizard-session' && chat.wizardId
        ? await window.electronAPI.loadChat(chat.wizardId)
        : chat.kind === 'wizard'
          ? chat
          : null;
    const parentNexus =
      chat.kind === 'nexus-session' && chat.nexusId
        ? await window.electronAPI.loadChat(chat.nexusId)
        : chat.kind === 'nexus'
          ? chat
          : null;
    if (parentWizard?.kind === 'wizard' && parentWizard.wizard?.workspaceRoot) {
      try {
        await activateWorkspace(parentWizard.wizard.workspaceRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
      }
      setSidebarTab('wizards');
      const expandInSidebar =
        opts?.expandWizardInSidebar ??
        chat.kind !== 'wizard' /* wizard-session (and similar) expands parent row in sidebar */;
      if (expandInSidebar) {
        setExpandedWizardIds((current) => new Set(current).add(parentWizard.id));
      }
    } else if (parentNexus?.kind === 'nexus' && parentNexus.nexus?.workspaceRoot) {
      try {
        await activateWorkspace(parentNexus.nexus.workspaceRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Nexus workspace could not be opened.');
      }
      setSidebarTab('wizards');
      setExpandedNexusIds((current) => new Set(current).add(parentNexus.id));
    } else {
      setSidebarTab('chats');
      await switchAwayFromWizardMountedWorkspace();
    }
    const inFlight = findInFlightByChatId(id);
    const messages = inFlight?.messages ?? chat.messages;
    const timeline = inFlight?.timeline ?? chat.timeline;
    lastContentFingerprintRef.current = chatFingerprint(messages, timeline);
    setChatMessages(messages);
    setChatTimeline(timeline);
    setActiveChatId(chat.id);
    activeChatIdRef.current = chat.id;
    setChatSessionId(chat.id);
    chatSessionIdRef.current = chat.id;
    setNewChatModelOverride(null);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(Boolean(inFlight));
    setActiveRequestId(inFlight?.requestId);
  };

  const handleWizardSidebarRowActivate = async (chat: SavedChatMeta) => {
    if (!chat.wizard?.workspaceRoot) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const active = activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined;
    const sessionOpenForThisWizard =
      Boolean(activeChatId && active?.kind === 'wizard-session' && active.wizardId === chat.id);

    /** Parent row click while a session is open: only fold/unfold sessions (legacy behavior). */
    if (sessionOpenForThisWizard) {
      setExpandedWizardIds((current) => {
        const next = new Set(current);
        if (next.has(chat.id)) next.delete(chat.id);
        else next.add(chat.id);
        return next;
      });
      return;
    }

    /** Same wizard already focused with no chat open: second click toggles session list expand/collapse. */
    const wizardAlreadyFocusedNoChat = !activeChatId && sidebarFocusedWizardId === chat.id;
    if (wizardAlreadyFocusedNoChat) {
      setExpandedWizardIds((current) => {
        const next = new Set(current);
        if (next.has(chat.id)) next.delete(chat.id);
        else next.add(chat.id);
        return next;
      });
      return;
    }

    /** First selection (nothing focused or switching Wizards): focus workspace + inspector only — do not expand sessions yet. */

    setSidebarFocusedNexusId(undefined);
    setSidebarFocusedWizardId(chat.id);
    setInspectorTab('settings');
    setSettingsInspectorScope('wizard');

    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;

    try {
      await activateWorkspace(chat.wizard.workspaceRoot);
    } catch (e) {
      setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
    }
    setSidebarTab('wizards');

    try {
      const full = await window.electronAPI.loadChat(chat.id);
      if (full?.kind === 'wizard' && full.wizard) {
        setWizardDraft(full.wizard);
        wizardDraftRef.current = full.wizard;
      }
    } catch {
      /* ignore */
    }
  };

  const handleNexusSidebarRowActivate = async (project: SavedChatMeta) => {
    if (project.kind !== 'nexus' || !project.nexus?.workspaceRoot) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const active = activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined;
    const sessionOpenForThisNexus =
      Boolean(activeChatId && active?.kind === 'nexus-session' && active.nexusId === project.id);

    if (sessionOpenForThisNexus) {
      setExpandedNexusIds((current) => {
        const next = new Set(current);
        if (next.has(project.id)) next.delete(project.id);
        else next.add(project.id);
        return next;
      });
      return;
    }

    const nexusAlreadyFocusedNoChat = !activeChatId && sidebarFocusedNexusId === project.id;
    if (nexusAlreadyFocusedNoChat) {
      setExpandedNexusIds((current) => {
        const next = new Set(current);
        if (next.has(project.id)) next.delete(project.id);
        else next.add(project.id);
        return next;
      });
      return;
    }

    setSidebarFocusedWizardId(undefined);
    setSidebarFocusedNexusId(project.id);
    setInspectorTab('settings');
    setSettingsInspectorScope('nexus');

    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;

    try {
      await activateWorkspace(project.nexus.workspaceRoot);
    } catch (e) {
      setSettingsStatus(e instanceof Error ? e.message : 'Nexus workspace could not be opened.');
    }
    setSidebarTab('wizards');

    try {
      const full = await window.electronAPI.loadChat(project.id);
      if (full?.kind === 'nexus' && full.nexus) {
        setNexusDraft(full.nexus);
        nexusDraftRef.current = full.nexus;
      }
    } catch {
      /* ignore */
    }
  };

  const deleteChat = async (id: string) => {
    const inFlight = findInFlightByChatId(id);
    if (inFlight) {
      await window.electronAPI.stopChat(inFlight.requestId);
      inFlightChatsRef.current.delete(inFlight.requestId);
    }
    await window.electronAPI.deleteChat(id);
    if (activeChatId === id) await startNewChat();
    if (editingTitleId === id) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }
    await refreshChatList();
  };

  const requestDeleteChat = (chat: SavedChatMeta) => {
    if (chat.kind === 'wizard') {
      setWizardDeleteTarget(chat);
      return;
    }
    if (chat.kind === 'wizard-session') {
      setWizardSessionDeleteTarget(chat);
      return;
    }
    if (chat.kind === 'nexus') {
      setNexusDeleteTarget(chat);
      return;
    }
    if (chat.kind === 'nexus-session') {
      setNexusSessionDeleteTarget(chat);
      return;
    }
    void deleteChat(chat.id);
  };

  const clearActiveConversation = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSidebarFocusedWizardId(undefined);
    setSidebarFocusedNexusId(undefined);
    await switchAwayFromWizardMountedWorkspace();
    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    setNewChatModelOverride(null);
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;
  };

  const deleteWizardSession = async (session: SavedChatMeta) => {
    const wizardId = session.wizardId;
    const inFlight = findInFlightByChatId(session.id);
    if (inFlight) {
      await window.electronAPI.stopChat(inFlight.requestId);
      inFlightChatsRef.current.delete(inFlight.requestId);
    }
    await window.electronAPI.deleteChat(session.id);
    if (activeChatId === session.id) {
      const siblings = wizardId
        ? (wizardSessionsByWizardId.get(wizardId) ?? []).filter((item) => item.id !== session.id)
        : [];
      if (siblings[0]) {
        await loadChat(siblings[0].id);
      } else {
        await clearActiveConversation();
        setSidebarTab('wizards');
        if (wizardId) setExpandedWizardIds((current) => new Set(current).add(wizardId));
      }
    }
    if (editingTitleId === session.id) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }
    await refreshChatList();
  };

  const deleteNexusSession = async (session: SavedChatMeta) => {
    const nexusId = session.nexusId;
    const inFlight = findInFlightByChatId(session.id);
    if (inFlight) {
      await window.electronAPI.stopChat(inFlight.requestId);
      inFlightChatsRef.current.delete(inFlight.requestId);
    }
    await window.electronAPI.deleteChat(session.id);
    if (activeChatId === session.id) {
      const siblings = nexusId
        ? (nexusSessionsByNexusId.get(nexusId) ?? []).filter((item) => item.id !== session.id)
        : [];
      if (siblings[0]) {
        await loadChat(siblings[0].id);
      } else {
        await clearActiveConversation();
        setSidebarTab('wizards');
        if (nexusId) setExpandedNexusIds((current) => new Set(current).add(nexusId));
      }
    }
    if (editingTitleId === session.id) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }
    await refreshChatList();
  };

  const confirmDeleteWizard = async () => {
    const target = wizardDeleteTarget;
    if (!target) return;
    const workspaceRoot = target.wizard?.workspaceRoot;
    const wizardName = target.wizard?.name || target.title;
    const sessions = wizardSessionsByWizardId.get(target.id) ?? [];
    const priorActiveId = activeChatId;
    const idsRemoved = new Set<string>([target.id, ...sessions.map((s) => s.id)]);

    setWizardDeleteTarget(null);

    for (const cid of idsRemoved) {
      const inf = findInFlightByChatId(cid);
      if (inf) {
        await window.electronAPI.stopChat(inf.requestId);
        inFlightChatsRef.current.delete(inf.requestId);
      }
    }

    await Promise.all(sessions.map((session) => window.electronAPI.deleteChat(session.id)));
    await deleteChat(target.id);

    if (priorActiveId && idsRemoved.has(priorActiveId)) {
      await startNewChat();
    }
    if (editingTitleId && idsRemoved.has(editingTitleId)) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }

    setSidebarTab('wizards');
    setExpandedWizardIds((current) => {
      const next = new Set(current);
      next.delete(target.id);
      return next;
    });
    if (sidebarFocusedWizardId === target.id) {
      setSidebarFocusedWizardId(undefined);
    }
    if (workspaceRoot) {
      setWorkspaceDeleteTarget({ workspaceRoot, label: wizardName, variant: 'wizard' });
    }
  };

  const confirmDeleteNexus = async () => {
    const target = nexusDeleteTarget;
    if (!target?.nexus?.workspaceRoot || target.kind !== 'nexus') return;
    const workspaceRoot = target.nexus.workspaceRoot;
    const projectLabel = target.nexus.name?.trim() || target.title;
    const sessions = nexusSessionsByNexusId.get(target.id) ?? [];
    const priorActiveId = activeChatId;
    const idsRemoved = new Set<string>([target.id, ...sessions.map((s) => s.id)]);

    setNexusDeleteTarget(null);

    for (const cid of idsRemoved) {
      const inf = findInFlightByChatId(cid);
      if (inf) {
        await window.electronAPI.stopChat(inf.requestId);
        inFlightChatsRef.current.delete(inf.requestId);
      }
    }

    await Promise.all(sessions.map((session) => window.electronAPI.deleteChat(session.id)));
    await deleteChat(target.id);

    if (priorActiveId && idsRemoved.has(priorActiveId)) {
      await startNewChat();
    }
    if (editingTitleId && idsRemoved.has(editingTitleId)) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }

    setSidebarTab('wizards');
    setExpandedNexusIds((current) => {
      const next = new Set(current);
      next.delete(target.id);
      return next;
    });
    if (sidebarFocusedNexusId === target.id) {
      setSidebarFocusedNexusId(undefined);
    }
    setWorkspaceDeleteTarget({ workspaceRoot, label: projectLabel, variant: 'nexus' });
  };

  /** Persist a new wizard-session with the bootstrap assistant message (shared with Send auto-create). */
  const createWizardSessionBootstrapOnDisk = async (
    full: SavedChat
  ): Promise<{
    sessionId: string;
    assistantMessage: ChatMessage;
    timeline: ChatTimelineEntry[];
    workspaceRoot: string;
    wizardDiskId: string;
  } | null> => {
    if (!full?.wizard || full.kind !== 'wizard') return null;
    const now = Date.now();
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: `New session started for ${full.wizard.name}. Each message loads every Markdown file in your workspace into context automatically—core docs first—so custom notes are included too.`,
      status: 'done',
      assistantDisplayName: full.wizard.name.trim() || undefined
    };
    const timeline: ChatTimelineEntry[] = [{ id: `message-${assistantMessage.id}`, type: 'message', message: assistantMessage }];
    const sessionId = uid();
    const session: SavedChat = {
      id: sessionId,
      kind: 'wizard-session',
      title: 'New session',
      titleOverride: null,
      messages: [assistantMessage],
      timeline,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      modelOverride: { provider: full.wizard.provider, model: full.wizard.model },
      wizardId: full.id
    };
    await window.electronAPI.saveChat(session);
    return {
      sessionId,
      assistantMessage,
      timeline,
      workspaceRoot: full.wizard.workspaceRoot,
      wizardDiskId: full.id
    };
  };

  const createWizardSession = async (wizardMeta: SavedChatMeta) => {
    const full = await window.electronAPI.loadChat(wizardMeta.id);
    if (!full || full.kind !== 'wizard' || !full.wizard) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const bootstrap = await createWizardSessionBootstrapOnDisk(full);
    if (!bootstrap) return;
    const { assistantMessage, timeline, sessionId } = bootstrap;
    lastContentFingerprintRef.current = chatFingerprint([assistantMessage], timeline);
    setChatMessages([assistantMessage]);
    setChatTimeline(timeline);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(sessionId);
    activeChatIdRef.current = sessionId;
    setChatSessionId(sessionId);
    chatSessionIdRef.current = sessionId;
    setExpandedWizardIds((current) => new Set(current).add(full.id));
    setSidebarTab('wizards');
    await refreshChatList();
    await activateWorkspace(bootstrap.workspaceRoot);
    setSidebarFocusedWizardId(undefined);
    setSidebarFocusedNexusId(undefined);
  };

  const createNexusSessionBootstrapOnDisk = async (full: SavedChat) => {
    if (!full?.nexus || full.kind !== 'nexus') return null;
    const now = Date.now();
    const leaderDisk =
      full.nexus.leaderWizardId != null ? await window.electronAPI.loadChat(full.nexus.leaderWizardId) : null;
    const leaderWizard = leaderDisk?.kind === 'wizard' ? leaderDisk.wizard : null;
    const leaderName =
      leaderWizard?.name?.trim() ||
      chatList.find((c) => c.id === full.nexus?.leaderWizardId)?.wizard?.name?.trim() ||
      'the leader Wizard';
    const leaderDisplay =
      leaderWizard?.name?.trim() ||
      chatList.find((c) => c.id === full.nexus?.leaderWizardId)?.wizard?.name?.trim();
    const missionSnippet = full.nexus.mission.trim()
      ? `\n\nProject mission: ${full.nexus.mission.trim()}`
      : '';
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: `Nexus room started for ${full.nexus.name}. ${leaderName} is the leader. The team will use the shared project workspace while keeping each Wizard's private Markdown docs in context.${missionSnippet}`,
      status: 'done',
      assistantDisplayName: leaderDisplay || undefined
    };
    const timeline: ChatTimelineEntry[] = [{ id: `message-${assistantMessage.id}`, type: 'message', message: assistantMessage }];
    const sessionId = uid();
    const session: SavedChat = {
      id: sessionId,
      kind: 'nexus-session',
      title: 'New Nexus session',
      titleOverride: null,
      messages: [assistantMessage],
      timeline,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      nexusId: full.id
    };
    await window.electronAPI.saveChat(session);
    return { sessionId, assistantMessage, timeline, workspaceRoot: full.nexus.workspaceRoot };
  };

  const createNexusSession = async (nexusMeta: SavedChatMeta) => {
    const full = await window.electronAPI.loadChat(nexusMeta.id);
    if (!full || full.kind !== 'nexus' || !full.nexus) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const bootstrap = await createNexusSessionBootstrapOnDisk(full);
    if (!bootstrap) return;
    const { assistantMessage, timeline, sessionId } = bootstrap;
    lastContentFingerprintRef.current = chatFingerprint([assistantMessage], timeline);
    setChatMessages([assistantMessage]);
    setChatTimeline(timeline);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(sessionId);
    activeChatIdRef.current = sessionId;
    setChatSessionId(sessionId);
    chatSessionIdRef.current = sessionId;
    setExpandedNexusIds((current) => new Set(current).add(full.id));
    setSidebarTab('wizards');
    await refreshChatList();
    await activateWorkspace(bootstrap.workspaceRoot);
    setSidebarFocusedWizardId(undefined);
    setSidebarFocusedNexusId(undefined);
  };

  const beginWizardExport = (e: MouseEvent, chat: SavedChatMeta) => {
    e.stopPropagation();
    if (!chat.wizard) return;
    setWizardExportChat(chat);
  };

  const beginRenameChat = (e: MouseEvent, id: string, currentTitle: string) => {
    e.stopPropagation();
    skipNextRenameCommitRef.current = false;
    setEditingTitleId(id);
    setEditingTitleDraft(currentTitle);
  };

  const cancelRenameChat = () => {
    setEditingTitleId(null);
    setEditingTitleDraft('');
  };

  const saveChatModelOverride = useCallback(
    async (override: ChatModelOverride | null) => {
      if (!activeChatId) {
        setNewChatModelOverride(override);
        return;
      }
      const full = await window.electronAPI.loadChat(activeChatId);
      if (!full) return;
      await window.electronAPI.saveChat({ ...full, modelOverride: override, updatedAt: full.updatedAt });
      await refreshChatList();
    },
    [activeChatId, refreshChatList]
  );

  const listModelsForWizardSetup = useCallback(
    async (provider: ProviderKind) => {
      const s = settingsRef.current;
      if (!s) return [];
      return window.electronAPI.listModels(s, provider);
    },
    []
  );

  const saveActiveWizard = useCallback(
    async (wizard: WizardProfile) => {
      const wizardId = activeWizardMeta?.id;
      if (!wizardId) return;
      const full = await window.electronAPI.loadChat(wizardId);
      if (!full || full.kind !== 'wizard' || !full.wizard) return;
      const previousDiskRoot = full.wizard.workspaceRoot;
      const profileInput: WizardProfile = { ...wizard, workspaceRoot: full.wizard.workspaceRoot };
      let profile: WizardProfile;
      try {
        profile = await window.electronAPI.syncWizardWorkspaceFolder(profileInput);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSettingsStatus(msg);
        return;
      }
      if (
        workspaceRootRef.current &&
        pathsEqual(workspaceRootRef.current, previousDiskRoot) &&
        profile.workspaceRoot !== previousDiskRoot
      ) {
        const mapPath = workspaceAbsolutePathPrefixRemap(previousDiskRoot, profile.workspaceRoot);
        setWorkspaceRoot(profile.workspaceRoot);
        setBuffers((current) => {
          const next: Record<string, FileBuffer> = {};
          for (const [key, buf] of Object.entries(current)) {
            const mappedKey = mapPath(key);
            next[mappedKey] = { ...buf, path: mapPath(buf.path) };
          }
          return next;
        });
        setActiveFilePath((active) => (active ? mapPath(active) : active));
        try {
          setWorkspaceTree(await window.electronAPI.getWorkspaceTree(profile.workspaceRoot));
        } catch {
          setWorkspaceTree([]);
        }
        void refreshWorkspaceChanges(profile.workspaceRoot);
      }
      await window.electronAPI.saveChat({
        ...full,
        title: profile.name,
        titleOverride: profile.name,
        updatedAt: Date.now(),
        modelOverride: { provider: profile.provider, model: profile.model },
        wizard: profile
      });
      await refreshChatList();
      setWizardDraft(profile);
    },
    [activeWizardMeta?.id, refreshChatList, refreshWorkspaceChanges]
  );

  const handleWizardDraftChange = useCallback(
    (next: WizardProfile) => {
      setWizardDraft(next);
      wizardDraftRef.current = next;
      flushWizardAutosaveTimer();
      wizardAutosaveTimerRef.current = setTimeout(() => {
        wizardAutosaveTimerRef.current = null;
        const draft = wizardDraftRef.current;
        if (draft) void saveActiveWizard(draft);
      }, WIZARD_AUTOSAVE_MS);
    },
    [saveActiveWizard]
  );

  const saveActiveNexus = useCallback(
    async (project: NexusProject) => {
      const nid = activeNexusMeta?.id;
      if (!nid) return;
      const full = await window.electronAPI.loadChat(nid);
      if (!full || full.kind !== 'nexus' || !full.nexus) return;
      await window.electronAPI.saveChat({
        ...full,
        title: project.name,
        titleOverride: project.name,
        nexus: project,
        updatedAt: Date.now()
      });
      await refreshChatList();
      setNexusDraft(project);
    },
    [activeNexusMeta?.id, refreshChatList]
  );

  const handleNexusDraftChange = useCallback(
    (next: NexusProject) => {
      setNexusDraft(next);
      nexusDraftRef.current = next;
      flushNexusAutosaveTimer();
      nexusAutosaveTimerRef.current = setTimeout(() => {
        nexusAutosaveTimerRef.current = null;
        const draft = nexusDraftRef.current;
        if (draft) void saveActiveNexus(draft);
      }, NEXUS_AUTOSAVE_MS);
    },
    [saveActiveNexus]
  );

  useEffect(() => {
    const prev = lastInspectorTabRef.current;
    lastInspectorTabRef.current = inspectorTab;
    if (prev !== 'settings' || inspectorTab === 'settings') return;
    flushSettingsAutosaveTimer();
    void (async () => {
      try {
        const s = settingsRef.current;
        if (s) await persistSettingsToDisk(s);
      } catch {
        /* best-effort flush when leaving Settings inspector */
      }
    })();
    flushWizardAutosaveTimer();
    const w = wizardDraftRef.current;
    if (w && activeWizardMeta?.id) void saveActiveWizard(w);
    flushNexusAutosaveTimer();
    const nx = nexusDraftRef.current;
    if (nx && activeNexusMeta?.id) void saveActiveNexus(nx);
  }, [inspectorTab, activeWizardMeta?.id, activeNexusMeta?.id, saveActiveWizard, saveActiveNexus]);

  const refreshWizardModels = useCallback(async (provider: ProviderKind) => listModelsForWizardSetup(provider), [listModelsForWizardSetup]);

  const createWizard = useCallback(
    async (request: WizardSetupRequest) => {
      const result = await window.electronAPI.setupWizard(request);
      setWorkspaceRoot(result.profile.workspaceRoot);
      setWorkspaceTree(result.tree);
      setWorkspaceChanges(null);
      setBuffers({});
      setActiveFilePath(undefined);
      const now = Date.now();
      const id = uid();
      const chat: SavedChat = {
        id,
        kind: 'wizard',
        title: result.profile.name,
        titleOverride: result.profile.name,
        messages: [],
        timeline: [],
        createdAt: now,
        updatedAt: now,
        pinned: false,
        modelOverride: { provider: result.profile.provider, model: result.profile.model },
        wizard: result.profile
      };
      await window.electronAPI.saveChat(chat);
      await refreshChatList();
      setShowWizardSetup(false);
      await createWizardSession({
        id,
        kind: 'wizard',
        title: result.profile.name,
        titleOverride: result.profile.name,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        modelOverride: { provider: result.profile.provider, model: result.profile.model },
        wizard: result.profile
      });
      void refreshWorkspaceChanges(result.profile.workspaceRoot);
    },
    [refreshChatList, refreshWorkspaceChanges]
  );

  const createNexus = useCallback(
    async (request: NexusSetupRequest) => {
      const leader = wizardChatList.find((wizard) => wizard.id === request.leaderWizardId);
      if (!leader?.wizard) throw new Error('Choose a valid leader Wizard.');
      const memberIds = [...new Set(request.memberWizardIds)];
      if (!memberIds.includes(request.leaderWizardId)) memberIds.unshift(request.leaderWizardId);
      const validMembers = memberIds.filter((id) => wizardChatList.some((wizard) => wizard.id === id));
      if (validMembers.length < 2) throw new Error('Choose at least two Wizards for a Nexus.');
      const now = Date.now();
      const id = uid();
      const nexus: NexusProject = {
        name: request.name,
        mission: request.mission,
        workspaceRoot: request.workspaceRoot,
        leaderWizardId: request.leaderWizardId,
        members: validMembers.map((wizardId) => ({
          wizardId,
          role: wizardId === request.leaderWizardId ? 'leader' : 'member'
        })),
        tasks: [
          {
            id: uid(),
            title: 'Leader drafts the first project plan',
            assigneeWizardId: request.leaderWizardId,
            status: 'planned'
          }
        ],
        status: 'active',
        teamFullAccess: false,
        leaderApprovesTools: false,
        parallelWizardResponses: false,
        maxSequentialWizardTurns: 24
      };
      await activateWorkspace(request.workspaceRoot);
      const chat: SavedChat = {
        id,
        kind: 'nexus',
        title: nexus.name,
        titleOverride: nexus.name,
        messages: [],
        timeline: [],
        createdAt: now,
        updatedAt: now,
        pinned: false,
        nexus
      };
      await window.electronAPI.saveChat(chat);
      await refreshChatList();
      setShowNexusSetup(false);
      await createNexusSession({
        id,
        kind: 'nexus',
        title: nexus.name,
        titleOverride: nexus.name,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        nexus
      });
      void refreshWorkspaceChanges(request.workspaceRoot);
    },
    [refreshChatList, refreshWorkspaceChanges, wizardChatList]
  );

  const togglePinChat = useCallback(
    async (e: MouseEvent, id: string) => {
      e.stopPropagation();
      const full = await window.electronAPI.loadChat(id);
      if (!full) return;
      await window.electronAPI.saveChat({ ...full, pinned: !full.pinned, updatedAt: Date.now() });
      await refreshChatList();
    },
    [refreshChatList]
  );

  const commitRenameChat = async (id: string, draft: string) => {
    if (skipNextRenameCommitRef.current) {
      skipNextRenameCommitRef.current = false;
      return;
    }
    if (editingTitleId !== id) return;
    setEditingTitleId(null);
    setEditingTitleDraft('');
    const full = await window.electronAPI.loadChat(id);
    if (!full) return;
    const trimmed = draft.trim();
    const nextOverride = trimmed.length > 0 ? trimmed : null;

    let wizardPatch = full.kind === 'wizard' && full.wizard ? { ...full.wizard, name: nextOverride ?? full.wizard.name } : full.wizard;
    const prevWizardRoot = full.kind === 'wizard' ? full.wizard?.workspaceRoot : undefined;
    if (full.kind === 'wizard' && wizardPatch) {
      try {
        wizardPatch = await window.electronAPI.syncWizardWorkspaceFolder({
          ...wizardPatch,
          workspaceRoot: full.wizard!.workspaceRoot
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSettingsStatus(msg);
        return;
      }
    }

    if (
      prevWizardRoot &&
      wizardPatch &&
      workspaceRootRef.current &&
      pathsEqual(workspaceRootRef.current, prevWizardRoot) &&
      wizardPatch.workspaceRoot !== prevWizardRoot
    ) {
      const mapPath = workspaceAbsolutePathPrefixRemap(prevWizardRoot, wizardPatch.workspaceRoot);
      setWorkspaceRoot(wizardPatch.workspaceRoot);
      setBuffers((current) => {
        const next: Record<string, FileBuffer> = {};
        for (const [key, buf] of Object.entries(current)) {
          const mappedKey = mapPath(key);
          next[mappedKey] = { ...buf, path: mapPath(buf.path) };
        }
        return next;
      });
      setActiveFilePath((active) => (active ? mapPath(active) : active));
      try {
        setWorkspaceTree(await window.electronAPI.getWorkspaceTree(wizardPatch.workspaceRoot));
      } catch {
        setWorkspaceTree([]);
      }
      void refreshWorkspaceChanges(wizardPatch.workspaceRoot);
    }

    await window.electronAPI.saveChat({
      ...full,
      title: nextOverride != null ? nextOverride : full.kind === 'wizard-session' ? sessionTitle(full.messages) : chatTitle(full.messages),
      titleOverride: nextOverride,
      wizard: full.kind === 'wizard' ? wizardPatch : full.wizard,
      updatedAt: Date.now()
    });
    await refreshChatList();
  };

  const sendChat = async () => {
    const sendSettings = settingsRef.current;
    const trimmedInput = chatInput.trim();
    const attachmentsSnapshot = [...chatAttachments];
    if (!sendSettings || (trimmedInput.length === 0 && attachmentsSnapshot.length === 0)) {
      return;
    }

    if (
      chatStreamingRef.current &&
      nexusRelayComposeUnlockedRef.current &&
      activeChatIdRef.current &&
      activeRequestIdRef.current
    ) {
      const parentRequestId = activeRequestIdRef.current;
      const userMessage: ChatMessage = {
        id: uid(),
        role: 'user',
        content:
          trimmedInput.length > 0
            ? trimmedInput
            : 'Please use the attached image(s) as context for this request.',
        attachments: attachmentsSnapshot.length > 0 ? attachmentsSnapshot : undefined,
        status: 'done'
      };
      nexusQueuedUserTurnsRef.current.push(userMessage);
      const entry: ChatTimelineEntry = { id: `message-${userMessage.id}`, type: 'message', message: userMessage };
      setChatMessages((prev) => [...prev, userMessage]);
      setChatTimeline((prev) => [...prev, entry]);
      const snapshot = inFlightChatsRef.current.get(parentRequestId);
      if (snapshot) {
        snapshot.messages = [...snapshot.messages, userMessage];
        snapshot.timeline = [...snapshot.timeline, entry];
        showInFlightIfActive(snapshot);
        void saveChatSnapshot(snapshot.chatId, snapshot.messages, snapshot.timeline);
      }
      setChatInput('');
      setChatAttachments([]);
      return;
    }

    if (chatStreamingRef.current) {
      return;
    }

    let messagesForHistory = chatMessages;
    let timelineForHistory = chatTimeline;
    let disk: SavedChat | null = activeChatId ? await window.electronAPI.loadChat(activeChatId) : null;

    if (activeWizard && activeWizardMeta?.id && (!disk || disk.kind === 'wizard')) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const fullWizard = await window.electronAPI.loadChat(activeWizardMeta.id);
      if (
        !fullWizard ||
        fullWizard.kind !== 'wizard' ||
        !fullWizard.wizard
      ) {
        return;
      }
      const bootstrap = await createWizardSessionBootstrapOnDisk(fullWizard);
      if (!bootstrap) return;
      const {
        assistantMessage,
        timeline: bootstrapTimeline,
        sessionId,
        workspaceRoot: wsRoot,
        wizardDiskId
      } = bootstrap;
      lastContentFingerprintRef.current = chatFingerprint([assistantMessage], bootstrapTimeline);
      setActiveChatId(sessionId);
      activeChatIdRef.current = sessionId;
      setChatSessionId(sessionId);
      chatSessionIdRef.current = sessionId;
      setSidebarFocusedWizardId(undefined);
      setSidebarFocusedNexusId(undefined);
      setExpandedWizardIds((current) => new Set(current).add(wizardDiskId));
      await refreshChatList();
      try {
        await activateWorkspace(wsRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
        return;
      }
      disk = await window.electronAPI.loadChat(sessionId);
      if (!disk || disk.kind !== 'wizard-session') return;
      messagesForHistory = disk.messages;
      timelineForHistory = disk.timeline;
    }

    const activeDiskChat = disk;
    if (activeWizard && (!activeDiskChat || activeDiskChat.kind !== 'wizard-session')) {
      setSettingsStatus('Wizard session could not be started.');
      return;
    }
    const parentWizardChat =
      activeDiskChat?.kind === 'wizard-session' && activeDiskChat.wizardId
        ? await window.electronAPI.loadChat(activeDiskChat.wizardId)
        : activeDiskChat?.kind === 'wizard'
          ? activeDiskChat
          : null;
    const parentNexusChat =
      activeDiskChat?.kind === 'nexus-session' && activeDiskChat.nexusId
        ? await window.electronAPI.loadChat(activeDiskChat.nexusId)
        : activeDiskChat?.kind === 'nexus'
          ? activeDiskChat
          : null;
    const wizardForStream =
      parentWizardChat?.kind === 'wizard'
        ? parentWizardChat.wizard ?? null
        : activeChatMeta?.kind === 'wizard'
          ? activeChatMeta.wizard ?? null
          : null;
    const nexusForStream = parentNexusChat?.kind === 'nexus' ? parentNexusChat.nexus ?? null : null;

    let nexusTeam: Array<{ id: string; wizard: WizardProfile; role: 'leader' | 'member' }> = [];
    if (nexusForStream) {
      const resolved = await Promise.all(
        nexusForStream.members.map(async (member) => {
          const disk = await window.electronAPI.loadChat(member.wizardId);
          const diskWizard = disk?.kind === 'wizard' ? disk.wizard ?? undefined : undefined;
          const meta = chatList.find((chat) => chat.kind === 'wizard' && chat.id === member.wizardId);
          const metaWizard = meta?.wizard ?? undefined;
          const resolved = resolveWizardProfileForNexusTeam(diskWizard, metaWizard, nexusForStream.workspaceRoot);
          const base = resolved ?? diskWizard ?? meta?.wizard;
          if (!base?.workspaceRoot?.trim()) return null;
          const wizard = await repairWizardWorkspaceRootIfNeeded(base, nexusForStream.workspaceRoot);
          return { id: member.wizardId, wizard, role: member.role };
        })
      );
      nexusTeam = resolved.filter((item): item is NonNullable<typeof item> => item != null);
    }
    const nexusLeader = nexusForStream
      ? nexusTeam.find((member) => member.id === nexusForStream.leaderWizardId)?.wizard ?? null
      : null;
    if (wizardForStream && (!wizardForStream.model.trim() || !wizardForStream.workspaceRoot.trim())) return;
    if (nexusForStream && (!nexusLeader?.model.trim() || !nexusForStream.workspaceRoot.trim())) return;
    if (wizardForStream && workspaceRootRef.current !== wizardForStream.workspaceRoot) {
      try {
        await activateWorkspace(wizardForStream.workspaceRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
        return;
      }
    }
    if (nexusForStream && workspaceRootRef.current !== nexusForStream.workspaceRoot) {
      try {
        await activateWorkspace(nexusForStream.workspaceRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Nexus workspace could not be opened.');
        return;
      }
    }
    chatStreamingRef.current = true;
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: trimmedInput.length > 0 ? trimmedInput : 'Please use the attached image(s) as context for this request.',
      attachments: attachmentsSnapshot,
      status: 'done'
    };
    const nexusResponders = nexusForStream && nexusTeam.length >= 2 ? nexusTeam : [];
    const useNexusMultiWizard = Boolean(nexusResponders.length >= 2);
    const useParallelNexusStreams = Boolean(useNexusMultiWizard && nexusForStream?.parallelWizardResponses);
    const parallelChildRequestIds =
      useNexusMultiWizard && useParallelNexusStreams ? nexusResponders.map(() => uid()) : [];
    const relayIntroSpeaker =
      useNexusMultiWizard && nexusForStream && !useParallelNexusStreams
        ? sortNexusTeamLeaderFirst(nexusResponders, nexusForStream.leaderWizardId)[0]?.wizard.name ?? 'Wizard'
        : '';
    const requestId = uid();
    const assistantStreaming: ChatMessage = {
      id: requestId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      assistantDisplayName:
        (useNexusMultiWizard ? relayIntroSpeaker : nexusLeader?.name?.trim()) ||
        wizardForStream?.name?.trim() ||
        undefined,
      reasoning:
        sendSettings.ui.sessionMode === 'talk' && !wizardForStream && !nexusForStream ? '' : undefined
    };
    const parallelAssistantMessages: ChatMessage[] =
      useParallelNexusStreams
        ? nexusResponders.map((member, index) => ({
            id: parallelChildRequestIds[index]!,
            role: 'assistant' as const,
            content: 'Thinking...',
            status: 'streaming' as const,
            assistantDisplayName: member.wizard.name
          }))
        : [];
    const assistantMessagesForTurn = useParallelNexusStreams
      ? parallelAssistantMessages
      : useNexusMultiWizard
        ? []
        : [assistantStreaming];
    const nextHistory = [...messagesForHistory, userMessage];
    const nextTimeline: ChatTimelineEntry[] = [
      ...timelineForHistory,
      { id: `message-${userMessage.id}`, type: 'message', message: userMessage },
      ...assistantMessagesForTurn.map((message) => ({
        id: `message-${message.id}`,
        type: 'message' as const,
        message
      }))
    ];
    setChatMessages([...nextHistory, ...assistantMessagesForTurn]);
    setChatTimeline(nextTimeline);
    setChatInput('');
    setChatAttachments([]);
    setChatStreaming(true);
    setActiveRequestId(requestId);

    const priorChatId = activeChatIdRef.current;
    let chatIdForStream = priorChatId;
    let overrideForStream: ChatModelOverride | null = null;
    if (!priorChatId) {
      const newId = uid();
      chatIdForStream = newId;
      const mo = newChatModelOverrideRef.current;
      overrideForStream = mo;
      setActiveChatId(newId);
      activeChatIdRef.current = newId;
      setChatSessionId(newId);
      chatSessionIdRef.current = newId;
      setNewChatModelOverride(null);
      const chat: SavedChat = {
        id: newId,
        title: chatTitle([...nextHistory, ...assistantMessagesForTurn]),
        titleOverride: null,
        messages: [...nextHistory, ...assistantMessagesForTurn],
        timeline: nextTimeline,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: false,
        modelOverride: mo
      };
      await window.electronAPI.saveChat(chat);
      await refreshChatList();
    } else {
      const loaded = await window.electronAPI.loadChat(priorChatId);
      overrideForStream = loaded?.modelOverride ?? null;
    }
    if (!chatIdForStream) return;
    inFlightChatsRef.current.set(requestId, {
      chatId: chatIdForStream,
      requestId,
      messages: [...nextHistory, ...assistantMessagesForTurn],
      timeline: nextTimeline
    });
    let nexusMultiGroup: NexusMultiResponseGroup | null = null;
    if (useNexusMultiWizard && nexusForStream) {
      nexusMultiGroup = {
        chatId: chatIdForStream,
        messageId: requestId,
        requestIds: new Set(parallelChildRequestIds),
        pending: new Set(parallelChildRequestIds),
        responders: useParallelNexusStreams
          ? nexusResponders.map((member, index) => ({
              requestId: parallelChildRequestIds[index]!,
              name: member.wizard.name
            }))
          : [],
        messageIdByRequestId: new Map(
          useParallelNexusStreams ? parallelChildRequestIds.map((rid) => [rid, rid]) : []
        ),
        contentByRequestId: new Map(parallelChildRequestIds.map((rid) => [rid, ''])),
        reasoningByRequestId: new Map(),
        timeline: nextTimeline,
        suppressFinalizeUntilOrchestrator: !useParallelNexusStreams
      };
      if (useParallelNexusStreams) {
        for (const rid of parallelChildRequestIds) {
          nexusMultiResponseGroupsRef.current.set(rid, nexusMultiGroup);
        }
      }
    }
    const streamSettings = nexusForStream && nexusLeader
      ? {
          ...sendSettings,
          selectedProvider: nexusLeader.provider,
          providers: {
            ...sendSettings.providers,
            [nexusLeader.provider]: {
              ...sendSettings.providers[nexusLeader.provider],
              model: nexusLeader.model,
              systemPrompt: buildNexusSystemPrompt(
                nexusLeader,
                nexusForStream,
                nexusTeam.map((member) => `${member.wizard.name}${member.role === 'leader' ? ' (leader)' : ''}`)
              )
            }
          },
          tools: {
            ...sendSettings.tools,
            allowModelSystemPrompt: false
          },
          ui: {
            ...sendSettings.ui,
            sessionMode: 'agent' as const
          }
        }
      : wizardForStream
      ? {
          ...sendSettings,
          selectedProvider: wizardForStream.provider,
          providers: {
            ...sendSettings.providers,
            [wizardForStream.provider]: {
              ...sendSettings.providers[wizardForStream.provider],
              model: wizardForStream.model,
              systemPrompt: buildWizardSystemPrompt(wizardForStream)
            }
          },
          tools: {
            ...sendSettings.tools,
            allowModelSystemPrompt: false
          },
          ui: {
            ...sendSettings.ui,
            sessionMode: 'agent' as const
          }
        }
      : applyChatModelOverride(sendSettings, overrideForStream);

    const wizardDocsContext = nexusForStream
      ? await buildNexusDocsContext(nexusTeam)
      : wizardForStream
        ? await buildWizardDocsContext(wizardForStream)
        : { message: null, loaded: [] };
    if (wizardForStream) {
      const loadedDocs = wizardDocsContext.loaded;
      const okCount = loadedDocs.filter((doc) => doc.ok).length;
      const checklist = [
        `Workspace active: ${wizardForStream.workspaceRoot}`,
        ...loadedDocs.map((doc) => `${doc.ok ? 'Loaded' : 'Missing'} ${doc.name}`),
        `Injected ${okCount}/${loadedDocs.length} Markdown workspace documents into this request.`
      ].join('\n');
      const activity: ChatActivity = {
        id: uid(),
        requestId,
        kind: okCount === loadedDocs.length ? 'success' : 'warning',
        message: checklist
      };
      const activityEntry: ChatTimelineEntry = { id: `activity-${activity.id}`, type: 'activity', activity };
      const timelineWithChecklist = [...nextTimeline, activityEntry];
      setChatTimeline(timelineWithChecklist);
      const snapshot = inFlightChatsRef.current.get(requestId);
      if (snapshot) {
        snapshot.timeline = timelineWithChecklist;
      }
    }
    if (nexusForStream) {
      const loadedDocs = wizardDocsContext.loaded;
      const okCount = loadedDocs.filter((doc) => doc.ok).length;
      const missingProfiles = nexusForStream.members.length - nexusTeam.length;
      const checklist = [
        `Nexus workspace active: ${nexusForStream.workspaceRoot}`,
        `Leader: ${nexusLeader?.name ?? 'Unknown'}`,
        `Team (resolved): ${nexusTeam.map((member) => member.wizard.name).join(', ') || 'none'}`,
        ...(missingProfiles > 0
          ? [`Could not load ${missingProfiles} Wizard workspace profile(s); those Markdown folders were skipped.`]
          : []),
        ...(useNexusMultiWizard
          ? useParallelNexusStreams
            ? [`Parallel mode: ${nexusTeam.length} Wizard streams ran concurrently on this message (each uses its own model profile).`]
            : [
                `Relay mode: teammates respond one stream at a time in one assistant bubble (cap ${Math.min(
                  96,
                  Math.max(1, nexusForStream.maxSequentialWizardTurns ?? 24)
                )} wizard turns unless the Nexus emits [NEXUS_END]).`
              ]
          : []),
        `Injected ${okCount}/${loadedDocs.length} team Markdown documents into this request.`
      ].join('\n');
      const activity: ChatActivity = {
        id: uid(),
        requestId,
        kind: okCount === loadedDocs.length ? 'success' : 'warning',
        message: checklist
      };
      const activityEntry: ChatTimelineEntry = { id: `activity-${activity.id}`, type: 'activity', activity };
      const timelineWithChecklist = [...nextTimeline, activityEntry];
      setChatTimeline(timelineWithChecklist);
      const snapshot = inFlightChatsRef.current.get(requestId);
      if (snapshot) {
        snapshot.timeline = timelineWithChecklist;
      }
    }
    const streamHistory = wizardDocsContext.message ? [wizardDocsContext.message, ...nextHistory] : nextHistory;

    if (useNexusMultiWizard && nexusForStream && nexusLeader && nexusMultiGroup && useParallelNexusStreams) {
      await Promise.all(
        nexusResponders.map((member, index) => {
          const rid = parallelChildRequestIds[index]!;
          const memberSettings: AppSettings = {
            ...sendSettings,
            selectedProvider: member.wizard.provider,
            providers: {
              ...sendSettings.providers,
              [member.wizard.provider]: {
                ...sendSettings.providers[member.wizard.provider],
                model: member.wizard.model,
                systemPrompt: buildNexusResponderSystemPrompt(
                  member.wizard,
                  nexusForStream,
                  nexusTeam.map((item) => `${item.wizard.name}${item.role === 'leader' ? ' (leader)' : ''}`),
                  member.role,
                  'parallel'
                )
              }
            },
            tools: {
              ...sendSettings.tools,
              allowModelSystemPrompt: false
            },
            ui: {
              ...sendSettings.ui,
              sessionMode: 'agent' as const
            }
          };
          return window.electronAPI.streamChat(rid, memberSettings, streamHistory, {
            workspaceRoot: nexusForStream.workspaceRoot,
            activeFilePath: activeFilePathRef.current,
            conversationId: `${chatSessionIdRef.current}:${member.id}`,
            wizardId: undefined,
            wizardName: undefined,
            wizardSystemPrompt: undefined,
            wizardFullAccess: undefined,
            wizardAllowOutsideWorkspace: undefined,
            nexusTeamFullAccess: Boolean(nexusForStream.teamFullAccess),
            nexusLeaderApprovesTools:
              Boolean(nexusForStream.leaderApprovesTools) && !Boolean(nexusForStream.teamFullAccess),
            nexusLeaderProvider: nexusLeader.provider,
            nexusLeaderModel: nexusLeader.model,
            nexusLeaderName: nexusLeader.name.trim() || undefined
          });
        })
      );
      return;
    }

    if (useNexusMultiWizard && nexusForStream && nexusLeader && nexusMultiGroup && !useParallelNexusStreams) {
      try {
        nexusRelayComposeUnlockedRef.current = true;
        const ordered = sortNexusTeamLeaderFirst(nexusResponders, nexusForStream.leaderWizardId);
        const maxTurns = Math.min(96, Math.max(1, nexusForStream.maxSequentialWizardTurns ?? 24));
        const relayHardCap = Math.min(160, maxTurns + 40);
        let relayAssistantDigest = '';
        let turn = 0;

        while (turn < relayHardCap) {
          if (turn >= maxTurns && nexusQueuedUserTurnsRef.current.length === 0) {
            break;
          }

          const queuedSlice = nexusQueuedUserTurnsRef.current.splice(0);
          const roundRobinMember = ordered[turn % ordered.length]!;
          const member =
            queuedSlice.length > 0
              ? pickNexusRelaySpeakerForQueuedTurn(ordered as NexusRelayResponder[], roundRobinMember, queuedSlice)
              : roundRobinMember;
          const rid = uid();
          nexusMultiGroup.requestIds.add(rid);
          nexusMultiGroup.pending.add(rid);
          nexusMultiGroup.responders.push({ requestId: rid, name: member.wizard.name });
          nexusMultiGroup.messageIdByRequestId.set(rid, rid);
          nexusMultiGroup.contentByRequestId.set(rid, '');
          nexusMultiResponseGroupsRef.current.set(rid, nexusMultiGroup);

          setNexusRelayProgress({ wizardName: member.wizard.name, segmentStartedAt: Date.now() });

          addNexusMultiResponseMessage(nexusMultiGroup, rid, member.wizard.name);
          updateNexusMultiResponseMessage(nexusMultiGroup, 'streaming');

          const continuationHistoryBase =
            relayAssistantDigest.trim().length === 0
              ? streamHistory
              : [
                  ...streamHistory,
                  {
                    id: `nexus-relay-${requestId}-${turn}`,
                    role: 'assistant' as const,
                    content: relayAssistantDigest,
                    status: 'done' as const
                  }
                ];

          const continuationHistory =
            queuedSlice.length > 0 ? [...continuationHistoryBase, ...queuedSlice] : continuationHistoryBase;

          const memberSettings: AppSettings = {
            ...sendSettings,
            selectedProvider: member.wizard.provider,
            providers: {
              ...sendSettings.providers,
              [member.wizard.provider]: {
                ...sendSettings.providers[member.wizard.provider],
                model: member.wizard.model,
                systemPrompt: buildNexusResponderSystemPrompt(
                  member.wizard,
                  nexusForStream,
                  nexusTeam.map((item) => `${item.wizard.name}${item.role === 'leader' ? ' (leader)' : ''}`),
                  member.role,
                  'relay'
                )
              }
            },
            tools: {
              ...sendSettings.tools,
              allowModelSystemPrompt: false
            },
            ui: {
              ...sendSettings.ui,
              sessionMode: 'agent' as const
            }
          };

          const streamResult = await window.electronAPI.streamChat(rid, memberSettings, continuationHistory, {
            workspaceRoot: nexusForStream.workspaceRoot,
            activeFilePath: activeFilePathRef.current,
            conversationId: `${chatSessionIdRef.current}:${member.id}:relay:${turn}`,
            wizardId: undefined,
            wizardName: undefined,
            wizardSystemPrompt: undefined,
            wizardFullAccess: undefined,
            wizardAllowOutsideWorkspace: undefined,
            nexusTeamFullAccess: Boolean(nexusForStream.teamFullAccess),
            nexusLeaderApprovesTools:
              Boolean(nexusForStream.leaderApprovesTools) && !Boolean(nexusForStream.teamFullAccess),
            nexusLeaderProvider: nexusLeader.provider,
            nexusLeaderModel: nexusLeader.model,
            nexusLeaderName: nexusLeader.name.trim() || undefined
          });

          if (!streamResult.ok) {
            break;
          }

          const rawSegment = nexusMultiGroup.contentByRequestId.get(rid) ?? '';
          const wantsEnd = parseNexusRelayWantsEnd(rawSegment);
          const cleaned = stripNexusRelayControlMarkers(rawSegment);
          nexusMultiGroup.contentByRequestId.set(rid, cleaned);
          updateNexusMultiResponseMessage(nexusMultiGroup, 'streaming');

          relayAssistantDigest = formatNexusMultiResponseContent(nexusMultiGroup);

          if (wantsEnd) {
            if (nexusQueuedUserTurnsRef.current.length > 0) {
              turn += 1;
              continue;
            }
            break;
          }

          turn += 1;
        }
      } finally {
        nexusRelayComposeUnlockedRef.current = false;
        nexusQueuedUserTurnsRef.current = [];
        setNexusRelayProgress(null);
        nexusMultiGroup.suppressFinalizeUntilOrchestrator = false;
        finalizeNexusMultiResponseUiRef.current(nexusMultiGroup);
      }
      return;
    }

    await window.electronAPI.streamChat(requestId, streamSettings, streamHistory, {
      workspaceRoot: nexusForStream?.workspaceRoot ?? wizardForStream?.workspaceRoot ?? workspaceRootRef.current,
      activeFilePath: activeFilePathRef.current,
      conversationId: chatSessionIdRef.current,
      wizardId: nexusForStream ? undefined : parentWizardChat?.kind === 'wizard' ? parentWizardChat.id : undefined,
      wizardName: nexusForStream ? undefined : wizardForStream?.name,
      wizardSystemPrompt: nexusForStream ? undefined : wizardForStream?.systemPrompt,
      wizardFullAccess: nexusForStream ? undefined : wizardForStream ? Boolean(wizardForStream.fullAccess) : undefined,
      wizardAllowOutsideWorkspace: nexusForStream ? undefined : wizardForStream ? Boolean(wizardForStream.allowOutsideWorkspace) : undefined,
      ...(nexusForStream && nexusLeader
        ? {
            nexusTeamFullAccess: Boolean(nexusForStream.teamFullAccess),
            nexusLeaderApprovesTools:
              Boolean(nexusForStream.leaderApprovesTools) && !Boolean(nexusForStream.teamFullAccess),
            nexusLeaderProvider: nexusLeader.provider,
            nexusLeaderModel: nexusLeader.model,
            nexusLeaderName: nexusLeader.name.trim() || undefined
          }
        : {})
    });
  };

  const stopChat = async () => {
    if (!activeRequestId) return;
    const groupSnapshot = inFlightChatsRef.current.get(activeRequestId);
    const group =
      groupSnapshot != null
        ? [...nexusMultiResponseGroupsRef.current.values()].find((item) => item.messageId === activeRequestId)
        : undefined;
    if (group) {
      await Promise.all([...group.pending].map((rid) => window.electronAPI.stopChat(rid)));
      for (const rid of group.requestIds) {
        nexusMultiResponseGroupsRef.current.delete(rid);
      }
      inFlightChatsRef.current.delete(group.messageId);
    } else {
      await window.electronAPI.stopChat(activeRequestId);
    }
    setChatStreaming(false);
    setActiveRequestId(undefined);
  };

  const runInlineTerminal = useCallback(async (command: string) => {
    if (!command.trim() || !workspaceRoot) return;
    setInlineTerminalLogs((c) => c + `> ${command}\n`);
    const result = await window.electronAPI.runCommand(command, workspaceRoot);
    setInlineTerminalJobId(result.jobId);
    inlineTerminalJobIdRef.current = result.jobId;
  }, [workspaceRoot]);

  const killInlineTerminal = useCallback(async () => {
    if (!inlineTerminalJobId) return;
    await window.electronAPI.killCommand(inlineTerminalJobId);
    setInlineTerminalJobId(undefined);
    inlineTerminalJobIdRef.current = undefined;
    setInlineTerminalLogs((c) => c + '\n[termination requested]\n');
  }, [inlineTerminalJobId]);

  const nexusSettingsParticipants = useMemo(() => {
    if (!nexusDraft) return [];
    const sorted = [...nexusDraft.members].sort((a, b) => {
      if (a.role === 'leader' && b.role !== 'leader') return -1;
      if (b.role === 'leader' && a.role !== 'leader') return 1;
      return 0;
    });
    return sorted.map((m) => {
      const meta = chatList.find((c) => c.id === m.wizardId && c.kind === 'wizard');
      return {
        wizardId: m.wizardId,
        role: m.role,
        name: meta?.wizard?.name ?? 'Wizard',
        workspaceRoot: meta?.wizard?.workspaceRoot
      };
    });
  }, [nexusDraft, chatList]);

  const nexusAvailableWizardsToAdd = useMemo(() => {
    if (!nexusDraft) return [];
    const memberIds = new Set(nexusDraft.members.map((m) => m.wizardId));
    return wizardChatList
      .filter((w) => !memberIds.has(w.id))
      .map((w) => ({ id: w.id, name: w.wizard?.name ?? w.title }));
  }, [nexusDraft, wizardChatList]);

  const activeBuffer = activeFilePath ? buffers[activeFilePath] : undefined;
  const selectedProvider = settings?.providers[settings.selectedProvider];
  const isWizardActive = Boolean(activeWizard);
  const isNexusActive = Boolean(activeNexus);
  const chatPanelIsWizard = Boolean(isWizardActive && !showWizardHubPlaceholder);
  /** Per-chat model override wins in the top bar and footer over the global default. */
  const effectiveHeaderModelId =
    (activeNexus
      ? chatList.find((chat) => chat.id === activeNexus.leaderWizardId)?.wizard?.model
      : activeWizard?.model) ?? effectiveModelOverride?.model ?? selectedProvider?.model ?? '';
  const openRouterReady =
    settings && settings.selectedProvider === 'openrouter'
      ? Boolean(settings.providers.openrouter.apiKey?.trim())
      : true;
  const providerConnected = activeNexus
    ? Boolean(effectiveHeaderModelId)
    : activeWizard
    ? Boolean(activeWizard.model)
    : Boolean(settings && openRouterReady && models.length > 0 && selectedProvider?.model);
  /** Catalog row for context window size (respects per-chat provider override lists). */
  const modelCatalogForLimit = effectiveModelOverride ? overrideModels : models;
  const resolvedContextLimit = (() => {
    const id = effectiveHeaderModelId.trim();
    if (!id) return 131072;
    return modelCatalogForLimit.find((m) => m.id === id)?.contextLength ?? 131072;
  })();
  const selectedProviderLabel =
    (activeNexus
      ? chatList.find((chat) => chat.id === activeNexus.leaderWizardId)?.wizard?.provider
      : activeWizard?.provider ?? settings?.selectedProvider) === 'openrouter'
      ? 'OpenRouter'
      : 'LM Studio';
  const sessionMode = activeWizard || activeNexus ? 'agent' : (settings?.ui.sessionMode ?? 'agent');
  const isDarwin = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
  const wizardPromptDiff = wizardPromptApproval
    ? diffPromptLines(wizardPromptApproval.before, wizardPromptApproval.after)
    : { left: [], right: [] };
  const toolApprovalDiff =
    toolApprovalRequest &&
    typeof toolApprovalRequest.diffBefore === 'string' &&
    typeof toolApprovalRequest.diffAfter === 'string'
      ? diffPromptLines(toolApprovalRequest.diffBefore, toolApprovalRequest.diffAfter)
      : null;

  return (
    <div className="app-shell">
      <div className="background-grid" />
      <OnboardingDialog onComplete={completeOnboarding} open={showOnboarding} />
      <AnimatePresence>
        {showWebSearchNotice ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="app-dialog"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="app-dialog__kicker">Web Search</div>
              <h3>Search works better with an API key</h3>
              <p>
                Mythra can search without a key, but the built-in DuckDuckGo fallback only returns short instant
                answers and often misses normal web results. For better AI search, add a Tavily or Brave Search API key
                in Settings. Tavily is the simplest recommendation for AI-ready results; Brave is a strong general web
                search option.
              </p>
              <div className="app-dialog__links">
                <a
                  className="app-dialog__link"
                  href="https://tavily.com/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://tavily.com/');
                  }}
                  rel="noreferrer"
                >
                  Tavily
                </a>
                <span aria-hidden className="app-dialog__links-sep">
                  ·
                </span>
                <a
                  className="app-dialog__link"
                  href="https://brave.com/search/api/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://brave.com/search/api/');
                  }}
                  rel="noreferrer"
                >
                  Brave Search API
                </a>
              </div>
              <div className="app-dialog__actions">
                <button className="btn btn--secondary" onClick={() => setShowWebSearchNotice(false)} type="button">
                  Not now
                </button>
                <button className="btn btn--primary" onClick={jumpToSearchSettings} type="button">
                  Add API key
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <SystemPromptInfoDialog onClose={() => setShowSystemPromptHelp(false)} open={showSystemPromptHelp} />
      <WizardExportDialog
        onClose={() => setWizardExportChat(null)}
        onStatusMessage={(msg) => setSettingsStatus(msg)}
        open={wizardExportChat !== null}
        wizardChat={wizardExportChat}
      />
      <SystemPromptModal
        open={showSystemPromptModal && Boolean(settings)}
        value={settings?.providers[settings.selectedProvider].systemPrompt ?? ''}
        onChange={(v) => {
          const s = settingsRef.current;
          if (!s) return;
          handleSettingsPanelChange(patchSystemPromptInSettings(s, v));
        }}
        onClose={() => setShowSystemPromptModal(false)}
      />
      <WizardSetupModal
        onClose={() => setShowWizardSetup(false)}
        onCreate={createWizard}
        onListModels={listModelsForWizardSetup}
        onPersistWizardProjectsParentFolder={persistWizardProjectsParentFolder}
        open={showWizardSetup}
        settings={settings}
      />
      <NexusSetupModal
        onClose={() => setShowNexusSetup(false)}
        onCreate={createNexus}
        open={showNexusSetup}
        wizards={wizardChatList}
      />
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete Wizard"
        confirmVariant="danger"
        description={
          <>
            Delete <strong>{wizardDeleteTarget?.title ?? 'this Wizard'}</strong> from Mythra? This removes the Wizard
            entry and its conversation history, but does not delete its workspace folder yet.
          </>
        }
        kicker="Delete Wizard"
        onCancel={() => setWizardDeleteTarget(null)}
        onConfirm={() => void confirmDeleteWizard()}
        open={Boolean(wizardDeleteTarget)}
        title="Are you sure?"
      />
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete Nexus project"
        confirmVariant="danger"
        description={
          <>
            Delete Nexus project <strong>{nexusDeleteTarget?.title ?? 'this project'}</strong> from Mythra? This removes
            the project entry and all Nexus rooms / conversation history, but does not delete its shared workspace folder
            yet.
          </>
        }
        kicker="Delete Nexus project"
        onCancel={() => setNexusDeleteTarget(null)}
        onConfirm={() => void confirmDeleteNexus()}
        open={Boolean(nexusDeleteTarget)}
        title="Are you sure?"
      />
      <AppConfirmDialog
        cancelLabel="Keep folder"
        confirmLabel="Delete folder"
        confirmVariant="danger"
        description={
          workspaceDeleteTarget?.variant === 'nexus' ? (
            <>
              Also delete the shared Nexus workspace folder for <strong>{workspaceDeleteTarget.label}</strong> and all
              files inside it?
              <br />
              <code className="app-dialog__code">{workspaceDeleteTarget.workspaceRoot}</code>
            </>
          ) : (
            <>
              Also delete <strong>{workspaceDeleteTarget?.label ?? 'this Wizard'}</strong>&apos;s workspace folder and
              all files inside it?
              <br />
              <code className="app-dialog__code">{workspaceDeleteTarget?.workspaceRoot}</code>
            </>
          )
        }
        kicker={workspaceDeleteTarget?.variant === 'nexus' ? 'Nexus workspace' : 'Wizard Workspace'}
        onCancel={() => setWorkspaceDeleteTarget(null)}
        onConfirm={() => {
          const target = workspaceDeleteTarget;
          setWorkspaceDeleteTarget(null);
          if (!target) return;
          void window.electronAPI.deleteWizardWorkspace(target.workspaceRoot).then(() => {
            if (workspaceRootRef.current === target.workspaceRoot) {
              setWorkspaceRoot(undefined);
              setWorkspaceTree([]);
              setWorkspaceChanges(null);
              setBuffers({});
              setActiveFilePath(undefined);
            }
          });
        }}
        open={Boolean(workspaceDeleteTarget)}
        title="Delete its workspace too?"
      />
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete session"
        confirmVariant="danger"
        description={
          <>
            Delete <strong>{wizardSessionDeleteTarget?.title ?? 'this session'}</strong>? This only removes this
            conversation history. The Wizard, workspace, and core documents will stay.
          </>
        }
        kicker="Delete Session"
        onCancel={() => setWizardSessionDeleteTarget(null)}
        onConfirm={() => {
          const target = wizardSessionDeleteTarget;
          setWizardSessionDeleteTarget(null);
          if (target) void deleteWizardSession(target);
        }}
        open={Boolean(wizardSessionDeleteTarget)}
        title="Delete this Wizard session?"
      />
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete room"
        confirmVariant="danger"
        description={
          <>
            Delete Nexus room <strong>{nexusSessionDeleteTarget?.title ?? 'this session'}</strong>? This only removes this
            conversation. The Nexus project, shared workspace, and Wizard profiles stay.
          </>
        }
        kicker="Delete Nexus room"
        onCancel={() => setNexusSessionDeleteTarget(null)}
        onConfirm={() => {
          const target = nexusSessionDeleteTarget;
          setNexusSessionDeleteTarget(null);
          if (target) void deleteNexusSession(target);
        }}
        open={Boolean(nexusSessionDeleteTarget)}
        title="Delete this Nexus room?"
      />
      <AnimatePresence>
        {wizardPromptApproval ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop app-dialog-backdrop--overlay-top"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="app-dialog wizard-prompt-approval"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="wizard-prompt-approval__intro">
                <div className="app-dialog__kicker">Wizard System Prompt</div>
                <h3>{wizardPromptApproval.title}</h3>
                <p>
                  {wizardPromptApproval.wizardName} wants to replace its private system prompt. Review the change before
                  allowing it.
                </p>
              </div>
              <div className="wizard-prompt-approval__compare">
                <section>
                  <h4>Original</h4>
                  <pre>
                    {wizardPromptDiff.left.map((line, index) => (
                      <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`${index}-${line.kind}`}>
                        {line.text || ' '}
                      </span>
                    ))}
                  </pre>
                </section>
                <div className="wizard-prompt-approval__arrow" aria-hidden>
                  --&gt;
                </div>
                <section>
                  <h4>New</h4>
                  <pre>
                    {wizardPromptDiff.right.map((line, index) => (
                      <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`${index}-${line.kind}`}>
                        {line.text || ' '}
                      </span>
                    ))}
                  </pre>
                </section>
              </div>
              <div className="app-dialog__actions">
                <button
                  className="btn btn--secondary"
                  onClick={() => {
                    const id = wizardPromptApproval.id;
                    setWizardPromptApproval(null);
                    void window.electronAPI.respondWizardPromptApproval(id, false);
                  }}
                  type="button"
                >
                  Deny
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    const id = wizardPromptApproval.id;
                    setWizardPromptApproval(null);
                    void window.electronAPI.respondWizardPromptApproval(id, true);
                  }}
                  type="button"
                >
                  Approve
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {toolApprovalRequest ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop app-dialog-backdrop--overlay-top"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className={`app-dialog app-dialog--scrollable ${toolApprovalDiff ? 'wizard-prompt-approval' : 'tool-approval-dialog'}`}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="app-dialog__kicker">Approval required</div>
              <h3>{toolApprovalRequest.title}</h3>
              {toolApprovalDiff ? (
                <>
                  <div className="wizard-prompt-approval__intro">
                    <p id="tool-approval-desc">{toolApprovalRequest.detail}</p>
                  </div>
                  <div aria-describedby="tool-approval-desc" className="wizard-prompt-approval__compare">
                    <section>
                      <h4>Before</h4>
                      <pre>
                        {toolApprovalDiff.left.map((line, index) => (
                          <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`tool-dl-${index}-${line.kind}`}>
                            {line.text || ' '}
                          </span>
                        ))}
                      </pre>
                    </section>
                    <div className="wizard-prompt-approval__arrow" aria-hidden>
                      --&gt;
                    </div>
                    <section>
                      <h4>After</h4>
                      <pre>
                        {toolApprovalDiff.right.map((line, index) => (
                          <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`tool-dr-${index}-${line.kind}`}>
                            {line.text || ' '}
                          </span>
                        ))}
                      </pre>
                    </section>
                  </div>
                </>
              ) : (
                <pre className="tool-approval-dialog__detail">{toolApprovalRequest.detail}</pre>
              )}
              <div className="app-dialog__actions">
                <button
                  className="btn btn--secondary"
                  onClick={() => {
                    const id = toolApprovalRequest.id;
                    setToolApprovalRequest(null);
                    void window.electronAPI.respondToolApproval(id, false);
                  }}
                  type="button"
                >
                  Deny
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    const id = toolApprovalRequest.id;
                    setToolApprovalRequest(null);
                    void window.electronAPI.respondToolApproval(id, true);
                  }}
                  type="button"
                >
                  Approve
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {showConnectionHelp ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-describedby="connection-help-desc"
              aria-labelledby="connection-help-title"
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="app-dialog app-dialog--scrollable"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="app-dialog__kicker">Connection</div>
              <h3 id="connection-help-title">Need help?</h3>
              <p id="connection-help-desc">
                Mythra sends your chats to an LLM through either <strong>OpenRouter</strong> (many cloud models, one API
                key) or <strong>LM Studio</strong> (models running on your computer). Use the guide below for the option
                you prefer.
              </p>
              <div className="app-dialog__section">
                <div className="app-dialog__section-title">OpenRouter</div>
                <p>
                  OpenRouter is a service that routes requests to a large catalog of hosted models so you do not run the
                  weights locally. In Mythra, choose <strong>OpenRouter</strong> under Provider, paste an API key from
                  your OpenRouter account (for example <code className="app-dialog__code">sk-or-v1-…</code>), then pick a
                  model. The default base URL points at OpenRouter’s API and usually does not need changing. Your key is
                  stored only in this app’s settings on your machine.
                </p>
              </div>
              <div className="app-dialog__section">
                <div className="app-dialog__section-title">LM Studio</div>
                <p>
                  LM Studio is a desktop app that downloads and runs models on your own hardware. Install it, load a
                  model, and start the <strong>local server</strong> (often on port <code className="app-dialog__code">1234</code>
                  ). In Mythra, choose <strong>LM Studio</strong>, confirm the base URL matches your server (the default
                  is <code className="app-dialog__code">http://127.0.0.1:1234/v1</code>), then use <strong>Test +
                  Refresh</strong> to load the model list. The server key defaults to{' '}
                  <code className="app-dialog__code">lm-studio</code> unless you changed it in LM Studio.
                </p>
              </div>
              <div className="app-dialog__links">
                <a
                  className="app-dialog__link"
                  href="https://openrouter.ai/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://openrouter.ai/');
                  }}
                  rel="noreferrer"
                >
                  OpenRouter website
                </a>
                <span aria-hidden className="app-dialog__links-sep">
                  ·
                </span>
                <a
                  className="app-dialog__link"
                  href="https://lmstudio.ai/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://lmstudio.ai/');
                  }}
                  rel="noreferrer"
                >
                  LM Studio website
                </a>
              </div>
              <div className="app-dialog__actions">
                <button className="btn btn--primary" onClick={() => setShowConnectionHelp(false)} type="button">
                  Got it
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {isDarwin ? <div aria-hidden className="app-titlebar" /> : null}
      <main className="layout layout--atomic">
        <motion.aside
          animate={{ opacity: 1, x: 0 }}
          className="sidebar"
          initial={{ opacity: 0, x: -16 }}
          transition={{ delay: 0.05, duration: 0.4 }}
        >
          <div className="sidebar-card">
            <div className="sidebar-brand">
              <div className="sidebar-brand__badge">ML</div>
              <div className="sidebar-brand__title">
                <img
                  alt="Mythra"
                  className="sidebar-brand__mark-img"
                  decoding="async"
                  key={settings?.ui.themeId ?? 'default'}
                  src={sidebarBrandLogo}
                />
              </div>
            </div>

            <div className="sidebar-quick">
              <div className={`sidebar-new ${showNewMenu ? 'is-open' : ''}`}>
                <button
                  className="sidebar-quick__btn sidebar-quick__btn--primary"
                  onClick={() => setShowNewMenu((v) => !v)}
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  New
                </button>
                <AnimatePresence>
                  {showNewMenu ? (
                    <motion.div
                      animate={{ opacity: 1, y: 0 }}
                      className="sidebar-new__menu"
                      exit={{ opacity: 0, y: -4 }}
                      initial={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15 }}
                    >
                      <button onClick={() => void startNewChat()} type="button">
                        <strong>Normal Chat</strong>
                        <span>Regular chat with Chat and Agent modes.</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowNewMenu(false);
                          setShowWizardSetup(true);
                        }}
                        type="button"
                      >
                        <strong>Wizard</strong>
                        <span>Named AI with its own model, memory, and local workspace.</span>
                      </button>
                      <button
                        disabled={wizardChatList.length < 2}
                        onClick={() => {
                          setShowNewMenu(false);
                          setShowNexusSetup(true);
                        }}
                        type="button"
                      >
                        <strong>Nexus</strong>
                        <span>Shared project room where multiple Wizards coordinate.</span>
                      </button>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              <button
                className="sidebar-quick__btn"
                disabled={Boolean(activeWizard || activeNexus)}
                onClick={chooseWorkspace}
                title={activeWizard || activeNexus ? 'This session uses its own workspace.' : undefined}
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M1 4.5l5-3 5 3v6l-5 3-5-3v-6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                {activeWizard ? 'Wizard workspace' : activeNexus ? 'Nexus workspace' : workspaceRoot ? 'Switch workspace' : 'Open workspace'}
              </button>
              {workspaceRoot && (activeWizard || activeNexus) ? (
                <button
                  className="sidebar-quick__btn"
                  disabled
                  type="button"
                  title="This workspace stays attached while the Wizard or Nexus is selected"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M4 4l6 6M10 4l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  Clear workspace
                </button>
              ) : workspaceRoot ? (
                <button
                  className="sidebar-quick__btn"
                  onClick={clearWorkspace}
                  type="button"
                  title="Unmount the current folder"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M4 4l6 6M10 4l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  Clear workspace
                </button>
              ) : settings?.lastWorkspaceRoot ? (
                <button
                  className="sidebar-quick__btn"
                  onClick={() => void openLastWorkspace()}
                  type="button"
                  title={`Reopen ${settings.lastWorkspaceRoot}`}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M8.25 11V7.25A2.75 2.75 0 005.5 4.5H3.25"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M5.5 2.25L3.25 4.5 5.5 6.75"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Open last workspace
                </button>
              ) : (
                <button
                  className="sidebar-quick__btn"
                  disabled
                  type="button"
                  title="No workspace open"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M4 4l6 6M10 4l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  Clear workspace
                </button>
              )}
            </div>

            <div className="sidebar-tabs" role="tablist">
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'chats' ? 'is-active' : ''}`}
                onClick={handleChatsTabClick}
                type="button"
                role="tab"
              >
                Chats
              </button>
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'wizards' ? 'is-active' : ''}`}
                onClick={() => setSidebarTab('wizards')}
                type="button"
                role="tab"
              >
                Wizards
              </button>
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'files' ? 'is-active' : ''}`}
                onClick={() => setSidebarTab('files')}
                type="button"
                role="tab"
              >
                Files
              </button>
            </div>

            <div className="sidebar-content">
              <AnimatePresence mode="wait">
                {sidebarTab === 'chats' ? (
                  <motion.div
                    key="chats"
                    className="sidebar-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {settings ? (
                      <div className={`chat-thread-options ${chatModelExpanded ? 'is-expanded' : ''}`}>
                        <button
                          className="chat-thread-options__header"
                          onClick={() => setChatModelExpanded((v) => !v)}
                          type="button"
                        >
                          <span className="chat-thread-options__header-left">
                            <svg
                              className="chat-thread-options__chevron"
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              aria-hidden
                            >
                              <path d="M4 2.5L7.5 6 4 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span className="chat-thread-options__title">Model override</span>
                          </span>
                          {effectiveModelOverride && !chatModelExpanded ? (
                            <span className="chat-thread-options__badge">
                              {pathLabel(effectiveModelOverride.model)}
                            </span>
                          ) : null}
                        </button>

                        <AnimatePresence initial={false}>
                          {chatModelExpanded && (
                            <motion.div
                              key="override-body"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div className="chat-thread-options__body">
                                <label
                                  className={`chat-panel__web-toggle chat-thread-options__web-toggle ${effectiveModelOverride ? 'is-on' : ''}`}
                                >
                                  <input
                                    checked={Boolean(effectiveModelOverride)}
                                    onChange={async (e) => {
                                      if (!settings) return;
                                      if (e.target.checked) {
                                        const list = await window.electronAPI.listModels(settings, overrideModelProvider);
                                        const model = pickDefaultModel(list, list[0]?.id);
                                        if (model) {
                                          await saveChatModelOverride({ provider: overrideModelProvider, model });
                                        }
                                      } else {
                                        await saveChatModelOverride(null);
                                      }
                                    }}
                                    type="checkbox"
                                  />
                                  <span className="chat-thread-options__model-toggle-text">
                                    <span>Use a specific model</span>
                                    <span>only for this chat</span>
                                  </span>
                                  <span className="chat-panel__web-toggle-track">
                                    <span className="chat-panel__web-toggle-knob" />
                                  </span>
                                </label>

                                <AnimatePresence initial={false}>
                                  {effectiveModelOverride ? (
                                    <motion.div
                                      key="override-fields"
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: 'auto', opacity: 1 }}
                                      exit={{ height: 0, opacity: 0 }}
                                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                                      style={{ overflow: 'hidden' }}
                                    >
                                      <div className="chat-thread-options__fields">
                                        <label className="chat-thread-options__field">
                                          <span className="chat-thread-options__field-label">Provider</span>
                                          <AppSelect
                                            className="app-select--compact"
                                            options={providerOptions}
                                            portalDropdown
                                            onChange={async (p) => {
                                              setOverrideModelProvider(p);
                                              if (!settings) return;
                                              const list = await window.electronAPI.listModels(settings, p);
                                              const model = pickDefaultModel(list, undefined);
                                              if (model) {
                                                await saveChatModelOverride({ provider: p, model });
                                              }
                                            }}
                                            value={overrideModelProvider}
                                          />
                                        </label>
                                        <div className="chat-thread-options__field">
                                          <span className="chat-thread-options__field-label">Model</span>
                                          <ModelSearch
                                            models={overrideModels}
                                            value={effectiveModelOverride.model}
                                            favoriteIds={settings.ui.favoriteModels?.[overrideModelProvider] ?? []}
                                            portalDropdown
                                            onChange={async (model) => {
                                              if (model) {
                                                await saveChatModelOverride({ provider: overrideModelProvider, model });
                                              }
                                            }}
                                            onToggleFavorite={(id) => {
                                              if (!settings) return;
                                              const baseFav = settings.ui.favoriteModels ?? defaultSettings.ui.favoriteModels;
                                              const nextSet = new Set(baseFav[overrideModelProvider] ?? []);
                                              if (nextSet.has(id)) nextSet.delete(id);
                                              else nextSet.add(id);
                                              const next: AppSettings = {
                                                ...settings,
                                                ui: {
                                                  ...settings.ui,
                                                  favoriteModels: {
                                                    ...baseFav,
                                                    [overrideModelProvider]: [...nextSet].sort((a, b) => a.localeCompare(b))
                                                  }
                                                }
                                              };
                                              setSettings(next);
                                              void persistSettingsToDisk(next);
                                            }}
                                          />
                                        </div>
                                      </div>
                                    </motion.div>
                                  ) : null}
                                </AnimatePresence>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    ) : null}
                    {normalChatList.length === 0 ? (
                      <div className="sidebar-empty">
                        <p>No conversations yet. Start a new chat to begin.</p>
                      </div>
                    ) : (
                      <div className="chat-list">
                        {normalChatList.map((chat) => (
                          <div
                            key={chat.id}
                            className={`chat-list__item ${activeChatId === chat.id ? 'is-active' : ''} ${chat.pinned ? 'is-pinned' : ''}`}
                            onClick={() => loadChat(chat.id)}
                          >
                            {editingTitleId === chat.id ? (
                              <div className="chat-list__content chat-list__content--editing" onClick={(e) => e.stopPropagation()}>
                                <input
                                  autoFocus
                                  className="chat-list__title-input"
                                  onBlur={(e) => {
                                    void commitRenameChat(chat.id, e.target.value);
                                  }}
                                  onChange={(e) => setEditingTitleDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') {
                                      e.currentTarget.blur();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      skipNextRenameCommitRef.current = true;
                                      cancelRenameChat();
                                    }
                                  }}
                                  value={editingTitleDraft}
                                />
                              </div>
                            ) : (
                              <div className="chat-list__content">
                                <div className="chat-list__title">{chat.title}</div>
                                <div className="chat-list__date">{formatRelativeDate(chat.updatedAt)}</div>
                              </div>
                            )}
                            {editingTitleId === chat.id ? null : (
                              <div className="chat-list__row-actions" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className={`chat-list__pin ${chat.pinned ? 'is-active' : ''}`}
                                  onClick={(e) => void togglePinChat(e, chat.id)}
                                  type="button"
                                  title={chat.pinned ? 'Unpin' : 'Pin to top'}
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M6 1.2L2.2 5.2V10h7.6V5.2L6 1.2z"
                                      fill={chat.pinned ? 'currentColor' : 'none'}
                                      stroke="currentColor"
                                      strokeLinejoin="round"
                                      strokeWidth="1.1"
                                    />
                                  </svg>
                                </button>
                                <button
                                  className="chat-list__rename"
                                  onClick={(e) => beginRenameChat(e, chat.id, chat.title)}
                                  type="button"
                                  title="Rename"
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M7.3 1.2l3.4 3.4-7.5 7.5H.8V8.7l7.5-7.5zM1.5 7.6v1.2h1.2l5.6-5.6L7 2 1.5 7.5z"
                                      fill="currentColor"
                                    />
                                  </svg>
                                </button>
                                <button
                                  className="chat-list__delete"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    requestDeleteChat(chat);
                                  }}
                                  onMouseDown={(e) => e.preventDefault()}
                                  type="button"
                                  title="Delete chat"
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ) : sidebarTab === 'wizards' ? (
                  <motion.div
                    key="wizards"
                    className="sidebar-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {wizardChatList.length === 0 && nexusProjectList.length === 0 ? (
                      <div className="sidebar-empty">
                        <p>No Wizards yet. Create one from New to give it a model, memory, and workspace.</p>
                      </div>
                    ) : wizardsSidebarPane === 'nexus' ? (
                      nexusProjectList.length > 0 ? (
                        <div className="chat-list">
                          <div className="nexus-sidebar-section">
                            <div className="nexus-sidebar-section__label">Nexus</div>
                            {nexusProjectList.map((project) => {
                              const sessions = nexusSessionsByNexusId.get(project.id) ?? [];
                              const leader = project.nexus
                                ? chatList.find((chat) => chat.id === project.nexus?.leaderWizardId)?.wizard?.name
                                : undefined;
                              return (
                                <div className="wizard-group wizard-group--nexus" key={project.id}>
                                  <div
                                    aria-expanded={expandedNexusIds.has(project.id)}
                                    className={`chat-list__item chat-list__item--wizard chat-list__item--nexus ${activeNexusMeta?.id === project.id ? 'is-active' : ''} ${project.pinned ? 'is-pinned' : ''}`}
                                    onClick={() => {
                                      void handleNexusSidebarRowActivate(project);
                                    }}
                                  >
                                    <div className="chat-list__content">
                                      <div className="chat-list__title wizard-title-row">
                                        <svg
                                          className={`wizard-title-row__chevron ${expandedNexusIds.has(project.id) ? 'is-open' : ''}`}
                                          width="12"
                                          height="12"
                                          viewBox="0 0 12 12"
                                          fill="none"
                                          aria-hidden
                                        >
                                          <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                        <span title={project.title}>{project.title}</span>
                                      </div>
                                      <div className="chat-list__date">
                                        Nexus · {leader ?? 'Leader'} · {sessions.length} sessions
                                      </div>
                                    </div>
                                    <div className="chat-list__row-actions" onClick={(e) => e.stopPropagation()}>
                                      <button
                                        className={`chat-list__pin ${project.pinned ? 'is-active' : ''}`}
                                        onClick={(e) => void togglePinChat(e, project.id)}
                                        type="button"
                                        title={project.pinned ? 'Unpin' : 'Pin to top'}
                                      >
                                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                          <path
                                            d="M6 1.2L2.2 5.2V10h7.6V5.2L6 1.2z"
                                            fill={project.pinned ? 'currentColor' : 'none'}
                                            stroke="currentColor"
                                            strokeLinejoin="round"
                                            strokeWidth="1.1"
                                          />
                                        </svg>
                                      </button>
                                      <button
                                        className="chat-list__delete"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          requestDeleteChat(project);
                                        }}
                                        onMouseDown={(e) => e.preventDefault()}
                                        type="button"
                                        title="Delete Nexus project"
                                      >
                                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                          <path
                                            d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3"
                                            stroke="currentColor"
                                            strokeWidth="1.2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                  <motion.div
                                    aria-hidden={!expandedNexusIds.has(project.id)}
                                    className="wizard-session-list-anim"
                                    initial={false}
                                    animate={{ height: expandedNexusIds.has(project.id) ? 'auto' : 0 }}
                                    style={{
                                      overflow: 'hidden',
                                      pointerEvents: expandedNexusIds.has(project.id) ? 'auto' : 'none'
                                    }}
                                    transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
                                  >
                                    <div className="wizard-session-list">
                                      <button className="wizard-session-button wizard-session-button--nexus" onClick={() => void createNexusSession(project)} type="button">
                                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
                                          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        </svg>
                                        New room
                                      </button>
                                      {sessions.map((session) => (
                                        <div
                                          className={`wizard-session-row ${activeChatId === session.id ? 'is-active' : ''}`}
                                          key={session.id}
                                          onClick={() => void loadChat(session.id)}
                                          role="button"
                                          tabIndex={0}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                              e.preventDefault();
                                              void loadChat(session.id);
                                            }
                                          }}
                                        >
                                          <span title={session.title}>{session.title}</span>
                                          <div className="wizard-session-row__meta">
                                            <small>{formatRelativeDate(session.updatedAt)}</small>
                                            <button
                                              aria-label={`Delete ${session.title}`}
                                              className="wizard-session-row__delete"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                requestDeleteChat(session);
                                              }}
                                              title="Delete room"
                                              type="button"
                                            >
                                              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                                                <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                              </svg>
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </motion.div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="sidebar-empty">
                          <p>
                            No Nexus projects yet. Use <strong>New → Nexus</strong> with at least two Wizards.
                          </p>
                          {wizardChatList.length > 0 ? (
                            <p>
                              Switch to <strong>Wizards</strong> below to open individual Wizard workspaces.
                            </p>
                          ) : null}
                        </div>
                      )
                    ) : wizardChatList.length > 0 ? (
                      <div className="chat-list">
                        <div className="nexus-sidebar-section">
                            <div className="nexus-sidebar-section__label">Wizards</div>
                        {wizardChatList.map((chat) => (
                          <div className="wizard-group" key={chat.id}>
                            <div
                              aria-expanded={expandedWizardIds.has(chat.id)}
                              className={`chat-list__item chat-list__item--wizard ${activeWizardMeta?.id === chat.id ? 'is-active' : ''} ${chat.pinned ? 'is-pinned' : ''}`}
                              onClick={() => {
                                void handleWizardSidebarRowActivate(chat);
                              }}
                            >
                              <div className="chat-list__content">
                                <div className="chat-list__title wizard-title-row">
                                  <svg
                                    className={`wizard-title-row__chevron ${expandedWizardIds.has(chat.id) ? 'is-open' : ''}`}
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    aria-hidden
                                  >
                                    <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                  <span title={chat.title}>{chat.title}</span>
                                </div>
                                <div className="chat-list__date">
                                  Wizard · {(wizardSessionsByWizardId.get(chat.id) ?? []).length} sessions
                                </div>
                              </div>
                              <div className="chat-list__row-actions" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className={`chat-list__pin ${chat.pinned ? 'is-active' : ''}`}
                                  onClick={(e) => void togglePinChat(e, chat.id)}
                                  type="button"
                                  title={chat.pinned ? 'Unpin' : 'Pin to top'}
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path d="M6 1.2L2.2 5.2V10h7.6V5.2L6 1.2z" fill={chat.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeLinejoin="round" strokeWidth="1.1" />
                                  </svg>
                                </button>
                                <button
                                  className="chat-list__export"
                                  onClick={(e) => beginWizardExport(e, chat)}
                                  type="button"
                                  title="Export Wizard bundle"
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M6 1v6m0 0l2.8-2.8M6 7L3.2 4.2M2 11h8"
                                      stroke="currentColor"
                                      strokeWidth="1.25"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </button>
                                <button className="chat-list__delete" onClick={(e) => { e.stopPropagation(); requestDeleteChat(chat); }} onMouseDown={(e) => e.preventDefault()} type="button" title="Delete Wizard">
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <motion.div
                              aria-hidden={!expandedWizardIds.has(chat.id)}
                              className="wizard-session-list-anim"
                              initial={false}
                              animate={{
                                height: expandedWizardIds.has(chat.id) ? 'auto' : 0
                              }}
                              style={{
                                overflow: 'hidden',
                                pointerEvents: expandedWizardIds.has(chat.id) ? 'auto' : 'none'
                              }}
                              transition={{
                                duration: 0.32,
                                ease: [0.4, 0, 0.2, 1]
                              }}
                            >
                              <div className="wizard-session-list">
                                <button className="wizard-session-button" onClick={() => void createWizardSession(chat)} type="button">
                                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
                                    <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                  </svg>
                                  New session
                                </button>
                                {(wizardSessionsByWizardId.get(chat.id) ?? []).map((session) => (
                                  <div
                                    className={`wizard-session-row ${activeChatId === session.id ? 'is-active' : ''}`}
                                    key={session.id}
                                    onClick={() => void loadChat(session.id)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        void loadChat(session.id);
                                      }
                                    }}
                                  >
                                    <span title={session.title}>{session.title}</span>
                                    <div className="wizard-session-row__meta">
                                      <small>{formatRelativeDate(session.updatedAt)}</small>
                                      <button
                                        aria-label={`Delete ${session.title}`}
                                        className="wizard-session-row__delete"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          requestDeleteChat(session);
                                        }}
                                        title="Delete session"
                                        type="button"
                                      >
                                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                                          <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          </div>
                        ))}
                        </div>
                      </div>
                    ) : (
                      <div className="sidebar-empty">
                        <p>No Wizards yet. Create one from <strong>New</strong>.</p>
                        {nexusProjectList.length > 0 ? (
                          <p>
                            Or switch to <strong>Nexus</strong> below for shared projects.
                          </p>
                        ) : null}
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="files"
                    className="sidebar-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {workspaceRoot ? (
                      <>
                        <div className="workspace-meta">
                          <div className="workspace-meta__value">{pathLabel(workspaceRoot)}</div>
                          <div className="workspace-meta__hint">{workspaceRoot}</div>
                        </div>
                        <FileTree activePath={activeFilePath} nodes={workspaceTree} onOpen={openFile} />
                      </>
                    ) : (
                      <div className="sidebar-empty">
                        <p>Open a workspace to browse and edit project files.</p>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="sidebar-footer">
              {sidebarTab === 'wizards' ? (
                <div className="wizards-pane-mode-toggle" role="tablist" aria-label="Wizards sidebar view">
                  <button
                    aria-selected={wizardsSidebarPane === 'wizards'}
                    className={`wizards-pane-mode-toggle__btn ${wizardsSidebarPane === 'wizards' ? 'is-active' : ''}`}
                    onClick={() => {
                      setWizardsSidebarPane('wizards');
                      setSidebarFocusedNexusId(undefined);
                    }}
                    role="tab"
                    type="button"
                  >
                    Wizards
                  </button>
                  <button
                    aria-selected={wizardsSidebarPane === 'nexus'}
                    className={`wizards-pane-mode-toggle__btn ${wizardsSidebarPane === 'nexus' ? 'is-active' : ''}`}
                    onClick={() => {
                      setWizardsSidebarPane('nexus');
                      setSidebarFocusedWizardId(undefined);
                    }}
                    role="tab"
                    type="button"
                  >
                    Nexus
                  </button>
                  <span
                    className="wizards-pane-mode-toggle__slider"
                    style={{
                      transform: wizardsSidebarPane === 'wizards' ? 'translateX(0)' : 'translateX(100%)'
                    }}
                  />
                </div>
              ) : null}
              <div className="sidebar-footer__meta">
                <span>{selectedProviderLabel}</span>
                <span
                  className={`sidebar-footer__dot ${
                    providerConnected ? 'is-live' : modelCatalogSettled ? 'is-disconnected' : ''
                  }`}
                />
                <span>
                  {effectiveHeaderModelId ? pathLabel(effectiveHeaderModelId) : 'No model'}
                </span>
              </div>
            </div>
          </div>
        </motion.aside>

        <motion.section
          animate={{ opacity: 1, y: 0 }}
          className="center-stage"
          initial={{ opacity: 0, y: 12 }}
          transition={{ delay: 0.1, duration: 0.4 }}
        >
          <ChatPanel
            attachments={chatAttachments}
            chatMessages={chatMessages}
            contextLimit={resolvedContextLimit}
            input={chatInput}
            isStreaming={chatStreaming}
            isNexus={isNexusActive}
            isWizard={chatPanelIsWizard}
            lastTokenUsage={lastTokenUsage}
            nexusRelayProgress={nexusRelayProgress}
            nexusRelayQueueDuringStream={Boolean(nexusRelayProgress)}
            sessionSubheading={chatSessionSubheading}
            timeline={chatTimeline}
            wizardHubPlaceholder={showWizardHubPlaceholder}
            onOpenWizardCreator={() => setShowWizardSetup(true)}
            onAttachImages={addChatAttachments}
            onInputChange={setChatInput}
            onRemoveAttachment={(id) => setChatAttachments((c) => c.filter((a) => a.id !== id))}
            onSend={sendChat}
            onStop={stopChat}
            modelCatalogSettled={Boolean(settings) && modelCatalogSettled}
            providerConnected={providerConnected}
            webSearch={settings?.ui.webSearch ?? false}
            webSearchDisabled={!settings}
            onWebSearchChange={handleWebSearchChange}
            onSessionModeToggle={handleSessionModeToggle}
            sessionModeToggleDisabled={!settings || chatPanelIsWizard || isNexusActive}
            sessionMode={sessionMode}
            selectedModel={effectiveHeaderModelId}
            selectedProviderLabel={selectedProviderLabel}
            hasWorkspace={Boolean(workspaceRoot)}
            terminalLogs={inlineTerminalLogs}
            terminalJobId={inlineTerminalJobId}
            onTerminalRun={runInlineTerminal}
            onTerminalKill={killInlineTerminal}
            chatThreadBackgroundUrl={chatThreadBackgroundUrl}
          />
        </motion.section>

        <motion.aside
          animate={{ opacity: 1, x: 0 }}
          className="inspector"
          initial={{ opacity: 0, x: 16 }}
          transition={{ delay: 0.15, duration: 0.4 }}
        >
          <div className="inspector-card">
            <div className="inspector-switcher">
              <button
                className={`inspector-tab ${inspectorTab === 'editor' ? 'is-active' : ''}`}
                onClick={() => setInspectorTab('editor')}
                type="button"
              >
                Editor
              </button>
              <button
                className={`inspector-tab ${inspectorTab === 'changes' ? 'is-active' : ''}`}
                onClick={() => {
                  setInspectorTab('changes');
                  void refreshWorkspaceChanges();
                }}
                type="button"
              >
                Changes
              </button>
              <button
                className={`inspector-tab ${inspectorTab === 'settings' ? 'is-active' : ''}`}
                onClick={() => setInspectorTab('settings')}
                type="button"
              >
                Settings
              </button>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                className="utility-stack"
                animate={{ opacity: 1, y: 0 }}
                initial={{ opacity: 0, y: 8 }}
                key={inspectorTab}
                transition={{ duration: 0.2 }}
              >
                {inspectorTab === 'editor' ? (
                  <EditorPanel
                    content={activeBuffer?.content ?? ''}
                    dirty={activeBuffer?.dirty ?? false}
                    filePath={activeFilePath}
                    imagePreview={activeBuffer?.imagePreview}
                    onChange={(next) => {
                      if (!activeFilePath) return;
                      const cur = buffers[activeFilePath];
                      if (cur?.imagePreview) return;
                      setBuffers((current) => ({
                        ...current,
                        [activeFilePath]: { ...current[activeFilePath], content: next, dirty: true }
                      }));
                    }}
                    onSave={saveActiveFile}
                  />
                ) : null}
                {inspectorTab === 'changes' ? (
                  <ChangesPanel
                    changes={workspaceChanges}
                    loading={changesLoading}
                    onRefresh={() => void refreshWorkspaceChanges()}
                    workspaceRoot={workspaceRoot}
                  />
                ) : null}
                {inspectorTab === 'settings' && settings ? (
                  <div className="inspector-settings-wrap">
                    {activeWizard ? (
                      <div className="inspector-settings-scope" role="group" aria-label="Which settings to edit">
                        <div className="session-mode-toggle">
                          <button
                            className={`session-mode-toggle__option ${settingsInspectorScope === 'general' ? 'is-active' : ''}`}
                            onClick={() => setSettingsInspectorScope('general')}
                            type="button"
                          >
                            General
                          </button>
                          <button
                            className={`session-mode-toggle__option ${settingsInspectorScope === 'wizard' ? 'is-active' : ''}`}
                            onClick={() => setSettingsInspectorScope('wizard')}
                            type="button"
                          >
                            Wizard
                          </button>
                          <span
                            className="session-mode-toggle__slider"
                            style={{
                              transform: settingsInspectorScope === 'wizard' ? 'translateX(100%)' : 'translateX(0)'
                            }}
                          />
                        </div>
                      </div>
                    ) : activeNexus ? (
                      <div className="inspector-settings-scope" role="group" aria-label="Which settings to edit">
                        <div className="session-mode-toggle">
                          <button
                            className={`session-mode-toggle__option ${settingsInspectorScope === 'general' ? 'is-active' : ''}`}
                            onClick={() => setSettingsInspectorScope('general')}
                            type="button"
                          >
                            General
                          </button>
                          <button
                            className={`session-mode-toggle__option ${settingsInspectorScope === 'nexus' ? 'is-active' : ''}`}
                            onClick={() => setSettingsInspectorScope('nexus')}
                            type="button"
                          >
                            Nexus
                          </button>
                          <span
                            className="session-mode-toggle__slider"
                            style={{
                              transform: settingsInspectorScope === 'nexus' ? 'translateX(100%)' : 'translateX(0)'
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {settingsInspectorScope === 'wizard' && wizardDraft ? (
                      <WizardSettingsPanel
                        modelOptions={overrideModels}
                        onChange={handleWizardDraftChange}
                        onOpenDocument={(path) => void openFile(path)}
                        onOpenSystemPromptInfo={() => setShowSystemPromptHelp(true)}
                        onPresetPersist={persistAfterPresetAction}
                        onRefreshModels={refreshWizardModels}
                        onSettingsChangeForFavorites={handleSettingsPanelChange}
                        settings={settings}
                        statusMessage={settingsStatus}
                        wizard={wizardDraft}
                      />
                    ) : settingsInspectorScope === 'nexus' && nexusDraft ? (
                      <NexusSettingsPanel
                        availableWizards={nexusAvailableWizardsToAdd}
                        participants={nexusSettingsParticipants}
                        project={nexusDraft}
                        statusMessage={settingsStatus}
                        onChange={handleNexusDraftChange}
                        onOpenWizard={(wizardId) => {
                          const meta = chatList.find((c) => c.id === wizardId && c.kind === 'wizard');
                          if (meta) void handleWizardSidebarRowActivate(meta);
                        }}
                        onTeamConstraint={(msg) => setSettingsStatus(msg)}
                      />
                    ) : (
                      <SettingsPanel
                        focusSearchSettingsKey={searchSettingsFocusKey}
                        modelOptions={models}
                        onChange={handleSettingsPanelChange}
                        onOpenConnectionHelp={() => setShowConnectionHelp(true)}
                        onOpenSystemPromptInfo={() => setShowSystemPromptHelp(true)}
                        onOpenSystemPromptModal={() => setShowSystemPromptModal(true)}
                        onOpenWebSearchInfo={() => setShowWebSearchNotice(true)}
                        onPresetPersist={persistAfterPresetAction}
                        onRefreshModels={refreshModels}
                        settings={settings}
                        statusMessage={settingsStatus}
                      />
                    )}
                  </div>
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      </main>
    </div>
  );
}
