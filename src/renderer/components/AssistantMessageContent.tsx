import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lockChartDetailsScroll, useChartDetailsLayoutLock } from '@renderer/lib/chart-details-scroll';
import type { ReactNode } from 'react';
import type { SessionMode } from '@shared/types';
import {
  SESSION_MODE_EMBED_STRINGS,
  WEB_SEARCH_EMBED_STRINGS
} from '@shared/mythra-embeds';
import { ChatMarkdown } from './ChatMarkdown';
import { SessionModeMessageEmbed } from './SessionModeMessageEmbed';
import { WebSearchMessageEmbed } from './WebSearchMessageEmbed';

type Props = {
  text: string;
  sessionMode: SessionMode;
  onSessionModeToggle: () => void;
  sessionModeToggleDisabled?: boolean;
  webSearch: boolean;
  onWebSearchChange: (next: boolean) => void;
  webSearchDisabled?: boolean;
  quizSubmitDisabled?: boolean;
  completedQuizSelections?: Record<number, Record<number, number>>;
  mentionNames?: string[];
  onSubmitQuizAnswers: (answersText: string) => void;
};

type QuizQuestion = {
  question: string;
  choices: string[];
};

type QuizEmbed = {
  title?: string;
  questions: QuizQuestion[];
};

type ChartKind = 'bar' | 'line' | 'pie' | 'donut' | 'stacked-bar' | 'budget';

type ChartDatum = {
  label: string;
  value: number;
  details?: string[];
  color?: string;
};

type ChartSeries = {
  name: string;
  data: ChartDatum[];
  color?: string;
};

type BudgetDatum = {
  label: string;
  budget: number;
  actual: number;
  details?: string[];
};

type TableColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
};

type TableRow = Record<string, string | number>;

type TableEmbed = {
  title?: string;
  subtitle?: string;
  columns: TableColumn[];
  rows: TableRow[];
};

type StatCard = {
  label: string;
  value: string;
  delta?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  detail?: string;
};

type StatsEmbed = {
  title?: string;
  subtitle?: string;
  cards: StatCard[];
};

type ChartEmbed = {
  type: ChartKind;
  title?: string;
  subtitle?: string;
  unit?: string;
  valuePrefix?: string;
  valueSuffix?: string;
  data: ChartDatum[];
  series?: ChartSeries[];
  budgetData?: BudgetDatum[];
};

type EmbedSegment =
  | { type: 'md'; text: string }
  | { type: 'session' }
  | { type: 'web' }
  | { type: 'quiz'; quiz: QuizEmbed }
  | { type: 'chart'; chart: ChartEmbed }
  | { type: 'table'; table: TableEmbed }
  | { type: 'stats'; stats: StatsEmbed };

const QUIZ_FENCE_RE = /```mythra-quiz\s*([\s\S]*?)```/gi;
const CHART_FENCE_RE = /```mythra-chart\s*([\s\S]*?)```/gi;
const TABLE_FENCE_RE = /```mythra-table\s*([\s\S]*?)```/gi;
const STATS_FENCE_RE = /```mythra-stats\s*([\s\S]*?)```/gi;
const DATA_JSON_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;
const MAX_QUIZ_QUESTIONS = 25;
const MAX_QUIZ_CHOICES = 8;
const MAX_CHART_POINTS = 40;
const MAX_CHART_SERIES = 8;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 12;
const MAX_STAT_CARDS = 8;
const CHART_COLORS = ['#818cf8', '#22c55e', '#f59e0b', '#f43f5e', '#38bdf8', '#a78bfa', '#f472b6', '#14b8a6'];
const ALLOWED_CHART_COLORS = new Set(CHART_COLORS);
const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

function clampText(raw: unknown, max = 80): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

function monthSortValue(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  const match = value.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  if (!match) return null;
  const month = MONTH_INDEX[match[1] ?? ''];
  if (month == null) return null;
  const yearMatch = value.match(/\b(20\d{2}|19\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : 0;
  return year * 12 + month;
}

function orderMonthData(data: ChartDatum[]): ChartDatum[] {
  if (data.length < 2) return data;
  const monthValues = data.map((item) => monthSortValue(item.label));
  if (monthValues.some((item) => item == null)) return data;
  return data
    .map((item, index) => ({ item, index, order: monthValues[index] ?? index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ item }) => item);
}

function orderMonthBudgetData(data: BudgetDatum[]): BudgetDatum[] {
  if (data.length < 2) return data;
  const monthValues = data.map((item) => monthSortValue(item.label));
  if (monthValues.some((item) => item == null)) return data;
  return data
    .map((item, index) => ({ item, index, order: monthValues[index] ?? index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ item }) => item);
}

function normalizeChartColor(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const named: Record<string, string> = {
    blue: '#38bdf8',
    green: '#22c55e',
    orange: '#f59e0b',
    red: '#f43f5e',
    purple: '#a78bfa',
    pink: '#f472b6',
    teal: '#14b8a6',
    indigo: '#818cf8'
  };
  return named[value] ?? (ALLOWED_CHART_COLORS.has(value) ? value : undefined);
}

function normalizeQuiz(raw: unknown): QuizEmbed | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { title?: unknown; questions?: unknown };
  if (!Array.isArray(obj.questions)) return null;
  const questions = obj.questions
    .map((item): QuizQuestion | null => {
      if (!item || typeof item !== 'object') return null;
      const q = item as { question?: unknown; choices?: unknown };
      const question = typeof q.question === 'string' ? q.question.trim() : '';
      if (!question || !Array.isArray(q.choices)) return null;
      const choices = q.choices
        .map((choice) => (typeof choice === 'string' ? choice.trim() : ''))
        .filter(Boolean)
        .slice(0, MAX_QUIZ_CHOICES);
      return choices.length >= 2 ? { question, choices } : null;
    })
    .filter((item): item is QuizQuestion => item != null)
    .slice(0, MAX_QUIZ_QUESTIONS);
  if (questions.length === 0) return null;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  return { title: title || undefined, questions };
}

function parseQuizJson(raw: string): QuizEmbed | null {
  try {
    return normalizeQuiz(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeChartData(raw: unknown): ChartDatum[] {
  if (!Array.isArray(raw)) return [];
  const data = raw
    .map((item): ChartDatum | null => {
      if (!item || typeof item !== 'object') return null;
      const d = item as { label?: unknown; value?: unknown; details?: unknown; detail?: unknown; color?: unknown };
      const label = clampText(d.label);
      const value = typeof d.value === 'number' ? d.value : Number(d.value);
      const rawDetails = Array.isArray(d.details) ? d.details : d.detail != null ? [d.detail] : [];
      const details = rawDetails.map((detail) => clampText(detail, 180)).filter(Boolean).slice(0, 6);
      const color = normalizeChartColor(d.color);
      return label && Number.isFinite(value) ? { label, value, details: details.length ? details : undefined, color } : null;
    })
    .filter((item): item is ChartDatum => item != null)
    .slice(0, MAX_CHART_POINTS);
  return orderMonthData(data);
}

function normalizeBudgetData(raw: unknown): BudgetDatum[] {
  if (!Array.isArray(raw)) return [];
  const data = raw
    .map((item): BudgetDatum | null => {
      if (!item || typeof item !== 'object') return null;
      const d = item as { label?: unknown; budget?: unknown; planned?: unknown; actual?: unknown; value?: unknown; details?: unknown; detail?: unknown };
      const label = clampText(d.label);
      const budget = typeof d.budget === 'number' ? d.budget : Number(d.budget ?? d.planned);
      const actual = typeof d.actual === 'number' ? d.actual : Number(d.actual ?? d.value);
      const rawDetails = Array.isArray(d.details) ? d.details : d.detail != null ? [d.detail] : [];
      const details = rawDetails.map((detail) => clampText(detail, 180)).filter(Boolean).slice(0, 6);
      return label && Number.isFinite(budget) && Number.isFinite(actual)
        ? { label, budget, actual, details: details.length ? details : undefined }
        : null;
    })
    .filter((item): item is BudgetDatum => item != null)
    .slice(0, MAX_CHART_POINTS);
  return orderMonthBudgetData(data);
}

function normalizeChartSeries(raw: unknown): ChartSeries[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index): ChartSeries | null => {
      if (!item || typeof item !== 'object') return null;
      const s = item as { name?: unknown; data?: unknown; color?: unknown };
      const name = clampText(s.name, 80) || `Series ${index + 1}`;
      const data = normalizeChartData(s.data);
      return data.length ? { name, data, color: normalizeChartColor(s.color) } : null;
    })
    .filter((item): item is ChartSeries => item != null)
    .slice(0, MAX_CHART_SERIES);
}

function normalizeChart(raw: unknown): ChartEmbed | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    type?: unknown;
    title?: unknown;
    subtitle?: unknown;
    unit?: unknown;
    valuePrefix?: unknown;
    valueSuffix?: unknown;
    data?: unknown;
    series?: unknown;
  };
  const type = clampText(obj.type, 20).toLowerCase();
  if (!['bar', 'line', 'pie', 'donut', 'stacked-bar', 'stacked_bar', 'budget'].includes(type)) return null;
  const normalizedType = type === 'stacked_bar' ? 'stacked-bar' : type;
  const series =
    normalizedType === 'line' || normalizedType === 'stacked-bar' || normalizedType === 'bar'
      ? normalizeChartSeries(obj.series)
      : [];
  const budgetData = normalizedType === 'budget' ? normalizeBudgetData(obj.data) : [];
  const data =
    normalizedType === 'line' || normalizedType === 'stacked-bar' || normalizedType === 'bar'
      ? (series[0]?.data ?? normalizeChartData(obj.data))
      : normalizeChartData(obj.data);
  if (normalizedType === 'budget') {
    if (budgetData.length === 0) return null;
  } else if (data.length === 0 && series.length === 0) {
    return null;
  }
  return {
    type: normalizedType as ChartKind,
    title: clampText(obj.title, 120) || undefined,
    subtitle: clampText(obj.subtitle, 180) || undefined,
    unit: clampText(obj.unit, 24) || undefined,
    valuePrefix: clampText(obj.valuePrefix, 8) || undefined,
    valueSuffix: clampText(obj.valueSuffix, 16) || undefined,
    data,
    series: series.length ? series : undefined,
    budgetData: budgetData.length ? budgetData : undefined
  };
}

function parseChartJson(raw: string): ChartEmbed | null {
  try {
    return normalizeChart(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeTable(raw: unknown): TableEmbed | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { title?: unknown; subtitle?: unknown; columns?: unknown; rows?: unknown };
  if (!Array.isArray(obj.rows)) return null;
  const firstRow = obj.rows.find((row) => row && typeof row === 'object') as Record<string, unknown> | undefined;
  const columns = Array.isArray(obj.columns)
    ? obj.columns
        .map((item): TableColumn | null => {
          if (typeof item === 'string') {
            const key = clampText(item, 40);
            return key ? { key, label: key } : null;
          }
          if (!item || typeof item !== 'object') return null;
          const c = item as { key?: unknown; label?: unknown; align?: unknown };
          const key = clampText(c.key, 40);
          if (!key) return null;
          const align = c.align === 'right' || c.align === 'center' ? c.align : 'left';
          return { key, label: clampText(c.label, 80) || key, align };
        })
        .filter((item): item is TableColumn => item != null)
        .slice(0, MAX_TABLE_COLUMNS)
    : Object.keys(firstRow ?? {})
        .slice(0, MAX_TABLE_COLUMNS)
        .map((key) => ({ key, label: key }));
  if (!columns.length) return null;
  const rows = obj.rows
    .map((row): TableRow | null => {
      if (!row || typeof row !== 'object') return null;
      const source = row as Record<string, unknown>;
      const normalized: TableRow = {};
      columns.forEach((column) => {
        const value = source[column.key];
        normalized[column.key] =
          typeof value === 'number' && Number.isFinite(value)
            ? value
            : typeof value === 'string'
              ? value.trim().slice(0, 180)
              : value == null
                ? ''
                : String(value).slice(0, 180);
      });
      return normalized;
    })
    .filter((item): item is TableRow => item != null)
    .slice(0, MAX_TABLE_ROWS);
  if (!rows.length) return null;
  return {
    title: clampText(obj.title, 120) || undefined,
    subtitle: clampText(obj.subtitle, 180) || undefined,
    columns,
    rows
  };
}

function parseTableJson(raw: string): TableEmbed | null {
  try {
    return normalizeTable(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeStats(raw: unknown): StatsEmbed | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { title?: unknown; subtitle?: unknown; cards?: unknown };
  if (!Array.isArray(obj.cards)) return null;
  const cards = obj.cards
    .map((item): StatCard | null => {
      if (!item || typeof item !== 'object') return null;
      const c = item as { label?: unknown; value?: unknown; delta?: unknown; tone?: unknown; detail?: unknown };
      const label = clampText(c.label, 80);
      const value = clampText(c.value, 80);
      if (!label || !value) return null;
      const tone = ['success', 'warning', 'danger', 'info', 'neutral'].includes(String(c.tone))
        ? (String(c.tone) as StatCard['tone'])
        : 'neutral';
      return {
        label,
        value,
        delta: clampText(c.delta, 80) || undefined,
        tone,
        detail: clampText(c.detail, 140) || undefined
      };
    })
    .filter((item): item is StatCard => item != null)
    .slice(0, MAX_STAT_CARDS);
  if (!cards.length) return null;
  return {
    title: clampText(obj.title, 120) || undefined,
    subtitle: clampText(obj.subtitle, 180) || undefined,
    cards
  };
}

function parseStatsJson(raw: string): StatsEmbed | null {
  try {
    return normalizeStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

function textHasAnyEmbedToken(text: string): boolean {
  return (
    [...SESSION_MODE_EMBED_STRINGS, ...WEB_SEARCH_EMBED_STRINGS].some((t) => text.includes(t)) ||
    /```mythra-quiz/i.test(text) ||
    /```mythra-chart/i.test(text) ||
    /```mythra-table/i.test(text) ||
    /```mythra-stats/i.test(text)
  );
}

function findNextEmbed(
  rest: string
):
  | { i: number; len: number; kind: 'session' | 'web' }
  | { i: number; len: number; kind: 'quiz'; quiz: QuizEmbed }
  | { i: number; len: number; kind: 'chart'; chart: ChartEmbed }
  | { i: number; len: number; kind: 'table'; table: TableEmbed }
  | { i: number; len: number; kind: 'stats'; stats: StatsEmbed }
  | null {
  let best:
    | { i: number; len: number; kind: 'session' | 'web' }
    | { i: number; len: number; kind: 'quiz'; quiz: QuizEmbed }
    | { i: number; len: number; kind: 'chart'; chart: ChartEmbed }
    | { i: number; len: number; kind: 'table'; table: TableEmbed }
    | { i: number; len: number; kind: 'stats'; stats: StatsEmbed }
    | null = null;
  for (const s of SESSION_MODE_EMBED_STRINGS) {
    const i = rest.indexOf(s);
    if (i >= 0 && (!best || i < best.i)) best = { i, len: s.length, kind: 'session' };
  }
  for (const s of WEB_SEARCH_EMBED_STRINGS) {
    const i = rest.indexOf(s);
    if (i >= 0 && (!best || i < best.i)) best = { i, len: s.length, kind: 'web' };
  }
  QUIZ_FENCE_RE.lastIndex = 0;
  const quizMatch = QUIZ_FENCE_RE.exec(rest);
  if (quizMatch?.index != null) {
    const quiz = parseQuizJson(quizMatch[1] ?? '');
    if (quiz && (!best || quizMatch.index < best.i)) {
      best = { i: quizMatch.index, len: quizMatch[0].length, kind: 'quiz', quiz };
    }
  }
  CHART_FENCE_RE.lastIndex = 0;
  const chartMatch = CHART_FENCE_RE.exec(rest);
  if (chartMatch?.index != null) {
    const chart = parseChartJson(chartMatch[1] ?? '');
    if (chart && (!best || chartMatch.index < best.i)) {
      best = { i: chartMatch.index, len: chartMatch[0].length, kind: 'chart', chart };
    }
  }
  TABLE_FENCE_RE.lastIndex = 0;
  const tableMatch = TABLE_FENCE_RE.exec(rest);
  if (tableMatch?.index != null) {
    const table = parseTableJson(tableMatch[1] ?? '');
    if (table && (!best || tableMatch.index < best.i)) {
      best = { i: tableMatch.index, len: tableMatch[0].length, kind: 'table', table };
    }
  }
  STATS_FENCE_RE.lastIndex = 0;
  const statsMatch = STATS_FENCE_RE.exec(rest);
  if (statsMatch?.index != null) {
    const stats = parseStatsJson(statsMatch[1] ?? '');
    if (stats && (!best || statsMatch.index < best.i)) {
      best = { i: statsMatch.index, len: statsMatch[0].length, kind: 'stats', stats };
    }
  }
  DATA_JSON_FENCE_RE.lastIndex = 0;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = DATA_JSON_FENCE_RE.exec(rest))) {
    const fullFence = jsonMatch[0] ?? '';
    if (/^```mythra-(quiz|chart|table|stats)/i.test(fullFence)) continue;
    const raw = jsonMatch[1] ?? '';
    const chart = parseChartJson(raw);
    if (chart && (!best || jsonMatch.index < best.i)) {
      best = { i: jsonMatch.index, len: fullFence.length, kind: 'chart', chart };
      break;
    }
    const table = parseTableJson(raw);
    if (table && (!best || jsonMatch.index < best.i)) {
      best = { i: jsonMatch.index, len: fullFence.length, kind: 'table', table };
      break;
    }
    const stats = parseStatsJson(raw);
    if (stats && (!best || jsonMatch.index < best.i)) {
      best = { i: jsonMatch.index, len: fullFence.length, kind: 'stats', stats };
      break;
    }
  }
  return best;
}

function parseAssistantEmbeds(text: string): EmbedSegment[] {
  if (!textHasAnyEmbedToken(text)) {
    return [{ type: 'md', text }];
  }

  const out: EmbedSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const next = findNextEmbed(rest);

    if (!next) {
      out.push({ type: 'md', text: rest });
      break;
    }
    if (next.i > 0) {
      out.push({ type: 'md', text: rest.slice(0, next.i) });
    }
    if (next.kind === 'quiz') {
      out.push({ type: 'quiz', quiz: next.quiz });
    } else if (next.kind === 'chart') {
      out.push({ type: 'chart', chart: next.chart });
    } else if (next.kind === 'table') {
      out.push({ type: 'table', table: next.table });
    } else if (next.kind === 'stats') {
      out.push({ type: 'stats', stats: next.stats });
    } else {
      out.push({ type: next.kind });
    }
    rest = rest.slice(next.i + next.len);
  }
  return out;
}

function choiceLabel(index: number) {
  return String.fromCharCode(65 + index);
}

function formatChartValue(chart: ChartEmbed, value: number) {
  const abs = Math.abs(value);
  const compact =
    abs >= 1_000_000_000
      ? `${(value / 1_000_000_000).toFixed(1)}B`
      : abs >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : abs >= 1_000
          ? `${(value / 1_000).toFixed(1)}K`
          : Number.isInteger(value)
            ? String(value)
            : value.toFixed(2).replace(/\.?0+$/, '');
  return `${chart.valuePrefix ?? ''}${compact}${chart.valueSuffix ?? chart.unit ?? ''}`;
}

function chartRange(data: ChartDatum[]) {
  const values = data.map((d) => d.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min = min > 0 ? 0 : min - 1;
    max = max < 0 ? 0 : max + 1;
  }
  return { min, max };
}

function lineSeries(chart: ChartEmbed): ChartSeries[] {
  return chart.series?.length ? chart.series : [{ name: chart.title || 'Series', data: chart.data }];
}

function chartDatumColor(datum: ChartDatum | undefined, index: number) {
  return datum?.color ?? CHART_COLORS[index % CHART_COLORS.length];
}

function chartSeriesColor(series: ChartSeries | undefined, index: number) {
  return series?.color ?? CHART_COLORS[index % CHART_COLORS.length];
}

function ChartHeader({ chart }: { chart: ChartEmbed }) {
  return (
    <div className="chart-embed__header">
      <span className="message-embed__label">
        {chart.type === 'donut'
          ? 'Donut chart'
          : chart.type === 'stacked-bar'
            ? 'Stacked bar chart'
            : chart.type === 'budget'
              ? 'Budget vs actual'
              : `${chart.type} chart`}
      </span>
      {chart.unit ? <span className="chart-embed__unit">{chart.unit}</span> : null}
      {chart.title ? <h4 className="chart-embed__title">{chart.title}</h4> : null}
      {chart.subtitle ? <p className="chart-embed__subtitle">{chart.subtitle}</p> : null}
    </div>
  );
}

/** Identifies what is hovered — a single bar/point (datum), a series+label segment, or a budget row. */
type ChartHoverSelection =
  | { kind: 'datum'; index: number }
  | { kind: 'segment'; seriesIndex: number; label: string }
  | { kind: 'series'; seriesIndex: number }
  | { kind: 'budget'; index: number };

type ChartInteractiveProps = {
  chart: ChartEmbed;
  activeSelection: ChartHoverSelection | null;
  onActiveSelectionChange: (selection: ChartHoverSelection | null) => void;
  hiddenIndices: Set<number>;
  onToggleVisibility: (index: number) => void;
};

type IndexedChartDatum = {
  datum: ChartDatum;
  originalIndex: number;
};

type IndexedChartSeries = {
  series: ChartSeries;
  originalIndex: number;
};

function indexedChartData(data: ChartDatum[]): IndexedChartDatum[] {
  return data.map((datum, originalIndex) => ({ datum, originalIndex }));
}

function indexedLineSeries(series: ChartSeries[]): IndexedChartSeries[] {
  return series.map((item, originalIndex) => ({ series: item, originalIndex }));
}

function chartHoverTargetsEqual(a: ChartHoverSelection, b: ChartHoverSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'datum' && b.kind === 'datum') return a.index === b.index;
  if (a.kind === 'budget' && b.kind === 'budget') return a.index === b.index;
  if (a.kind === 'series' && b.kind === 'series') return a.seriesIndex === b.seriesIndex;
  if (a.kind === 'segment' && b.kind === 'segment') {
    return a.seriesIndex === b.seriesIndex && a.label === b.label;
  }
  return false;
}

function chartItemClass(base: string, activeSelection: ChartHoverSelection | null, target: ChartHoverSelection) {
  const isActive = activeSelection != null && chartHoverTargetsEqual(activeSelection, target);
  return `${base}${isActive ? ' is-active' : activeSelection != null ? ' is-muted' : ''}`;
}

function resolveChartDetailsContent(
  chart: ChartEmbed,
  selection: ChartHoverSelection,
  data: IndexedChartDatum[],
  series: IndexedChartSeries[],
  budgetData: BudgetDatum[]
): ReactNode | null {
  if (selection.kind === 'budget') {
    const item = budgetData[selection.index];
    if (!item) return null;
    const delta = item.actual - item.budget;
    return (
      <div className="chart-embed__details">
        <strong>{item.label}</strong>
        <span>Budget {formatChartValue(chart, item.budget)} · Actual {formatChartValue(chart, item.actual)}</span>
        <span className={delta > 0 ? 'chart-embed__delta is-over' : 'chart-embed__delta is-under'}>
          {delta === 0 ? 'On budget' : `${delta > 0 ? 'Over' : 'Under'} by ${formatChartValue(chart, Math.abs(delta))}`}
        </span>
        {item.details?.map((detail) => <span key={detail}>{detail}</span>)}
      </div>
    );
  }

  if (selection.kind === 'datum') {
    const item = data.find((candidate) => candidate.originalIndex === selection.index);
    if (!item) return null;
    return (
      <div className="chart-embed__details">
        <strong>{item.datum.label}</strong>
        <span>{formatChartValue(chart, item.datum.value)}</span>
        {item.datum.details?.map((detail) => <span key={detail}>{detail}</span>)}
      </div>
    );
  }

  const seriesEntry = series.find((candidate) => candidate.originalIndex === selection.seriesIndex);
  if (!seriesEntry) return null;

  if (selection.kind === 'segment') {
    const datum = seriesEntry.series.data.find((point) => point.label === selection.label);
    if (!datum) return null;
    return (
      <div className="chart-embed__details">
        <strong>{seriesEntry.series.name}</strong>
        <span>
          {datum.label}: {formatChartValue(chart, datum.value)}
        </span>
        {datum.details?.map((detail) => <span key={detail}>{detail}</span>)}
      </div>
    );
  }

  const latest = seriesEntry.series.data[seriesEntry.series.data.length - 1];
  return (
    <div className="chart-embed__details">
      <strong>{seriesEntry.series.name}</strong>
      {latest ? <span>Latest {latest.label}: {formatChartValue(chart, latest.value)}</span> : null}
      {latest?.details?.map((detail) => <span key={detail}>{detail}</span>)}
    </div>
  );
}

function ChartLegend({
  chart,
  data = indexedChartData(chart.data),
  activeSelection,
  onActiveSelectionChange,
  hiddenIndices,
  onToggleVisibility,
  showPercent = false
}: ChartInteractiveProps & { data?: IndexedChartDatum[]; showPercent?: boolean }) {
  const total = data
    .filter((item) => !hiddenIndices.has(item.originalIndex))
    .reduce((sum, item) => sum + Math.max(0, item.datum.value), 0);
  return (
    <div className="chart-embed__legend">
      {data.map(({ datum, originalIndex }) => {
        const hidden = hiddenIndices.has(originalIndex);
        const target: ChartHoverSelection = { kind: 'datum', index: originalIndex };
        return (
        <div
          className={`${chartItemClass('chart-embed__legend-row', activeSelection, target)} ${hidden ? 'is-hidden' : ''}`}
          key={`${datum.label}-${originalIndex}`}
          onBlur={() => onActiveSelectionChange(null)}
          onClick={() => onToggleVisibility(originalIndex)}
          onFocus={() => onActiveSelectionChange(target)}
          onMouseEnter={() => onActiveSelectionChange(target)}
          onMouseLeave={() => onActiveSelectionChange(null)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleVisibility(originalIndex);
            }
          }}
        >
          <input
            aria-label={`${hidden ? 'Show' : 'Hide'} ${datum.label}`}
            checked={!hidden}
            className="chart-embed__legend-check"
            onChange={() => undefined}
            onClick={(e) => e.stopPropagation()}
            type="checkbox"
          />
          <span className="chart-embed__swatch" style={{ background: chartDatumColor(datum, originalIndex) }} />
          <span className="chart-embed__legend-label">{datum.label}</span>
          <strong>{formatChartValue(chart, datum.value)}</strong>
          {showPercent ? <span>{hidden ? 'Hidden' : total > 0 ? `${Math.round((Math.max(0, datum.value) / total) * 100)}%` : ''}</span> : null}
        </div>
      );
      })}
    </div>
  );
}

function LineSeriesLegend({
  chart,
  series,
  activeSelection,
  onActiveSelectionChange,
  hiddenIndices,
  onToggleVisibility
}: ChartInteractiveProps & { series: IndexedChartSeries[] }) {
  return (
    <div className="chart-embed__legend">
      {series.map(({ series: item, originalIndex }) => {
        const latest = item.data[item.data.length - 1];
        const hidden = hiddenIndices.has(originalIndex);
        const target: ChartHoverSelection = { kind: 'series', seriesIndex: originalIndex };
        return (
          <div
            className={`${chartItemClass('chart-embed__legend-row', activeSelection, target)} ${hidden ? 'is-hidden' : ''}`}
            key={`${item.name}-${originalIndex}`}
            onBlur={() => onActiveSelectionChange(null)}
            onClick={() => onToggleVisibility(originalIndex)}
            onFocus={() => onActiveSelectionChange(target)}
            onMouseEnter={() => onActiveSelectionChange(target)}
            onMouseLeave={() => onActiveSelectionChange(null)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleVisibility(originalIndex);
              }
            }}
          >
            <input
              aria-label={`${hidden ? 'Show' : 'Hide'} ${item.name}`}
              checked={!hidden}
              className="chart-embed__legend-check"
              onChange={() => undefined}
              onClick={(e) => e.stopPropagation()}
              type="checkbox"
            />
            <span className="chart-embed__swatch" style={{ background: chartSeriesColor(item, originalIndex) }} />
            <span className="chart-embed__legend-label">{item.name}</span>
            {latest ? <strong>{formatChartValue(chart, latest.value)}</strong> : <strong>-</strong>}
            <span>{hidden ? 'Hidden' : latest?.label ?? ''}</span>
          </div>
        );
      })}
    </div>
  );
}

function BarChart({
  chart,
  activeSelection,
  onActiveSelectionChange,
  data
}: ChartInteractiveProps & { data: IndexedChartDatum[] }) {
  if (data.length === 0) {
    return <div className="chart-embed__empty">All fields are hidden.</div>;
  }
  const width = 640;
  const height = 300;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const rawRange = chartRange(data.map((item) => item.datum));
  const min = Math.min(0, rawRange.min);
  const max = Math.max(0, rawRange.max);
  const zeroY = top + ((max - Math.max(0, Math.min(max, 0))) / (max - min)) * plotHeight;
  const step = plotWidth / data.length;
  const barWidth = Math.max(10, Math.min(44, step * 0.58));
  const yFor = (value: number) => top + ((max - value) / (max - min)) * plotHeight;
  const tickValues = [max, (max + min) / 2, min];
  const showValueLabels = data.length <= 12;

  return (
    <svg className="chart-embed__svg" role="img" viewBox={`0 0 ${width} ${height}`}>
      {tickValues.map((tick, index) => {
        const y = yFor(tick);
        return (
          <g key={index}>
            <line className="chart-embed__grid" x1={left} x2={width - right} y1={y} y2={y} />
            <text className="chart-embed__axis-label" textAnchor="end" x={left - 10} y={y + 4}>
              {formatChartValue(chart, tick)}
            </text>
          </g>
        );
      })}
      <line className="chart-embed__axis" x1={left} x2={width - right} y1={zeroY} y2={zeroY} />
      {data.map(({ datum, originalIndex }, index) => {
        const x = left + index * step + (step - barWidth) / 2;
        const valueY = yFor(datum.value);
        const y = Math.min(valueY, zeroY);
        const h = Math.max(2, Math.abs(zeroY - valueY));
        const color = chartDatumColor(datum, originalIndex);
        const target: ChartHoverSelection = { kind: 'datum', index: originalIndex };
        return (
          <g
            key={`${datum.label}-${originalIndex}`}
            onMouseEnter={() => onActiveSelectionChange(target)}
            onMouseLeave={() => onActiveSelectionChange(null)}
          >
            <rect className={chartItemClass('chart-embed__bar', activeSelection, target)} fill={color} height={h} rx="5" width={barWidth} x={x} y={y} />
            {showValueLabels ? (
              <text className="chart-embed__value-label" textAnchor="middle" x={x + barWidth / 2} y={datum.value >= 0 ? y - 6 : y + h + 14}>
                {formatChartValue(chart, datum.value)}
              </text>
            ) : null}
            <text className="chart-embed__x-label" textAnchor="middle" x={x + barWidth / 2} y={height - 24}>
              {datum.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function StackedBarChart({
  chart,
  activeSelection,
  onActiveSelectionChange,
  series
}: ChartInteractiveProps & { series: IndexedChartSeries[] }) {
  if (series.length === 0) {
    return <div className="chart-embed__empty">All fields are hidden.</div>;
  }
  const labels = Array.from(new Set(series.flatMap((item) => item.series.data.map((datum) => datum.label)))).slice(0, MAX_CHART_POINTS);
  if (!labels.length) {
    return <div className="chart-embed__empty">No visible data.</div>;
  }
  const width = 640;
  const height = 300;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const totals = labels.map((label) =>
    series.reduce((sum, item) => sum + Math.max(0, item.series.data.find((datum) => datum.label === label)?.value ?? 0), 0)
  );
  const max = Math.max(...totals, 1);
  const step = plotWidth / labels.length;
  const barWidth = Math.max(18, Math.min(54, step * 0.62));
  const yFor = (value: number) => top + ((max - value) / max) * plotHeight;
  const tickValues = [max, max / 2, 0];
  const xLabelEvery = Math.max(1, Math.ceil(labels.length / 8));

  return (
    <svg className="chart-embed__svg" role="img" viewBox={`0 0 ${width} ${height}`}>
      {tickValues.map((tick, index) => {
        const y = yFor(tick);
        return (
          <g key={index}>
            <line className="chart-embed__grid" x1={left} x2={width - right} y1={y} y2={y} />
            <text className="chart-embed__axis-label" textAnchor="end" x={left - 10} y={y + 4}>
              {formatChartValue(chart, tick)}
            </text>
          </g>
        );
      })}
      {labels.map((label, labelIndex) => {
        const x = left + labelIndex * step + (step - barWidth) / 2;
        let yCursor = top + plotHeight;
        return (
          <g key={label}>
            {series.map(({ series: item, originalIndex }) => {
              const value = Math.max(0, item.data.find((datum) => datum.label === label)?.value ?? 0);
              if (value <= 0) return null;
              const h = Math.max(2, (value / max) * plotHeight);
              yCursor -= h;
              const target: ChartHoverSelection = { kind: 'segment', seriesIndex: originalIndex, label };
              return (
                <rect
                  className={chartItemClass('chart-embed__bar', activeSelection, target)}
                  fill={chartSeriesColor(item, originalIndex)}
                  height={h}
                  key={`${label}-${item.name}`}
                  onMouseEnter={() => onActiveSelectionChange(target)}
                  onMouseLeave={() => onActiveSelectionChange(null)}
                  rx="3"
                  width={barWidth}
                  x={x}
                  y={yCursor}
                />
              );
            })}
            {labelIndex % xLabelEvery === 0 || labelIndex === labels.length - 1 ? (
              <text className="chart-embed__x-label" textAnchor="middle" x={x + barWidth / 2} y={height - 24}>
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function GroupedBarChart({
  chart,
  activeSelection,
  onActiveSelectionChange,
  series
}: ChartInteractiveProps & { series: IndexedChartSeries[] }) {
  if (series.length === 0) {
    return <div className="chart-embed__empty">All fields are hidden.</div>;
  }
  const labels = Array.from(new Set(series.flatMap((item) => item.series.data.map((datum) => datum.label)))).slice(0, MAX_CHART_POINTS);
  if (!labels.length) {
    return <div className="chart-embed__empty">No visible data.</div>;
  }
  const width = 640;
  const height = 300;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = series.flatMap((item) => item.series.data.map((datum) => datum.value));
  const rawRange = chartRange(values.map((value) => ({ label: '', value })));
  const min = Math.min(0, rawRange.min);
  const max = Math.max(0, rawRange.max);
  const zeroY = top + ((max - Math.max(0, Math.min(max, 0))) / (max - min)) * plotHeight;
  const step = plotWidth / labels.length;
  const groupWidth = Math.min(step * 0.76, 76);
  const barWidth = Math.max(5, groupWidth / Math.max(1, series.length));
  const yFor = (value: number) => top + ((max - value) / (max - min)) * plotHeight;
  const tickValues = [max, (max + min) / 2, min];
  const xLabelEvery = Math.max(1, Math.ceil(labels.length / 8));

  return (
    <svg className="chart-embed__svg" role="img" viewBox={`0 0 ${width} ${height}`}>
      {tickValues.map((tick, index) => {
        const y = yFor(tick);
        return (
          <g key={index}>
            <line className="chart-embed__grid" x1={left} x2={width - right} y1={y} y2={y} />
            <text className="chart-embed__axis-label" textAnchor="end" x={left - 10} y={y + 4}>
              {formatChartValue(chart, tick)}
            </text>
          </g>
        );
      })}
      <line className="chart-embed__axis" x1={left} x2={width - right} y1={zeroY} y2={zeroY} />
      {labels.map((label, labelIndex) => {
        const groupX = left + labelIndex * step + (step - groupWidth) / 2;
        return (
          <g key={label}>
            {series.map(({ series: item, originalIndex }, seriesIndex) => {
              const value = item.data.find((datum) => datum.label === label)?.value ?? 0;
              const valueY = yFor(value);
              const y = Math.min(valueY, zeroY);
              const h = Math.max(2, Math.abs(zeroY - valueY));
              const x = groupX + seriesIndex * barWidth;
              const target: ChartHoverSelection = { kind: 'segment', seriesIndex: originalIndex, label };
              return (
                <rect
                  className={chartItemClass('chart-embed__bar', activeSelection, target)}
                  fill={chartSeriesColor(item, originalIndex)}
                  height={h}
                  key={`${label}-${item.name}`}
                  onMouseEnter={() => onActiveSelectionChange(target)}
                  onMouseLeave={() => onActiveSelectionChange(null)}
                  rx="3"
                  width={Math.max(4, barWidth - 2)}
                  x={x}
                  y={y}
                />
              );
            })}
            {labelIndex % xLabelEvery === 0 || labelIndex === labels.length - 1 ? (
              <text className="chart-embed__x-label" textAnchor="middle" x={groupX + groupWidth / 2} y={height - 24}>
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function BudgetChart({
  chart,
  activeSelection,
  onActiveSelectionChange,
  data
}: ChartInteractiveProps & { data: BudgetDatum[] }) {
  if (data.length === 0) {
    return <div className="chart-embed__empty">All fields are hidden.</div>;
  }
  const width = 640;
  const height = 300;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(...data.flatMap((item) => [item.budget, item.actual]), 1);
  const step = plotWidth / data.length;
  const barWidth = Math.max(8, Math.min(24, step * 0.24));
  const groupGap = Math.max(4, barWidth * 0.35);
  const yFor = (value: number) => top + ((max - value) / max) * plotHeight;
  const tickValues = [max, max / 2, 0];
  const xLabelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <svg className="chart-embed__svg" role="img" viewBox={`0 0 ${width} ${height}`}>
      {tickValues.map((tick, index) => {
        const y = yFor(tick);
        return (
          <g key={index}>
            <line className="chart-embed__grid" x1={left} x2={width - right} y1={y} y2={y} />
            <text className="chart-embed__axis-label" textAnchor="end" x={left - 10} y={y + 4}>
              {formatChartValue(chart, tick)}
            </text>
          </g>
        );
      })}
      {data.map((datum, index) => {
        const center = left + index * step + step / 2;
        const budgetX = center - barWidth - groupGap / 2;
        const actualX = center + groupGap / 2;
        const budgetY = yFor(datum.budget);
        const actualY = yFor(datum.actual);
        const target: ChartHoverSelection = { kind: 'budget', index };
        const active = activeSelection != null && chartHoverTargetsEqual(activeSelection, target);
        const overBudget = datum.actual > datum.budget;
        return (
          <g
            key={`${datum.label}-${index}`}
            onMouseEnter={() => onActiveSelectionChange(target)}
            onMouseLeave={() => onActiveSelectionChange(null)}
          >
            <rect
              className={`chart-embed__bar chart-embed__bar--budget ${active ? 'is-active' : activeSelection != null ? 'is-muted' : ''}`}
              fill="#818cf8"
              height={Math.max(2, top + plotHeight - budgetY)}
              rx="4"
              width={barWidth}
              x={budgetX}
              y={budgetY}
            />
            <rect
              className={`chart-embed__bar chart-embed__bar--actual ${active ? 'is-active' : activeSelection != null ? 'is-muted' : ''}`}
              fill={overBudget ? '#f43f5e' : '#22c55e'}
              height={Math.max(2, top + plotHeight - actualY)}
              rx="4"
              width={barWidth}
              x={actualX}
              y={actualY}
            />
            {index % xLabelEvery === 0 || index === data.length - 1 ? (
              <text className="chart-embed__x-label" textAnchor="middle" x={center} y={height - 24}>
                {datum.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({
  chart,
  activeSelection,
  onActiveSelectionChange,
  data,
  series
}: ChartInteractiveProps & { data: IndexedChartDatum[]; series: IndexedChartSeries[] }) {
  const allSeries = lineSeries(chart);
  const multiSeries = allSeries.length > 1;
  if ((multiSeries && series.length === 0) || (!multiSeries && data.length === 0)) {
    return <div className="chart-embed__empty">All fields are hidden.</div>;
  }
  const width = 640;
  const height = 300;
  const left = 54;
  const right = 20;
  const top = 24;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const renderSeries = multiSeries
    ? series
    : [{ series: { name: allSeries[0]?.name ?? 'Series', data: data.map((item) => item.datum) }, originalIndex: 0 }];
  const pointOriginalIndices = multiSeries ? [] : data.map((item) => item.originalIndex);
  const longestSeries = renderSeries.reduce((best, item) => (item.series.data.length > best.series.data.length ? item : best), renderSeries[0]!);
  const maxPoints = Math.max(1, longestSeries.series.data.length);
  const { min, max } = chartRange(renderSeries.flatMap((item) => item.series.data));
  const xFor = (index: number) => left + (maxPoints === 1 ? plotWidth / 2 : (index / (maxPoints - 1)) * plotWidth);
  const yFor = (value: number) => top + ((max - value) / (max - min)) * plotHeight;
  const tickValues = [max, (max + min) / 2, min];
  const xLabelEvery = Math.max(1, Math.ceil(longestSeries.series.data.length / 8));

  return (
    <svg className="chart-embed__svg" role="img" viewBox={`0 0 ${width} ${height}`}>
      {tickValues.map((tick, index) => {
        const y = yFor(tick);
        return (
          <g key={index}>
            <line className="chart-embed__grid" x1={left} x2={width - right} y1={y} y2={y} />
            <text className="chart-embed__axis-label" textAnchor="end" x={left - 10} y={y + 4}>
              {formatChartValue(chart, tick)}
            </text>
          </g>
        );
      })}
      {renderSeries.map(({ series: item, originalIndex }) => {
        const color = multiSeries ? chartSeriesColor(item, originalIndex) : undefined;
        const points = item.data.map((datum, index) => `${xFor(index)},${yFor(datum.value)}`).join(' ');
        return (
          <polyline
            className={
              multiSeries
                ? chartItemClass('chart-embed__line', activeSelection, { kind: 'series', seriesIndex: originalIndex })
                : 'chart-embed__line'
            }
            key={`${item.name}-line-${originalIndex}`}
            onMouseEnter={() =>
              multiSeries ? onActiveSelectionChange({ kind: 'series', seriesIndex: originalIndex }) : undefined
            }
            onMouseLeave={() => (multiSeries ? onActiveSelectionChange(null) : undefined)}
            points={points}
            style={color ? { stroke: color } : undefined}
          />
        );
      })}
      {!multiSeries && activeSelection?.kind === 'datum' && pointOriginalIndices.includes(activeSelection.index) ? (
        <line
          className="chart-embed__hover-line"
          x1={xFor(pointOriginalIndices.indexOf(activeSelection.index))}
          x2={xFor(pointOriginalIndices.indexOf(activeSelection.index))}
          y1={top}
          y2={top + plotHeight}
        />
      ) : null}
      {longestSeries.series.data.map((datum, index) =>
        index % xLabelEvery === 0 || index === longestSeries.series.data.length - 1 ? (
          <text className="chart-embed__x-label" key={`${datum.label}-${index}`} textAnchor="middle" x={xFor(index)} y={height - 24}>
            {datum.label}
          </text>
        ) : null
      )}
      {renderSeries.map(({ series: item, originalIndex }) =>
        item.data.map((datum, index) => {
          const target: ChartHoverSelection = multiSeries
            ? { kind: 'segment', seriesIndex: originalIndex, label: datum.label }
            : { kind: 'datum', index: pointOriginalIndices[index] ?? index };
          const color = multiSeries ? chartSeriesColor(item, originalIndex) : undefined;
          return (
            <g
              key={`${item.name}-${datum.label}-${originalIndex}-${datum.label}`}
              onMouseEnter={() => onActiveSelectionChange(target)}
              onMouseLeave={() => onActiveSelectionChange(null)}
            >
              <circle
                className={chartItemClass('chart-embed__point', activeSelection, target)}
                cx={xFor(index)}
                cy={yFor(datum.value)}
                r="4.5"
                style={color ? { stroke: color } : undefined}
              />
            </g>
          );
        })
      )}
    </svg>
  );
}

function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
}

function PieChart({
  chart,
  activeSelection,
  onActiveSelectionChange,
  data
}: ChartInteractiveProps & { data: IndexedChartDatum[] }) {
  const positiveData = data.filter((item) => item.datum.value > 0);
  if (positiveData.length === 0) {
    return <div className="chart-embed__empty">No visible positive values.</div>;
  }
  const total = positiveData.reduce((sum, item) => sum + item.datum.value, 0);
  let angle = 0;

  return (
    <svg className="chart-embed__pie" role="img" viewBox="0 0 240 240">
      {positiveData.length === 1 ? (
        (() => {
          const target: ChartHoverSelection = { kind: 'datum', index: positiveData[0]!.originalIndex };
          return (
        <circle
          className={chartItemClass('chart-embed__slice', activeSelection, target)}
          cx="120"
          cy="120"
          fill={chartDatumColor(positiveData[0]!.datum, positiveData[0]!.originalIndex)}
          onMouseEnter={() => onActiveSelectionChange(target)}
          onMouseLeave={() => onActiveSelectionChange(null)}
          r="104"
        />
          );
        })()
      ) : (
        positiveData.map(({ datum, originalIndex }) => {
          const span = (datum.value / total) * 360;
          const start = angle;
          const end = angle + span;
          angle = end;
          const color = chartDatumColor(datum, originalIndex);
          const target: ChartHoverSelection = { kind: 'datum', index: originalIndex };
          return (
            <path
              className={chartItemClass('chart-embed__slice', activeSelection, target)}
              d={arcPath(120, 120, 104, start, end)}
              fill={color}
              key={`${datum.label}-${originalIndex}`}
              onMouseEnter={() => onActiveSelectionChange(target)}
              onMouseLeave={() => onActiveSelectionChange(null)}
            />
          );
        })
      )}
      {chart.type === 'donut' ? <circle className="chart-embed__donut-hole" cx="120" cy="120" r="58" /> : null}
    </svg>
  );
}

function BudgetLegend({
  chart,
  data,
  activeSelection,
  onActiveSelectionChange,
  hiddenIndices,
  onToggleVisibility
}: ChartInteractiveProps & { data: BudgetDatum[] }) {
  return (
    <div className="chart-embed__legend">
      {data.map((datum, index) => {
        const hidden = hiddenIndices.has(index);
        const delta = datum.actual - datum.budget;
        const target: ChartHoverSelection = { kind: 'budget', index };
        return (
          <div
            className={`${chartItemClass('chart-embed__legend-row', activeSelection, target)} ${hidden ? 'is-hidden' : ''}`}
            key={`${datum.label}-${index}`}
            onBlur={() => onActiveSelectionChange(null)}
            onClick={() => onToggleVisibility(index)}
            onFocus={() => onActiveSelectionChange(target)}
            onMouseEnter={() => onActiveSelectionChange(target)}
            onMouseLeave={() => onActiveSelectionChange(null)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleVisibility(index);
              }
            }}
          >
            <input
              aria-label={`${hidden ? 'Show' : 'Hide'} ${datum.label}`}
              checked={!hidden}
              className="chart-embed__legend-check"
              onChange={() => undefined}
              onClick={(e) => e.stopPropagation()}
              type="checkbox"
            />
            <span className="chart-embed__swatch chart-embed__swatch--split" />
            <span className="chart-embed__legend-label">{datum.label}</span>
            <strong>{formatChartValue(chart, datum.actual)}</strong>
            <span className={delta > 0 ? 'chart-embed__delta is-over' : 'chart-embed__delta is-under'}>
              {delta === 0 ? 'On budget' : `${delta > 0 ? '+' : ''}${formatChartValue(chart, delta)}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ChartTimeRangeControls({
  maxPoints,
  value,
  onChange
}: {
  maxPoints: number;
  value: number | 'all';
  onChange: (next: number | 'all') => void;
}) {
  if (maxPoints <= 6) return null;
  const options = [3, 6, 12].filter((count) => count < maxPoints);
  return (
    <div className="chart-embed__range-controls" aria-label="Chart time range">
      {options.map((count) => (
        <button
          className={value === count ? 'is-active' : ''}
          key={count}
          onClick={() => onChange(count)}
          type="button"
        >
          Last {count}
        </button>
      ))}
      <button className={value === 'all' ? 'is-active' : ''} onClick={() => onChange('all')} type="button">
        All
      </button>
    </div>
  );
}

function ChartDetails({
  chart,
  activeSelection,
  data,
  series,
  budgetData
}: {
  chart: ChartEmbed;
  activeSelection: ChartHoverSelection | null;
  data: IndexedChartDatum[];
  series: IndexedChartSeries[];
  budgetData: BudgetDatum[];
}) {
  const [renderedSelection, setRenderedSelection] = useState<ChartHoverSelection | null>(activeSelection);
  const [isVisible, setIsVisible] = useState(activeSelection != null);

  useEffect(() => {
    if (activeSelection != null) {
      setRenderedSelection(activeSelection);
      const id = window.setTimeout(() => setIsVisible(true), 10);
      return () => window.clearTimeout(id);
    }
    setIsVisible(false);
    const id = window.setTimeout(() => setRenderedSelection(null), 180);
    return () => window.clearTimeout(id);
  }, [activeSelection]);

  if (renderedSelection == null) return null;
  const content = resolveChartDetailsContent(chart, renderedSelection, data, series, budgetData);
  if (!content) return null;

  return (
    <div
      className={`chart-embed__details-shell${isVisible ? ' is-open' : ''}`}
      aria-hidden={!isVisible}
    >
      {content}
    </div>
  );
}

const CHART_DETAILS_SHOW_MS = 90;
const CHART_DETAILS_HIDE_MS = 140;

function ChartMessageEmbed({ chart }: { chart: ChartEmbed }) {
  const [activeSelection, setActiveSelection] = useState<ChartHoverSelection | null>(null);
  const [panelSelection, setPanelSelection] = useState<ChartHoverSelection | null>(null);
  const panelShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelVisibleRef = useRef(false);
  const detailsSlotRef = useRef<HTMLDivElement | null>(null);
  useChartDetailsLayoutLock(detailsSlotRef);
  const [hiddenIndices, setHiddenIndices] = useState<Set<number>>(() => new Set());
  const maxRangePoints =
    chart.type === 'budget'
      ? chart.budgetData?.length ?? 0
      : chart.type === 'line' || chart.type === 'stacked-bar' || chart.series?.length
        ? Math.max(...lineSeries(chart).map((item) => item.data.length), 0)
        : chart.data.length;
  const [range, setRange] = useState<number | 'all'>('all');
  const sliceStart = range === 'all' ? 0 : Math.max(0, maxRangePoints - range);
  const allData = indexedChartData(range === 'all' ? chart.data : chart.data.slice(sliceStart));
  const visibleData = allData.filter((item) => !hiddenIndices.has(item.originalIndex));
  const series =
    chart.type === 'line' || chart.type === 'stacked-bar' || chart.series?.length
      ? indexedLineSeries(lineSeries(chart))
      : [];
  const rangedSeries = series.map((item) => ({
    ...item,
    series: {
      ...item.series,
      data: range === 'all' ? item.series.data : item.series.data.slice(Math.max(0, item.series.data.length - range))
    }
  }));
  const visibleSeries = rangedSeries.filter((item) => !hiddenIndices.has(item.originalIndex));
  const budgetData = chart.type === 'budget' ? (range === 'all' ? chart.budgetData ?? [] : (chart.budgetData ?? []).slice(sliceStart)) : [];
  const visibleBudgetData = budgetData.filter((_, index) => !hiddenIndices.has(index));
  const lineHasMultipleSeries = chart.type === 'line' && series.length > 1;
  const stackedHasSeries = chart.type === 'stacked-bar' && series.length > 0;
  const groupedBarHasSeries = chart.type === 'bar' && series.length > 1;
  const legendData = chart.type === 'pie' || chart.type === 'donut' ? allData.filter((item) => item.datum.value > 0) : allData;
  const hasLegend =
    chart.type === 'budget' ||
    lineHasMultipleSeries ||
    stackedHasSeries ||
    groupedBarHasSeries ||
    legendData.length > 0;

  const onActiveSelectionChange = useCallback((selection: ChartHoverSelection | null) => {
    setActiveSelection(selection);
    if (panelShowTimerRef.current != null) {
      clearTimeout(panelShowTimerRef.current);
      panelShowTimerRef.current = null;
    }
    if (panelHideTimerRef.current != null) {
      clearTimeout(panelHideTimerRef.current);
      panelHideTimerRef.current = null;
    }
    if (selection != null) {
      const delay = panelVisibleRef.current ? 0 : CHART_DETAILS_SHOW_MS;
      panelShowTimerRef.current = setTimeout(() => {
        panelShowTimerRef.current = null;
        panelVisibleRef.current = true;
        lockChartDetailsScroll(detailsSlotRef.current);
        setPanelSelection(selection);
      }, delay);
      return;
    }
    panelHideTimerRef.current = setTimeout(() => {
      panelHideTimerRef.current = null;
      panelVisibleRef.current = false;
      lockChartDetailsScroll(detailsSlotRef.current);
      setPanelSelection(null);
    }, CHART_DETAILS_HIDE_MS);
  }, []);

  useEffect(
    () => () => {
      if (panelShowTimerRef.current != null) clearTimeout(panelShowTimerRef.current);
      if (panelHideTimerRef.current != null) clearTimeout(panelHideTimerRef.current);
    },
    []
  );

  const onToggleVisibility = (index: number) => {
    setHiddenIndices((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      onActiveSelectionChange(null);
      return next;
    });
  };
  const chartProps = { chart, activeSelection, onActiveSelectionChange, hiddenIndices, onToggleVisibility };

  return (
    <div className="message-embed message-embed--chart">
      <ChartHeader chart={chart} />
      <ChartTimeRangeControls maxPoints={maxRangePoints} value={range} onChange={setRange} />
      <div
        className={`chart-embed__body chart-embed__body--${chart.type}${hasLegend ? '' : ' chart-embed__body--solo'}`}
      >
        <div className="chart-embed__visual">
          {chart.type === 'bar' && groupedBarHasSeries ? <GroupedBarChart {...chartProps} series={visibleSeries} /> : null}
          {chart.type === 'bar' && !groupedBarHasSeries ? <BarChart {...chartProps} data={visibleData} /> : null}
          {chart.type === 'line' ? <LineChart {...chartProps} data={visibleData} series={visibleSeries} /> : null}
          {chart.type === 'stacked-bar' ? <StackedBarChart {...chartProps} series={visibleSeries} /> : null}
          {chart.type === 'budget' ? <BudgetChart {...chartProps} data={visibleBudgetData} /> : null}
          {chart.type === 'pie' || chart.type === 'donut' ? <PieChart {...chartProps} data={visibleData} /> : null}
        </div>
        <div
          ref={detailsSlotRef}
          className={`chart-embed__details-slot${panelSelection != null ? ' is-open' : ''}`}
          aria-live="polite"
        >
          <div className="chart-embed__details-slot-inner">
            <ChartDetails chart={chart} activeSelection={panelSelection} data={allData} series={series} budgetData={budgetData} />
          </div>
        </div>
        {chart.type === 'budget' ? (
          <div className="chart-embed__legend-slot">
            <BudgetLegend {...chartProps} data={budgetData} />
          </div>
        ) : lineHasMultipleSeries || stackedHasSeries || groupedBarHasSeries ? (
          <div className="chart-embed__legend-slot">
            <LineSeriesLegend {...chartProps} series={series} />
          </div>
        ) : legendData.length ? (
          <div className="chart-embed__legend-slot">
            <ChartLegend
              {...chartProps}
              data={legendData}
              showPercent={chart.type === 'pie' || chart.type === 'donut'}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatTableCell(value: string | number) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return value;
}

function compareTableValues(a: string | number | undefined, b: string | number | undefined) {
  const am = monthSortValue(a);
  const bm = monthSortValue(b);
  if (am != null && bm != null) return am - bm;
  const an = typeof a === 'number' ? a : Number(String(a ?? '').replace(/[$,%\s,]/g, ''));
  const bn = typeof b === 'number' ? b : Number(String(b ?? '').replace(/[$,%\s,]/g, ''));
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

function TableMessageEmbed({ table }: { table: TableEmbed }) {
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());
  const visibleColumns = table.columns.filter((column) => !hiddenKeys.has(column.key));
  const tableMinWidth = Math.max(
    560,
    visibleColumns.reduce((sum, column) => {
      const labelWidth = column.label.length * 9 + 48;
      return sum + (column.align === 'right' ? Math.max(116, labelWidth) : Math.max(104, Math.min(220, labelWidth)));
    }, 0)
  );
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    return [...table.rows].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const comparison = compareTableValues(av, bv);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [sort, table.rows]);

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    );
  };

  return (
    <div className="message-embed message-embed--table">
      <div className="chart-embed__header">
        <span className="message-embed__label">Interactive table</span>
        {table.title ? <h4 className="chart-embed__title">{table.title}</h4> : null}
        {table.subtitle ? <p className="chart-embed__subtitle">{table.subtitle}</p> : null}
      </div>
      <div className="data-table__column-controls">
        {table.columns.map((column) => {
          const hidden = hiddenKeys.has(column.key);
          return (
            <button
              className={hidden ? 'is-hidden' : ''}
              key={column.key}
              onClick={() =>
                setHiddenKeys((current) => {
                  const next = new Set(current);
                  if (next.has(column.key)) next.delete(column.key);
                  else next.add(column.key);
                  return next;
                })
              }
              type="button"
            >
              {hidden ? 'Show' : 'Hide'} {column.label}
            </button>
          );
        })}
      </div>
      <div className="data-table__wrap">
        <table className="data-table" style={{ minWidth: tableMinWidth }}>
          <thead>
            <tr>
              {visibleColumns.map((column) => (
                <th className={`is-${column.align ?? 'left'}`} key={column.key}>
                  <button onClick={() => toggleSort(column.key)} type="button">
                    {column.label}
                    {sort?.key === column.key ? <span>{sort.direction === 'asc' ? ' ↑' : ' ↓'}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {visibleColumns.map((column) => (
                  <td className={`is-${column.align ?? 'left'}`} key={column.key}>
                    {formatTableCell(row[column.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatsMessageEmbed({ stats }: { stats: StatsEmbed }) {
  return (
    <div className="message-embed message-embed--stats">
      <div className="chart-embed__header">
        <span className="message-embed__label">Summary</span>
        {stats.title ? <h4 className="chart-embed__title">{stats.title}</h4> : null}
        {stats.subtitle ? <p className="chart-embed__subtitle">{stats.subtitle}</p> : null}
      </div>
      <div className="stats-embed__grid">
        {stats.cards.map((card) => (
          <div className={`stats-embed__card is-${card.tone ?? 'neutral'}`} key={`${card.label}-${card.value}`}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            {card.delta ? <em>{card.delta}</em> : null}
            {card.detail ? <small>{card.detail}</small> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function quizAnswersText(quiz: QuizEmbed, selected: Record<number, number>) {
  const lines = ['Quiz answers:'];
  quiz.questions.forEach((question, questionIndex) => {
    const choiceIndex = selected[questionIndex];
    const answer = choiceIndex == null ? '[unanswered]' : question.choices[choiceIndex] ?? '[unanswered]';
    const label = choiceIndex == null ? '?' : choiceLabel(choiceIndex);
    lines.push(`${questionIndex + 1}. ${question.question}`);
    lines.push(`Answer: ${label}. ${answer}`);
  });
  return lines.join('\n');
}

function QuizMessageEmbed({
  quiz,
  submitDisabled,
  completedSelected,
  onSubmitQuizAnswers
}: {
  quiz: QuizEmbed;
  submitDisabled?: boolean;
  completedSelected?: Record<number, number>;
  onSubmitQuizAnswers: (answersText: string) => void;
}) {
  const locked = completedSelected != null;
  const [selected, setSelected] = useState<Record<number, number>>(completedSelected ?? {});
  const [submitted, setSubmitted] = useState(locked);
  const answeredCount = useMemo(
    () => quiz.questions.filter((_, index) => selected[index] != null).length,
    [quiz.questions, selected]
  );
  const complete = answeredCount === quiz.questions.length;

  useEffect(() => {
    if (!completedSelected) return;
    setSelected(completedSelected);
    setSubmitted(true);
  }, [completedSelected]);

  useEffect(() => {
    if (locked || !complete || submitted || submitDisabled) return;
    setSubmitted(true);
    onSubmitQuizAnswers(quizAnswersText(quiz, selected));
  }, [complete, locked, onSubmitQuizAnswers, quiz, selected, submitDisabled, submitted]);

  return (
    <div className="message-embed message-embed--quiz">
      <div className="quiz-embed__header">
        <span className="message-embed__label">Multiple choice quiz</span>
        <span className="quiz-embed__progress">
          {answeredCount}/{quiz.questions.length} answered
        </span>
      </div>
      {quiz.title ? <h4 className="quiz-embed__title">{quiz.title}</h4> : null}
      <div className="quiz-embed__questions">
        {quiz.questions.map((question, questionIndex) => (
          <fieldset className="quiz-embed__question" disabled={submitted || locked} key={`${questionIndex}-${question.question}`}>
            <legend>
              <span>{questionIndex + 1}.</span> {question.question}
            </legend>
            <div className="quiz-embed__choices">
              {question.choices.map((choice, choiceIndex) => {
                const active = selected[questionIndex] === choiceIndex;
                return (
                  <button
                    aria-pressed={active}
                    className={`quiz-embed__choice ${active ? 'is-selected' : ''}`}
                    key={`${choiceIndex}-${choice}`}
                    onClick={() =>
                      setSelected((current) => ({
                        ...current,
                        [questionIndex]: choiceIndex
                      }))
                    }
                    type="button"
                  >
                    <span className="quiz-embed__bubble">{choiceLabel(choiceIndex)}</span>
                    <span>{choice}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="quiz-embed__footer">
        {locked
          ? 'Quiz completed.'
          : submitted
            ? 'Answers sent.'
          : complete && submitDisabled
            ? 'Answers selected. Sending when the response finishes...'
            : complete
              ? 'Sending answers...'
              : 'Select one answer for each question.'}
      </div>
    </div>
  );
}

/**
 * Renders assistant markdown, replacing model-emitted embed tokens with live controls
 * (`MYTHRA_*` tokens and legacy `OPENKIWI_*` placeholders).
 */
export function AssistantMessageContent({
  text,
  sessionMode,
  onSessionModeToggle,
  sessionModeToggleDisabled = false,
  webSearch,
  onWebSearchChange,
  webSearchDisabled = false,
  quizSubmitDisabled = false,
  completedQuizSelections,
  mentionNames = [],
  onSubmitQuizAnswers
}: Props) {
  const segments = parseAssistantEmbeds(text);
  if (segments.length === 1 && segments[0]!.type === 'md') {
    return <ChatMarkdown mentionNames={mentionNames} text={segments[0]!.text} />;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'md') {
          return <Fragment key={i}>{seg.text ? <ChatMarkdown mentionNames={mentionNames} text={seg.text} /> : null}</Fragment>;
        }
        if (seg.type === 'session') {
          return (
            <SessionModeMessageEmbed
              key={i}
              disabled={sessionModeToggleDisabled}
              onSessionModeToggle={onSessionModeToggle}
              sessionMode={sessionMode}
            />
          );
        }
        if (seg.type === 'web') {
          /* Inline Web toggle is only useful when Web is off; if it is already on, do not duplicate the header control. */
          if (webSearch) {
            return null;
          }
          return (
            <WebSearchMessageEmbed
              key={i}
              disabled={webSearchDisabled}
              onWebSearchChange={onWebSearchChange}
              webSearch={webSearch}
            />
          );
        }
        if (seg.type === 'chart') {
          return <ChartMessageEmbed chart={seg.chart} key={i} />;
        }
        if (seg.type === 'table') {
          return <TableMessageEmbed key={i} table={seg.table} />;
        }
        if (seg.type === 'stats') {
          return <StatsMessageEmbed key={i} stats={seg.stats} />;
        }
        const quizIndex = segments.slice(0, i).filter((candidate) => candidate.type === 'quiz').length;
        return (
          <QuizMessageEmbed
            completedSelected={completedQuizSelections?.[quizIndex]}
            key={i}
            onSubmitQuizAnswers={onSubmitQuizAnswers}
            quiz={seg.quiz}
            submitDisabled={quizSubmitDisabled}
          />
        );
      })}
    </>
  );
}
