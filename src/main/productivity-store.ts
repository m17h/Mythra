import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { ProjectSettings, PromptSnippet, TestRunSummary, ToolHistoryEntry } from '@shared/types';

interface ProductivityData {
  version: 1;
  snippets: PromptSnippet[];
  projectSettings: Record<string, ProjectSettings>;
  toolHistory: ToolHistoryEntry[];
  testRuns: TestRunSummary[];
}

const defaultData = (): ProductivityData => ({
  version: 1,
  snippets: [],
  projectSettings: {},
  toolHistory: [],
  testRuns: []
});

const HISTORY_LIMIT = 500;
const TEST_RUN_LIMIT = 100;

export class ProductivityStore {
  private readonly path = join(app.getPath('userData'), 'mythra-productivity.json');
  private data: ProductivityData | null = null;

  private async loadData(): Promise<ProductivityData> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as ProductivityData;
      this.data = {
        ...defaultData(),
        ...parsed,
        snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],
        projectSettings: parsed.projectSettings && typeof parsed.projectSettings === 'object' ? parsed.projectSettings : {},
        toolHistory: Array.isArray(parsed.toolHistory) ? parsed.toolHistory : [],
        testRuns: Array.isArray(parsed.testRuns) ? parsed.testRuns : []
      };
    } catch {
      this.data = defaultData();
    }
    return this.data;
  }

  private async saveData(data: ProductivityData) {
    this.data = data;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data), 'utf8');
  }

  async listPromptSnippets() {
    const data = await this.loadData();
    return [...data.snippets].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async savePromptSnippet(snippet: PromptSnippet) {
    const data = await this.loadData();
    const next = data.snippets.filter((item) => item.id !== snippet.id);
    next.push(snippet);
    await this.saveData({ ...data, snippets: next });
    return snippet;
  }

  async deletePromptSnippet(id: string) {
    const data = await this.loadData();
    await this.saveData({ ...data, snippets: data.snippets.filter((item) => item.id !== id) });
    return true;
  }

  async getProjectSettings(workspaceRoot: string): Promise<ProjectSettings> {
    const data = await this.loadData();
    return (
      data.projectSettings[workspaceRoot] ?? {
        workspaceRoot,
        defaultTestCommand: 'npm test',
        notes: '',
        updatedAt: Date.now()
      }
    );
  }

  async saveProjectSettings(settings: ProjectSettings) {
    const data = await this.loadData();
    const next = { ...settings, updatedAt: Date.now() };
    await this.saveData({
      ...data,
      projectSettings: { ...data.projectSettings, [next.workspaceRoot]: next }
    });
    return next;
  }

  async appendToolHistory(entry: ToolHistoryEntry) {
    const data = await this.loadData();
    const toolHistory = [entry, ...data.toolHistory].slice(0, HISTORY_LIMIT);
    await this.saveData({ ...data, toolHistory });
    return entry;
  }

  async listToolHistory(limit = 100) {
    const data = await this.loadData();
    return data.toolHistory.slice(0, Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(limit))));
  }

  async saveTestRun(run: TestRunSummary) {
    const data = await this.loadData();
    const testRuns = [run, ...data.testRuns.filter((item) => item.id !== run.id)].slice(0, TEST_RUN_LIMIT);
    await this.saveData({ ...data, testRuns });
    return run;
  }

  async listTestRuns(workspaceRoot?: string, limit = 25) {
    const data = await this.loadData();
    const rows = workspaceRoot
      ? data.testRuns.filter((run) => run.workspaceRoot === workspaceRoot)
      : data.testRuns;
    return rows.slice(0, Math.max(1, Math.min(TEST_RUN_LIMIT, Math.floor(limit))));
  }
}
