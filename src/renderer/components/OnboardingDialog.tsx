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
    title: 'Give an AI the context that matters to you',
    body:
      'Mythra is built around Wizards: persistent AI assistants that carry your selected Markdown instructions, knowledge, examples, and memory into every conversation.',
    points: [
      'Choose any supported OpenRouter or local model.',
      'Keep your source material in transparent local Markdown files.',
      'Start new sessions without teaching the same context again.'
    ],
    imageLabel: 'Mythra Wizard workspace',
    imageSrc: mythraTextImage,
    imageClassName: 'onboarding-dialog__image--welcome'
  },
  {
    kicker: 'Wizards',
    title: 'Build a specialist once, then keep talking',
    body:
      'A Wizard combines a model, a system prompt, persistent sessions, enabled tools, and a private folder of Markdown context you control.',
    points: [
      'Use identity and personality files to shape how it responds.',
      'Add learning material, writing samples, research, or reference notes.',
      'Create multiple Wizards for different subjects, styles, or workflows.'
    ],
    imageLabel: 'Wizard library and context settings',
    imageList: [
      { src: wizardOnboarding1, alt: 'Wizard library' },
      { src: wizardOnboarding2, alt: 'Wizard context settings' }
    ],
    imageClassName: 'onboarding-dialog__image--wizard',
    imageStripClassName: 'onboarding-dialog__image-strip--two'
  },
  {
    kicker: 'Always-on context',
    title: 'Know exactly what the model receives',
    body:
      'Selected Markdown documents are included every time you send a message. Mythra shows which files are included and estimates how much context they use.',
    points: [
      'Turn individual documents on or off without deleting them.',
      'Edit context directly and use the updated version on the next message.',
      'Keep corrections and durable memory alongside the source material.'
    ],
    imageLabel: 'Wizard context document controls',
    imageSrc: wizardOnboarding2,
    imageClassName: 'onboarding-dialog__image--wizard'
  },
  {
    kicker: 'Models & tools',
    title: 'Use the right intelligence for each Wizard',
    body:
      'Connect OpenRouter, LM Studio, or Ollama, then choose a model per Wizard. Wizards can also use enabled tools for search, files, commands, and other actions when useful.',
    points: [
      'Switch models without rebuilding the Wizard’s context.',
      'Keep sensitive actions behind approvals or enable full access intentionally.',
      'Use Web search when the Wizard needs current public information.'
    ],
    imageLabel: 'Provider and model settings',
    imageSrc: connectionImage,
    imageClassName: 'onboarding-dialog__image--connection'
  },
  {
    kicker: 'Regular chats',
    title: 'Quick conversations are still here',
    body:
      'Use Quick chat when you do not need a persistent specialist. Plain Chat keeps tools off; Tools mode makes enabled capabilities available for that conversation.',
    points: [
      'Start a disposable conversation in one click.',
      'Search across regular chats and Wizard sessions.',
      'Create a Wizard when the same context will be valuable again.'
    ],
    imageLabel: 'Regular chat controls',
    imageList: [
      { src: chatsImage1, alt: 'Regular chat list' },
      { src: chatsImage2, alt: 'Chat and Tools controls' }
    ],
    imageClassName: 'onboarding-dialog__image--chat',
    imageStripClassName: 'onboarding-dialog__image-strip--two'
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
