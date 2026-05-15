import { Fragment, useEffect, useMemo, useState } from 'react';
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

type EmbedSegment =
  | { type: 'md'; text: string }
  | { type: 'session' }
  | { type: 'web' }
  | { type: 'quiz'; quiz: QuizEmbed };

const QUIZ_FENCE_RE = /```mythra-quiz\s*([\s\S]*?)```/gi;
const MAX_QUIZ_QUESTIONS = 25;
const MAX_QUIZ_CHOICES = 8;

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

function textHasAnyEmbedToken(text: string): boolean {
  return (
    [...SESSION_MODE_EMBED_STRINGS, ...WEB_SEARCH_EMBED_STRINGS].some((t) => text.includes(t)) ||
    /```mythra-quiz/i.test(text)
  );
}

function findNextEmbed(rest: string): { i: number; len: number; kind: 'session' | 'web' } | { i: number; len: number; kind: 'quiz'; quiz: QuizEmbed } | null {
  let best: { i: number; len: number; kind: 'session' | 'web' } | { i: number; len: number; kind: 'quiz'; quiz: QuizEmbed } | null = null;
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
  onSubmitQuizAnswers
}: {
  quiz: QuizEmbed;
  submitDisabled?: boolean;
  onSubmitQuizAnswers: (answersText: string) => void;
}) {
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const answeredCount = useMemo(
    () => quiz.questions.filter((_, index) => selected[index] != null).length,
    [quiz.questions, selected]
  );
  const complete = answeredCount === quiz.questions.length;

  useEffect(() => {
    if (!complete || submitted || submitDisabled) return;
    setSubmitted(true);
    onSubmitQuizAnswers(quizAnswersText(quiz, selected));
  }, [complete, onSubmitQuizAnswers, quiz, selected, submitDisabled, submitted]);

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
          <fieldset className="quiz-embed__question" disabled={submitted} key={`${questionIndex}-${question.question}`}>
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
        {submitted
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
  onSubmitQuizAnswers
}: Props) {
  const segments = parseAssistantEmbeds(text);
  if (segments.length === 1 && segments[0]!.type === 'md') {
    return <ChatMarkdown text={segments[0]!.text} />;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'md') {
          return <Fragment key={i}>{seg.text ? <ChatMarkdown text={seg.text} /> : null}</Fragment>;
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
        return (
          <QuizMessageEmbed
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
