import { AnimatePresence, motion } from 'framer-motion';

const dialogTransition = { duration: 0.18, ease: 'easeOut' as const };

interface SystemPromptInfoDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SystemPromptInfoDialog({ open, onClose }: SystemPromptInfoDialogProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          onClick={onClose}
          role="presentation"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            onClick={(e) => e.stopPropagation()}
            aria-describedby="system-prompt-info-desc"
            aria-labelledby="system-prompt-info-title"
            aria-modal="true"
            className="app-dialog app-dialog--scrollable"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={dialogTransition}
          >
            <div className="app-dialog__kicker">System prompt</div>
            <h3 id="system-prompt-info-title">What it is (and ideas to try)</h3>
            <p id="system-prompt-info-desc">
              Your <strong>system prompt</strong> is standing instruction text Mythra sends to the model together with your
              chat. It does not replace what you type in the message box. Instead, it nudges the assistant&apos;s defaults:
              tone, how much detail to give, formatting habits, and boundaries you care about every time you talk.
            </p>

            <div className="app-dialog__section">
              <div className="app-dialog__section-title">Presets and Wizards</div>
              <p>
                In <strong>Settings → System Prompt</strong>, the <strong>Preset</strong> menu saves named prompt
                versions per <strong>provider</strong> (LM Studio, OpenRouter, or Ollama). Switch presets when you change
                projects or want a different baseline without rewriting everything—<strong>Save as new…</strong> is an easy way to
                experiment while keeping a fallback.
              </p>
              <p>
                <strong>Wizards</strong> store one system prompt with that Wizard. You will not see the provider preset
                picker there, but everything else in this guide—tone, structure, depth—applies the same way.
              </p>
            </div>

            <div className="app-dialog__section">
              <div className="app-dialog__section-title">Clearer answers with structure</div>
              <p>
                A single short paragraph can change how replies look. Models often mirror what you describe. For example,
                this kind of note led one install to shift from plain walls of text to replies that regularly used
                headings, bullets, and tables when they helped—but not every trivial reply needed heavy formatting.
              </p>
              <pre className="app-dialog__snippet">{`Also don't just give regular outputs all the time. You can use tables, bullet points, and similar methods for providing clear and easy to understand information for users.`}</pre>
              <p>
                You can refine that idea: ask for markdown structure when comparing options or listing steps, and plain
                short answers when a single sentence is enough.
              </p>
            </div>

            <div className="app-dialog__section">
              <div className="app-dialog__section-title">Personality and voice</div>
              <p>
                Name a steady voice instead of listing ten adjectives: e.g. &quot;warm and patient,&quot; &quot;direct and
                concise,&quot; &quot;explain like I&apos;m new to the topic,&quot; or &quot;senior engineer reviewing a
                design.&quot;
              </p>
            </div>

            <div className="app-dialog__section">
              <div className="app-dialog__section-title">Depth, code, and honesty</div>
              <p>
                Ask for behaviors: answer in one line first then details, outline tradeoffs before a recommendation,
                prefer diffs/snippets over dumping whole files unless you asked for full context. Say when you&apos;d
                rather hear &quot;I don&apos;t know&quot; than a guess—especially for facts, URLs, or version-specific
                behavior.
              </p>
            </div>

            <div className="app-dialog__section">
              <div className="app-dialog__section-title">How to iterate</div>
              <p>
                Small edits are easier to reason about than one huge block. Adjust one habit at a time, try a chat or two,
                then tighten the wording. Wizards use the same ideas: their prompt is theirs alone and applies anytime that
                Wizard is active.
              </p>
            </div>

            <div className="app-dialog__actions">
              <button className="btn btn--primary" onClick={onClose} type="button">
                Got it
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
