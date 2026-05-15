import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import mythraTextImage from '../../../Images/onboarding_1-1.png';
import chatsImage1 from '../../../Images/onboarding_2-1.png';
import chatsImage2 from '../../../Images/onboarding_2-2.png';
import chatsImage3 from '../../../Images/onboarding_2-3.png';
import webImage1 from '../../../Images/onboarding_3-1.png';
import webImage2 from '../../../Images/onboarding_3-2.png';
import connectionImage from '../../../Images/onboarding_4-1.png';
import systemPromptImage from '../../../Images/onboarding_5-1.png';
import wizardOnboarding1 from '../../../Images/onboarding_6-1.png';
import wizardOnboarding2 from '../../../Images/onboarding_6-2.png';
import nexusOnboarding1 from '../../../Images/onboarding_7-1.png';
import nexusOnboarding2 from '../../../Images/onboarding_7-2.png';
import nexusOnboarding3 from '../../../Images/onboarding_7-3.png';

interface OnboardingDialogProps {
  open: boolean;
  onComplete: () => void;
}

const pages = [
  {
    kicker: 'Welcome',
    title: 'Meet Mythra',
    body:
      'Mythra is a local AI workspace for chatting, coding, editing files, searching the web, and building longer-running AI assistants called Wizards.',
    points: [
      'Start simple with a normal chat.',
      'Open a workspace when you want AI help with files.',
      'Use Wizards and Nexus projects when you want persistent AI teammates.'
    ],
    imageLabel: 'Main app overview screenshot',
    imageSrc: mythraTextImage,
    imageClassName: 'onboarding-dialog__image--welcome'
  },
  {
    kicker: 'Normal Chats',
    title: 'Chat mode and Agent mode',
    body:
      'Normal chats can switch between two behaviors. Chat mode is for regular conversation. Agent mode gives the model access to tools, your open workspace, and coding actions.',
    points: [
      'Use Chat for questions, brainstorming, and writing.',
      'Use Agent when you want the AI to inspect files, make edits, run commands, or explain a project.',
      'The mode switch is at the top of the conversation.'
    ],
    imageLabel: 'Chat / Agent mode switch screenshots',
    imageList: [
      { src: chatsImage1, alt: 'Normal chat list screenshot' },
      { src: chatsImage2, alt: 'Chat mode screenshot' },
      { src: chatsImage3, alt: 'Agent mode screenshot' }
    ],
    imageClassName: 'onboarding-dialog__image--chat'
  },
  {
    kicker: 'Web Search',
    title: 'Let models look things up',
    body:
      'The Web toggle gives the AI a search tool. Without an API key, search can still work, but results may be thin. API keys connect Mythra to better search services.',
    points: [
      'An API key is like a password from a service that lets this app use that service.',
      'Tavily is recommended for AI-ready search results.',
      'Brave Search is a strong general web-search option.'
    ],
    imageLabel: 'Web toggle and search settings screenshots',
    imageList: [
      { src: webImage1, alt: 'Web search toggle screenshot' },
      { src: webImage2, alt: 'Web search API key settings screenshot' }
    ],
    imageClassName: 'onboarding-dialog__image--web',
    imageStripClassName: 'onboarding-dialog__image-strip--two'
  },
  {
    kicker: 'Connection',
    title: 'Choose where models come from',
    body:
      'Mythra can talk to models through LM Studio, OpenRouter, or Ollama. You can change providers and models in Settings.',
    points: [
      'LM Studio and Ollama run models on your own computer.',
      'OpenRouter connects to hosted cloud models through one API key.',
      'The selected model controls how smart, fast, and expensive a response may be.'
    ],
    imageLabel: 'Provider and model settings screenshot',
    imageSrc: connectionImage,
    imageClassName: 'onboarding-dialog__image--connection'
  },
  {
    kicker: 'System Prompt',
    title: 'Set the AI’s default instructions',
    body:
      'The system prompt is the instruction layer the model reads before your messages. It can define tone, rules, workflows, and what the model should remember during a chat.',
    points: [
      'Keep it clear and practical.',
      'Use presets when you want different default behaviors.',
      'In Agent mode, you can optionally allow models to suggest prompt changes.'
    ],
    imageLabel: 'System prompt section screenshot',
    imageSrc: systemPromptImage,
    imageClassName: 'onboarding-dialog__image--system-prompt'
  },
  {
    kicker: 'Wizards',
    title: 'Create persistent AI assistants',
    body:
      'A Wizard is a named AI with its own model, private local workspace, system prompt, and Markdown memory documents.',
    points: [
      'Each Wizard gets documents like identity.md, personality.md, tools.md, memory.md, and corrections.md.',
      'Those documents are injected into Wizard chats automatically.',
      'A Wizard can have multiple sessions while keeping the same identity and memory files.'
    ],
    imageLabel: 'Wizard sidebar and settings screenshot',
    imageList: [
      { src: wizardOnboarding1, alt: 'Wizard sidebar screenshot' },
      { src: wizardOnboarding2, alt: 'Wizard settings screenshot' }
    ],
    imageClassName: 'onboarding-dialog__image--wizard',
    imageStripClassName: 'onboarding-dialog__image-strip--two'
  },
  {
    kicker: 'Nexus',
    title: 'Bring Wizards together on a project',
    body:
      'A Nexus project lets multiple Wizards work in one shared project folder while keeping their own private identities and memory documents.',
    points: [
      'Choose a leader Wizard and teammates.',
      'Each Wizard can respond as itself and use the shared Nexus workspace.',
      'Nexus is built for planning, delegation, coding, review, and project collaboration.'
    ],
    imageLabel: 'Nexus project room screenshot',
    imageList: [
      { src: nexusOnboarding1, alt: 'Nexus project overview screenshot' },
      { src: nexusOnboarding2, alt: 'Nexus workspace screenshot' },
      { src: nexusOnboarding3, alt: 'Nexus collaboration screenshot' }
    ],
    imageClassName: 'onboarding-dialog__image--nexus'
  },
  {
    kicker: 'Ready',
    title: 'You can start small',
    body:
      'You do not need to set everything up at once. Start with a normal chat, connect a model, and add Wizards or Nexus projects when you are ready.',
    points: [
      'Open Settings first if you need to add an API key or choose a model.',
      'Create a normal chat for everyday work.',
      'Create a Wizard when you want a persistent assistant.'
    ],
    imageLabel: 'Main app overview screenshot',
    imageSrc: mythraTextImage,
    imageClassName: 'onboarding-dialog__image--welcome'
  }
];

type OnboardingPage = (typeof pages)[number];

function OnboardingStepBody({ page, progress }: { page: OnboardingPage; progress: string }) {
  return (
    <>
      <div className="onboarding-dialog__header">
        <div>
          <div className="app-dialog__kicker">{page.kicker}</div>
          <h3>{page.title}</h3>
        </div>
        <span className="onboarding-dialog__progress">{progress}</span>
      </div>

      <div className="onboarding-dialog__visual" aria-label={page.imageLabel}>
        <div
          className={`onboarding-dialog__visual-frame ${
            ('imageSrc' in page && page.imageSrc) || ('imageList' in page && page.imageList?.length) ? 'has-image' : ''
          }`}
        >
          {'imageSrc' in page && page.imageSrc ? (
            <img
              alt={page.imageLabel}
              className={'imageClassName' in page ? page.imageClassName : undefined}
              src={page.imageSrc}
            />
          ) : 'imageList' in page && page.imageList?.length ? (
            <div
              className={`onboarding-dialog__image-strip ${'imageStripClassName' in page ? page.imageStripClassName : ''}`}
            >
              {page.imageList.map((image) => (
                <img
                  alt={image.alt}
                  className={'imageClassName' in page ? page.imageClassName : undefined}
                  key={image.src}
                  src={image.src}
                />
              ))}
            </div>
          ) : (
            <span>{page.imageLabel}</span>
          )}
        </div>
      </div>

      <p>{page.body}</p>

      <ul className="onboarding-dialog__points">
        {page.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </>
  );
}

const contentTransition = { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const };

const pageShellTransition = {
  duration: 0.34,
  ease: [0.22, 1, 0.36, 1] as const
};

/** Layout height unaffected by transform/blur during step transitions (unlike getBoundingClientRect). */
function readSlideLayoutHeight(slide: HTMLElement): number {
  return Math.ceil(slide.offsetHeight);
}

/**
 * Measure clone after images have dimensions so target height matches the real step (avoids a second resize).
 */
function measureCloneRootHeight(root: HTMLElement, onDone: (h: number) => void) {
  let done = false;
  const finish = (h: number) => {
    if (done) return;
    done = true;
    onDone(h);
  };

  const measure = () => {
    const el = (root.querySelector('.onboarding-dialog__page') as HTMLElement | null) ?? root;
    finish(Math.max(0, readSlideLayoutHeight(el)));
  };

  const imgs = [...root.querySelectorAll('img')];
  const incomplete = imgs.filter((i) => !i.complete);
  if (incomplete.length === 0) {
    requestAnimationFrame(measure);
    return;
  }
  let left = incomplete.length;
  const tick = () => {
    if (--left <= 0) requestAnimationFrame(measure);
  };
  for (const img of incomplete) {
    img.addEventListener('load', tick, { once: true });
    img.addEventListener('error', tick, { once: true });
  }
}

const pageVariants = {
  initial: (dir: number) => ({
    opacity: 0,
    x: dir * 32,
    filter: 'blur(6px)'
  }),
  animate: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)'
  },
  exit: (dir: number) => ({
    opacity: 0,
    x: dir * -32,
    filter: 'blur(6px)'
  })
};

export function OnboardingDialog({ open, onComplete }: OnboardingDialogProps) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [contentVisible, setContentVisible] = useState(true);
  const [measureIndex, setMeasureIndex] = useState<number | null>(null);
  const [pageShellHeight, setPageShellHeight] = useState<number | null>(null);
  const [awaitingShellAfterResize, setAwaitingShellAfterResize] = useState(false);

  const measureHostRef = useRef<HTMLDivElement>(null);
  const measureCloneRef = useRef<HTMLDivElement>(null);
  const pendingTargetRef = useRef<number | null>(null);
  const resizeCompleteTargetRef = useRef<number | null>(null);
  const pageShellHeightRef = useRef<number | null>(null);
  /** Height from the pre-navigation clone; ignore near-matching ResizeObserver churn right after. */
  const shellLockHeightRef = useRef<number | null>(null);
  const shellLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Avoids stale state in `onAnimationComplete` and ignores unrelated height animations. */
  const expectShellResizeCompleteRef = useRef(false);

  const page = pages[index] ?? pages[0];
  const isLast = index === pages.length - 1;
  const progress = useMemo(() => `${index + 1} of ${pages.length}`, [index]);

  const navLocked = !contentVisible || measureIndex !== null || awaitingShellAfterResize;

  useEffect(() => {
    pageShellHeightRef.current = pageShellHeight;
  }, [pageShellHeight]);

  const syncPageShellHeightFromVisible = useCallback(() => {
    if (!contentVisible) return;
    const host = measureHostRef.current;
    if (!host) return;
    const slide = host.firstElementChild as HTMLElement | null;
    if (!slide) return;
    const next = readSlideLayoutHeight(slide);
    if (next < 1) return;

    const lockH = shellLockHeightRef.current;
    if (lockH !== null && Math.abs(next - lockH) <= 8) return;

    const prev = pageShellHeightRef.current;
    if (prev !== null && Math.abs(next - prev) <= 6) return;

    setPageShellHeight(next);
  }, [contentVisible]);

  const finishNavSequence = useCallback((target: number) => {
    expectShellResizeCompleteRef.current = false;
    setIndex(target);
    setContentVisible(true);
    setAwaitingShellAfterResize(false);
    pendingTargetRef.current = null;
    resizeCompleteTargetRef.current = null;
  }, []);

  useEffect(() => {
    if (open) {
      setIndex(0);
      setDirection(1);
      setContentVisible(true);
      setMeasureIndex(null);
      setPageShellHeight(null);
      setAwaitingShellAfterResize(false);
      expectShellResizeCompleteRef.current = false;
      pendingTargetRef.current = null;
      resizeCompleteTargetRef.current = null;
      shellLockHeightRef.current = null;
      if (shellLockTimerRef.current) {
        clearTimeout(shellLockTimerRef.current);
        shellLockTimerRef.current = null;
      }
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !contentVisible) return;
    syncPageShellHeightFromVisible();
  }, [open, contentVisible, syncPageShellHeightFromVisible]);

  useLayoutEffect(() => {
    const host = measureHostRef.current;
    if (!host || !contentVisible) return;
    const ro = new ResizeObserver(() => {
      syncPageShellHeightFromVisible();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [syncPageShellHeightFromVisible, open, contentVisible]);

  useLayoutEffect(() => {
    if (measureIndex === null) return;
    let cancelled = false;
    const target = measureIndex;
    const el = measureCloneRef.current;
    if (!el) {
      setMeasureIndex(null);
      finishNavSequence(target);
      return;
    }

    measureCloneRootHeight(el, (h) => {
      if (cancelled) return;
      setMeasureIndex(null);
      if (h < 1) {
        finishNavSequence(target);
        return;
      }
      const prevH = pageShellHeightRef.current;
      if (prevH !== null && Math.abs(h - prevH) < 2) {
        finishNavSequence(target);
        return;
      }
      if (shellLockTimerRef.current) {
        clearTimeout(shellLockTimerRef.current);
        shellLockTimerRef.current = null;
      }
      shellLockHeightRef.current = h;
      shellLockTimerRef.current = setTimeout(() => {
        shellLockHeightRef.current = null;
        shellLockTimerRef.current = null;
      }, 450);

      resizeCompleteTargetRef.current = target;
      expectShellResizeCompleteRef.current = true;
      setAwaitingShellAfterResize(true);
      setPageShellHeight(h);
    });

    return () => {
      cancelled = true;
    };
  }, [measureIndex, finishNavSequence]);

  const handleExitComplete = useCallback(() => {
    const target = pendingTargetRef.current;
    if (target === null) return;
    setMeasureIndex(target);
  }, []);

  const handlePageShellAnimationComplete = useCallback(() => {
    if (!expectShellResizeCompleteRef.current) return;
    const target = resizeCompleteTargetRef.current;
    if (target === null) {
      expectShellResizeCompleteRef.current = false;
      setAwaitingShellAfterResize(false);
      return;
    }
    finishNavSequence(target);
  }, [finishNavSequence]);

  const goBack = () => {
    if (navLocked || index === 0) return;
    pendingTargetRef.current = index - 1;
    setDirection(-1);
    setContentVisible(false);
  };

  const goNext = () => {
    if (navLocked) return;
    if (isLast) {
      onComplete();
      return;
    }
    pendingTargetRef.current = index + 1;
    setDirection(1);
    setContentVisible(false);
  };

  const handleSkip = () => {
    pendingTargetRef.current = null;
    resizeCompleteTargetRef.current = null;
    expectShellResizeCompleteRef.current = false;
    shellLockHeightRef.current = null;
    if (shellLockTimerRef.current) {
      clearTimeout(shellLockTimerRef.current);
      shellLockTimerRef.current = null;
    }
    setMeasureIndex(null);
    setAwaitingShellAfterResize(false);
    setContentVisible(true);
    onComplete();
  };

  return (
    <AnimatePresence>
      {open ? (
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
            className="app-dialog onboarding-dialog"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={{
              opacity: { duration: 0.18, ease: 'easeOut' },
              scale: { duration: 0.18, ease: 'easeOut' },
              y: { duration: 0.18, ease: 'easeOut' }
            }}
          >
            <motion.div
              animate={{ height: pageShellHeight ?? 'auto' }}
              className="onboarding-dialog__page-shell"
              initial={false}
              onAnimationComplete={handlePageShellAnimationComplete}
              style={{ overflow: 'hidden' }}
              transition={pageShellTransition}
            >
              <div className="onboarding-dialog__measure-host" ref={measureHostRef}>
                <AnimatePresence custom={direction} initial={false} onExitComplete={handleExitComplete}>
                  {contentVisible ? (
                    <motion.div
                      animate="animate"
                      className="onboarding-dialog__page"
                      custom={direction}
                      exit="exit"
                      initial="initial"
                      key={index}
                      transition={contentTransition}
                      variants={pageVariants}
                    >
                      <OnboardingStepBody page={page} progress={progress} />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              {measureIndex !== null ? (
                <div className="onboarding-dialog__measure-clone" ref={measureCloneRef} aria-hidden>
                  <div className="onboarding-dialog__page">
                    <OnboardingStepBody
                      page={pages[measureIndex]!}
                      progress={`${measureIndex + 1} of ${pages.length}`}
                    />
                  </div>
                </div>
              ) : null}
            </motion.div>

            <div className="onboarding-dialog__dots" aria-hidden>
              {pages.map((item, i) => (
                <span className={i === index ? 'is-active' : ''} key={item.title} />
              ))}
            </div>

            <div className="app-dialog__actions onboarding-dialog__actions">
              <button className="btn btn--secondary" onClick={handleSkip} type="button">
                Skip
              </button>
              <div className="onboarding-dialog__nav">
                <button className="btn btn--secondary" disabled={index === 0 || navLocked} onClick={goBack} type="button">
                  Back
                </button>
                <button className="btn btn--primary" disabled={navLocked && !isLast} onClick={goNext} type="button">
                  {isLast ? 'Get started' : 'Next'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
