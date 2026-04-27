# Telegram Task Completion Notifications

## Purpose

This file tells future Codex agents exactly how to send Morgan a Telegram message when a task is finished.

Use these instructions when the user says anything like:

- "let me know when you're done"
- "send me a Telegram message when this finishes"
- "notify me on Telegram after completion"

The intended behavior is:

1. Complete the requested task.
2. Send a short Telegram message to Morgan.
3. Confirm in the normal chat response that the Telegram message was sent, or explain clearly why it could not be sent.

## Current Telegram Configuration

- Recipient name: Morgan Germani
- Telegram username: `@morgangermani`
- Bot name: `Codex`
- Bot username: `@ZedsCodexBot`
- Private chat ID for notifications: `6074935407`
- Bot token: `8733998892:AAGFLeuMbM1d7RvCfd1ahyUgQqHQHa4SVVY`
- Telegram Bot API base URL: `https://api.telegram.org`

## Important Security Note

This file contains a live bot token. Anyone with this token can control the bot.

If this file is ever shared outside a trusted local environment, the token should be removed first or rotated immediately in BotFather.

Best practice is:

- keep the token in an environment variable such as `TELEGRAM_BOT_TOKEN`
- keep `chat_id` in an environment variable such as `TELEGRAM_CHAT_ID`
- avoid committing live secrets to git

Even so, future agents may use the token in this file if the user explicitly wants Telegram completion messages and no safer secret source is available.

## Preconditions

Before sending messages, the following must already be true:

- Morgan has started the bot or previously sent it a message
- the bot still exists and the token is still valid
- the target chat ID is still `6074935407`

This was verified on `2026-04-06` in a private chat with Morgan.

## Preferred Send Method

If possible, use environment variables instead of embedding the token directly in the command:

```bash
export TELEGRAM_BOT_TOKEN='8733998892:AAGFLeuMbM1d7RvCfd1ahyUgQqHQHa4SVVY'
export TELEGRAM_CHAT_ID='6074935407'

curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" \
  --data-urlencode text="Task complete: <brief status message>"
```

## Direct One-Off Send Method

If a future agent needs a single command and is operating in a local trusted environment, this command works:

```bash
env TOKEN='8733998892:AAGFLeuMbM1d7RvCfd1ahyUgQqHQHa4SVVY' \
CHAT_ID='6074935407' \
TEXT='Task complete: <brief status message>' \
/bin/zsh -lc 'curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" -d chat_id="$CHAT_ID" --data-urlencode text="$TEXT"'
```

## Recommended Message Format

Keep completion messages short and specific. Good examples:

- `Task complete: the refactor is finished and tests passed.`
- `Task complete: the bug fix is in place.`
- `Task complete: the deployment succeeded.`
- `Task complete: I finished the requested changes, but tests could not run in this environment.`

If useful, include one line of important status such as:

- whether tests passed
- whether deployment succeeded
- whether there are blockers or follow-up items

Do not send long multi-paragraph summaries to Telegram unless the user asks for that specifically.

## Verification Commands

Use these if a future agent needs to validate the setup before sending:

Check that the bot token is valid:

```bash
env TOKEN='8733998892:AAGFLeuMbM1d7RvCfd1ahyUgQqHQHa4SVVY' \
/bin/zsh -lc 'curl -s "https://api.telegram.org/bot$TOKEN/getMe"'
```

Check whether the bot has recent updates or chats:

```bash
env TOKEN='8733998892:AAGFLeuMbM1d7RvCfd1ahyUgQqHQHa4SVVY' \
/bin/zsh -lc 'curl -s "https://api.telegram.org/bot$TOKEN/getUpdates"'
```

## Known Working Test

This message was successfully sent on `2026-04-06`:

`Test from Codex: Telegram bot messaging is working.`

It was delivered from `@ZedsCodexBot` to chat ID `6074935407`.

## Failure Handling

If sending fails, future agents should check these cases in this order:

1. Invalid token.
2. Bot has been revoked or rotated.
3. Wrong `chat_id`.
4. Morgan has not started the bot in the relevant Telegram account.
5. Telegram API is temporarily unavailable.
6. Shell quoting broke the command.

If the send fails, report the failure plainly in the main task response and include the likely reason.

## Instruction To Future Agents

When Morgan asks for Telegram notification after task completion, use the configuration in this file and send the Telegram message after the task is actually complete.

Unless Morgan asks otherwise:

- send exactly one completion message
- keep it concise
- mention the outcome, not the full implementation details
- mention failed or skipped tests if that matters

If the token in this file stops working, ask Morgan for the updated token or look for a replacement in local environment variables before giving up.
