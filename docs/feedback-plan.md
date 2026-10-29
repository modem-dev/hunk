# Feedback plan

## Status

Implemented for `hunk feedback` and for Help → Send feedback in the review app. The log, status,
and document surfaces do not have the Help entry yet. The Modem channel token is still empty,
so every send reports "unavailable" without making a request until the channel exists.

Where the build differs from the first draft of this plan:

- The confirmation prompt finds the terminal behind stdout or stderr, the way `hunk pager`
  already does, rather than opening `/dev/tty` or `CONIN$` by name. On Windows no such device is
  found, so a piped message there needs `--skip-confirm`.
- Argument conflicts, such as a message given two ways, exit 1 like every other parse error.
  Exit 2 is kept for a validation error, a refused run, and `[feedback] enabled = false`.
- Hunk's themes have no warning color, so the disclosure renders in full-contrast text with an
  accent ⚠ marker instead.

## Goal

Let people send feedback to the Hunk team from inside Hunk: from a form in the TUI, and from a
`hunk feedback` command. Submissions go to Modem's
[in-app feedback](https://docs.modem.dev/integrations/in-app-feedback) endpoint, so they land in
Modem next to the rest of Hunk's user signal (GitHub issues, Discord, and so on).

The feature has to be transparent above all. Before anything is sent, the person sees what will be
sent and where it goes, and agrees to it. Hunk makes no request to Modem until that point.

## Non-goals

- Telemetry, crash reporting, or usage analytics of any kind.
- Attaching screenshots, diffs, file names, repository paths, config, logs, or session state.
- Exposing feedback through `hunk session *`, the broker, or the agent skill. Agents can still run
  the CLI command (see [Agents](#agents)), but this feature adds no session-wire surface and needs
  no `HUNK_SESSION_DAEMON_VERSION` bump.
- Replies, threads, or reading anything back from Modem. A feedback token can only write.
- Replacing GitHub issues. Bug reports that need a reproduction still belong there, and the form
  says so.

## Privacy contract

These rules are the feature. Every other part of the design serves them, and tests enforce each
one.

1. **No request to Modem before consent.** Opening the form, typing, cancelling, `--dry-run`, a
   refused non-interactive run, and a validation error never touch the network: no DNS lookup, no
   preflight, no token check, no warm-up. The first request to `ingest.modem.dev` is the send that
   follows an explicit confirmation of that exact submission.
2. **One consent per submission.** Agreeing once does not authorize later sends. There is no
   "always send" setting. The only bypass is `--skip-confirm` on the CLI, typed by the person (or
   their agent) for that one command.
3. **A fixed, disclosed payload.** The request carries the fields in [Payload](#payload) and
   nothing else. The disclosure text is generated from the same field list that builds the
   payload, so the two cannot drift.
4. **No hidden identifiers.** Hunk sends no install ID, machine ID, username, hostname, email (unless
   the person types one), repository data, or environment variables. It overrides Bun's default
   `User-Agent` so the runtime version does not ride along unannounced.
5. **Honesty about the network.** Like any web request, the server sees the person's IP address.
   The disclosure says so instead of claiming the request is anonymous. Modem's ingest uses it as
   the key for the per-IP rate limit (`CF-Connecting-IP` in `apps/ingest/src/routes/feedback.ts`)
   and does not store it on the submission.

### Disclosure text

Both surfaces render the same text, built by one helper (`describeFeedbackDisclosure` in
`core/feedback/payload.ts`) from the payload's field list:

> This sends your message to the team that makes Hunk. Hunk is built by Modem (modem.dev), and your
> feedback goes to Modem's servers, where the team reads it and follows up.
>
> Along with your message, Hunk sends your Hunk version (0.24.1), so the team knows which build you
> are using; your operating system (macOS), since some problems only happen on one platform; a label
> saying the message came from Hunk's terminal app; and a random ID made just for this message, so
> that if Hunk has to retry the send, it is not counted twice.
>
> The random ID is not tied to you or your machine. Hunk sends nothing else: no file names, code,
> diffs, repository paths, configuration, or account details.
>
> As with any web request, Modem's servers can see your IP address. It is used only for rate
> limiting and is not stored with your feedback.
>
> Nothing is sent until you confirm.

The text names Modem's domain, `modem.dev`, rather than the ingest host the request goes to;
`send.test.ts` checks that the request host is inside that domain. If the person enters an email
address, the second paragraph gains "and the email address you entered, so the team can reply to
you". The version and OS in the text are the actual values that will be sent. With
`--skip-confirm`, the last line instead says the send is happening without asking, because
--skip-confirm was passed.

Every payload field maps to a phrase: `release` and `tags.os` to the version and OS, `source`,
`tags.category`, and `tags.surface` (constant labels) to "a label saying the message came from
Hunk's terminal app", `submission_id` to the random ID, and `email` to the email clause. The field-set
test fails if a field has no phrase.

## Payload

One `POST https://ingest.modem.dev/feedback` with `Content-Type: application/json`, authenticated
with Hunk's feedback-channel token. This uses the documented
[feedback endpoint](https://docs.modem.dev/api/feedback/endpoint) as is. Modem needs no changes;
`source: "tui"` is already one of the accepted sources.

```json
{
  "submission_id": "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "message": "The split view loses my place when I resize the terminal.",
  "source": "tui",
  "release": "0.24.1",
  "tags": {
    "category": "user_feedback",
    "os": "darwin",
    "surface": "tui"
  },
  "email": "ada@example.com"
}
```

| Field           | Value                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| `submission_id` | A UUIDv7 from `Bun.randomUUIDv7()`, generated once per draft and reused on retries.   |
| `message`       | The person's text, trimmed, 1 to 4,096 characters.                                    |
| `source`        | Always `"tui"`, the endpoint's source for terminal clients.                           |
| `release`       | `resolveCliVersion()` from `core/run/version.ts`.                                     |
| `tags.category` | Always `"user_feedback"`.                                                             |
| `tags.os`       | `process.platform`, such as `darwin`, `linux`, or `win32`. No OS release or kernel.   |
| `tags.surface`  | `"tui"` for the form, `"cli"` for `hunk feedback`.                                    |
| `email`         | Sent only when the person typed one. Modem records it as a claimed, unverified email. |

Not sent: `name`, `url`, `context`, `environment`, `trace_id`, `author`, screenshots, CPU
architecture, install source, terminal, shell, or locale. Adding any field later means updating
the disclosed-field list, which changes the disclosure text and breaks the field-set test on
purpose.

Request headers: `Authorization: Bearer feedback_…`, `Content-Type: application/json`, and
`User-Agent: hunk`. There is no `Origin` header, so the channel's allowed-origin check always passes.

## CLI: `hunk feedback`

```text
hunk feedback [message...]       send feedback to the Hunk team at Modem
  -m, --message <text>           message text (alternative to the positional argument)
  -F, --file <path|->            read the message from a file, or stdin with -
      --email <address>          optional reply address, sent only if given
      --dry-run                  print exactly what would be sent, then exit without sending
      --skip-confirm             send without the confirmation prompt
      --json                     print the result as JSON
```

### Flow

1. **Collect the message.** Use the positional words, `--message`, or `--file`; passing more than
   one is a usage error (exit 1). With none of them and an interactive terminal, open the
   standalone feedback form (the TUI below). With none of them and no terminal, exit 2.
   `--dry-run` with no message also exits 2 ("--dry-run needs a message") instead of opening the
   form, since the form's only exit besides cancel is a real send.
2. **Validate locally.** Apply Modem's limits (message 1 to 4,096 characters after trimming, email
   up to 320) before any prompt, so a bad message fails without a request.
3. **Preview.** Print the disclosure text, then the exact JSON body that will be sent (the token
   is a header, not part of the body):

   ```text
   This sends your message to the team that makes Hunk. Hunk is built by Modem (modem.dev), and your
   feedback goes to Modem's servers, where the team reads it and follows up.

   Along with your message, Hunk sends your Hunk version (0.24.1), so the team knows which build you
   are using; your operating system (macOS), since some problems only happen on one platform; a label
   saying the message came from Hunk's terminal app; and a random ID made just for this message, so
   that if Hunk has to retry the send, it is not counted twice.

   The random ID is not tied to you or your machine. Hunk sends nothing else: no file names, code,
   diffs, repository paths, configuration, or account details.

   As with any web request, Modem's servers can see your IP address. It is used only for rate
   limiting and is not stored with your feedback.

   Nothing is sent until you confirm.

   Request body:
   {
     "submission_id": "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
     "message": "The split view loses my place when I resize the terminal.",
     "source": "tui",
     "release": "0.24.1",
     "tags": { "category": "user_feedback", "os": "darwin", "surface": "cli" }
   }

   Send this feedback? [y/N]
   ```

4. **Confirm.** The default is No. Anything other than `y` or `yes` cancels, prints "Not sent.",
   and exits 0. `--dry-run` stops after the preview, also exits 0, and says "Dry run: nothing was
   sent."
5. **Confirm on the terminal, or refuse.** The prompt reads its answer from the controlling
   terminal, not from stdin: the device behind stdout or stderr, as `hunk pager` uses. A piped message
   (`git log -1 --format=%B | hunk feedback --file -`) can therefore still be confirmed by the
   person at the keyboard, and stdin is never read as the answer. Only when no controlling
   terminal can be opened (cron, CI, a detached agent) and `--skip-confirm` is absent does the
   command exit 2 without sending: "hunk feedback needs confirmation. Re-run in a terminal, or pass
   --skip-confirm to send without one." A script or agent never sends by accident.
6. **Send** (see [Send behavior](#send-behavior)), then print "Sent. Thanks! Reference: <id>",
   using the `id` from the `202` response. With `--json`:
   `{ "sent": true, "id": "…", "submission_id": "…" }`, or `{ "sent": false, "reason": "cancelled" }`.

`--skip-confirm` skips only the `[y/N]` prompt. The preview still prints to stderr, so a log shows
what was sent.

### Exit codes

`0` sent, cancelled, or dry run. `1` send failed or unconfirmed (network, timeout, `4xx`, or `5xx`
after retries), or an argument conflict. `2` validation error, a refused unattended send, or
feedback turned off by config.

### Agents

The generated `hunk-review` skill gets one line: agents may run `hunk feedback` only after the
person has asked for it or agreed to the exact message, and should show them the `--dry-run`
output first. `--skip-confirm` exists for exactly that case. The agent has already asked, and the
person is not typing into the agent's terminal. This mirrors the consent rule in Modem's own
feedback MCP tool. Edit `packages/hunk/src/hunk-review/skillDocument.ts`, then run
`bun run generate:skill`.

## TUI: the feedback form

### Entry points

- **Help → Send feedback…** in every routed surface that has a Help menu: review (`appMenus.ts`),
  log, status, and documents.
- A new command, `hunk.app.openFeedback`, in `appCommands.ts`. It has no default key; people can
  bind one through `[keybindings]`. It is listed in the controls help.
- `hunk feedback` with no message in an interactive terminal (above) opens the same form on its own
  and exits when it closes.

### Layout

A modal built on `ModalFrame`, sized with `resolveModalGeometry`:

```text
┌ Send feedback to the Hunk team ─────────────────────────────┐
│ ⚠ This sends your message to the team that makes Hunk.      │
│   Hunk is built by Modem (modem.dev), and your feedback     │
│   goes to Modem's servers, where the team reads it and …    │
│   (the rest of the disclosure text above, never shortened)  │
│                                                             │
│ Message                                                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ The split view loses my place when I resize the█        │ │
│ │                                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Email (optional, only if you want a reply)                  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ └─────────────────────────────────────────────────────────┘ │
│ Bug with repro steps? github.com/modem-dev/hunk/issues      │
│                                                             │
│ ctrl+s send to Modem   tab next field   esc cancel          │
└─────────────────────────────────────────────────────────────┘
```

- The disclosure sits at the top in full-contrast text behind an accent ⚠ marker, above the input, and stays visible
  while typing. It is never collapsed, never shown only once, and never moved behind a "details"
  toggle. It is the full `describeFeedbackDisclosure` text, not a shortened version.
- The modal grows to 96 columns on wide terminals so the disclosure takes fewer rows. On a short
  terminal the form gives up space in a fixed order (`planFeedbackDialogRows`): message rows down
  to two, then the blank rows between disclosure paragraphs, then the GitHub-issues hint. The
  disclosure's words are never cut.
- The message box is an OpenTUI `<textarea>`, wired for focus the way `AgentInlineNote` does it.
  The email box is a one-line input.
- The footer is `DialogActionRow`, so every action is also clickable (mouse and keyboard parity).
  The send action reads "send to Modem", not just "send".
- The send action is disabled until the message has text. A character counter appears near the
  4,096 limit.

### Consent in the TUI

The form is the confirmation step: the disclosure is on screen right above the input, and the send
action names the destination. There is no second "are you sure?" dialog. It would repeat the text
the person just read, and a reflexive second `enter` is weaker consent than one deliberate,
labelled action.

### States

`editing → sending → sent | failed | unconfirmed`, held in a pure reducer in
`ui/lib/feedbackForm.ts`, which also holds the `submission_id`.

- **editing**: global shortcuts are suppressed while the modal has focus, through the existing
  modal routing in `useAppKeyboardShortcuts`. `esc` closes the form and discards the draft. With a
  non-empty draft, it first asks "Discard feedback?" through `ConfirmDialog`.
- **sending**: inputs lock and a spinner shows "Sending to Modem…". `esc` stops waiting for the
  response. The request may already be out, so this moves to **unconfirmed**, never back to
  editing as though nothing happened.
- **sent**: "Sent. Thanks!" plus the reference `id`. The form closes after two seconds or on any
  key.
- **failed**: the draft stays, the status-specific message from
  [Send behavior](#send-behavior) shows, and `ctrl+s` retries with the same `submission_id`.
  Editing the draft generates a new `submission_id`, matching Modem's idempotency rule.
- **unconfirmed**: after `esc` during sending, a timeout, or a network error, Hunk cannot know
  whether Modem recorded the submission. The form says so: "Hunk couldn't confirm that Modem
  received this. It may have arrived. Sending again won't create a duplicate." `ctrl+s` retries
  with the same `submission_id`, so Modem dedupes it. `esc` asks "Close? This feedback may already
  have been sent." instead of "Discard feedback?", and closing never sends anything.

The draft lives only in memory. It is never written to disk, `.hunk/`, or the app state file.

## Send behavior

`core/feedback/send.ts` holds the only reference to the endpoint URL and the token, and exports one
function:

```ts
sendFeedback(payload: FeedbackPayload, deps?: { fetchImpl?: FetchImpl; timeoutMs?: number; signal?: AbortSignal })
  : Promise<FeedbackSendResult>
```

- Timeout: 10 seconds per attempt, using the `AbortController` pattern from
  `core/install/latestRelease.ts`.
- Retries: one automatic retry, with the same `submission_id`, on a connection failure or a `5xx`.
  On `409`, wait for `Retry-After` (one second) and retry up to twice. Never retry other `4xx`
  responses automatically.
- Errors are mapped to plain messages:

| Response            | Message                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `202`               | Sent.                                                                                                        |
| network / timeout   | Hunk couldn't confirm that Modem received this. It may have arrived. Sending again won't create a duplicate. |
| `400`               | Modem rejected the message: <first `details` entry>. (Indicates a Hunk bug.)                                 |
| `401`               | Feedback is unavailable in this version of Hunk. Please open a GitHub issue instead.                         |
| `413` / `415`       | Treated as `400`; the payload carries no attachments, so these indicate a Hunk bug.                          |
| `429`               | Too much feedback right now. Try again in a minute.                                                          |
| `5xx` (after retry) | Modem couldn't record the feedback. Try again later.                                                         |

Network errors, timeouts, and aborts return an `unconfirmed` result rather than `failed`, because
the request may have reached Modem before the connection dropped. The CLI prints the same message,
exits 1, and reports `{ "sent": false, "reason": "unconfirmed", "submission_id": "…" }` with `--json`.

The `401` message also links `https://github.com/modem-dev/hunk/issues`, so a revoked token still
leaves people somewhere to go.

The module is loaded with a dynamic `import()` only after confirmation, so unconfirmed runs do not
even load the code that knows the endpoint.

## Opting out

`[feedback] enabled = false` in the user config (`core/run/config.ts`) hides the Help entry and the
`hunk.app.openFeedback` command, and makes `hunk feedback` exit 2 with "Feedback is disabled by
configuration." This is for managed machines and people who want the entry gone. The repo config
layer cannot turn feedback on, only off.

`DO_NOT_TRACK=1` and `HUNK_DISABLE_ANALYTICS=1` do not hide feedback. Those variables cover
background requests Hunk makes without asking, and feedback is never one of those. The
[open questions](#open-questions) revisit this.

## Modem-side setup

No Modem code changes are required.

1. In Modem's own organization, create a feedback channel named "Hunk" under **Settings →
   Integrations → In-app feedback**, with no allowed origins (CLI requests carry no `Origin`).
2. Commit the token as a constant in `core/feedback/send.ts`. Modem documents feedback tokens as
   safe to ship in published binaries: they can only submit to their channel and cannot read
   anything.
3. Optionally, post feedback to the team's Slack with a **scheduled daily digest** automation
   scoped to the Hunk channel, not a per-submission trigger. The token ships in every binary, so
   anyone can script junk into the channel. Rate limits cap volume at 60 a minute, not intent, and
   a digest turns a flood into one message instead of thousands. The channel's switch stops intake
   at once if abuse persists, and rotation follows as described below.

Capacity: the token allows 60 submissions a minute across every Hunk install, and each IP allows 20
a minute. That is plenty for feedback. A flood would show up as `429`s, not as lost data.

Rotation: rotating the token keeps the old one working for 24 hours, after which older Hunk binaries
get `401` and show the GitHub-issues fallback. Rotate only for abuse, and ship the new token in a
patch release first.

## Module layout

| Path (under `packages/hunk/src/`)                                                   | Role                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/feedback/payload.ts`                                                          | Pure. Validates input, builds `FeedbackPayload`, owns `FEEDBACK_DISCLOSED_FIELDS` and the display-only `FEEDBACK_DESTINATION_DOMAIN`, and renders the disclosure and preview text. No I/O. |
| `core/feedback/send.ts`                                                             | The only module with the endpoint and token. `sendFeedback` with injectable `fetchImpl`.                                                                                                   |
| `core/feedback/runFeedbackCommand.ts`                                               | The headless CLI flow: collect, validate, preview, confirm, send, print.                                                                                                                   |
| `core/run/commandInputs.ts`                                                         | `FeedbackCommandInput`.                                                                                                                                                                    |
| `core/run/cliCommandNames.ts`                                                       | Reserve `feedback`.                                                                                                                                                                        |
| `app/cli.ts`, `app/startup.ts`, `main.tsx`                                          | Parse `feedback`, return a headless plan, and lazy-load `runFeedbackCommand`, as `update` does.                                                                                            |
| `ui/lib/feedbackForm.ts`                                                            | The form's pure state reducer.                                                                                                                                                             |
| `ui/components/chrome/FeedbackDialog.tsx`                                           | The modal.                                                                                                                                                                                 |
| `ui/lib/appCommands.ts`, `ui/lib/appMenus.ts`, plus log, status, and document menus | `hunk.app.openFeedback` and the Help entries.                                                                                                                                              |

`AppHost` and the other routed hosts receive `sendFeedback` as an injectable dependency, so UI tests
never reach the real endpoint.

Reserving `feedback` as a built-in name breaks any user extension that already registers a
`feedback` top-level command. Search the known extensions before landing, and mention it in the
Changeset if one exists.

## Tests

The privacy contract gets its own tests. They are the main deliverable alongside the feature.

- **Field set** (`payload.test.ts`): the built payload's keys equal `FEEDBACK_DISCLOSED_FIELDS`
  exactly, for both the with-email and without-email cases. The disclosure text mentions every
  disclosed field and the actual version and OS values.
- **No network before consent** (`runFeedbackCommand.test.ts`): with a spy `fetchImpl`, assert zero
  calls for cancel, `--dry-run` (with and without a message), a non-TTY run without
  `--skip-confirm`, validation failures, and `[feedback] enabled = false`. Assert exactly one
  call, with the exact body, after `y`.
- **No network in the TUI before send** (`AppHost.feedback.test.tsx`): open the form, type, tab,
  cancel, and reopen with a spy `sendFeedback`. Assert zero calls. Then send and assert one call with
  `surface: "tui"`.
- **Endpoint containment** (`scripts/quality/source-boundaries.test.ts`): the request URL
  (`https://ingest.modem.dev`) and the `feedback_` token prefix appear only in
  `core/feedback/send.ts`, and so does the bare `ingest.modem.dev` host. The disclosure names only
  the domain, `FEEDBACK_DESTINATION_DOMAIN` (`modem.dev`) in `core/feedback/payload.ts`.
  `send.test.ts` asserts that the request host is inside that domain, so the disclosed destination
  cannot drift from the real one.
- **Send behavior** (`send.test.ts`): status mapping, retry with the same `submission_id`, `409`
  backoff, no retry on other `4xx`, timeout and abort returning `unconfirmed`, and
  `User-Agent: hunk`.
- **Confirmation source** (`runFeedbackCommand.test.ts`): with an injected terminal reader, a piped
  message prompts on the terminal and sends only on `y`. Stdin content that looks like `y` is never
  taken as the answer. A missing terminal refuses with exit 2.
- **CLI contract** (`test/cli/feedback.test.ts`): `--dry-run` output, `--dry-run` without a message
  exiting 2 without opening the form, exit codes, refusal without a TTY, and conflicting message
  sources.
- **PTY** (`test/pty/feedback-integration.test.ts`): open the form from the Help menu with the mouse
  and from a bound key, check that the disclosure renders, type, `esc` asks to discard, and confirm
  that the review stream's shortcuts do not fire while the form has focus. Pipe a message into
  `hunk feedback --file -` and answer `n` on the PTY to cover the `/dev/tty` prompt. PTY runs
  never send.

## Docs and release

- `website/src/content/docs/docs/help/feedback.md` (hunk.dev/docs/help/feedback): a user-facing
  page with what is sent, where it goes, the CLI reference, the opt-out, why `DO_NOT_TRACK` does
  not hide a feature that never sends without asking, and that an interrupted send may still have
  arrived. The generated CLI and config references link to it.
- A `minor` Changeset: "Add `hunk feedback` and a Help → Send feedback form that sends a message to
  the Hunk team after you confirm it."

## Open questions

1. **Direct endpoint or a `hunk.dev` relay?** This plan calls `ingest.modem.dev` directly, the
   documented path with no extra service. A relay on the existing `hunk.dev` release-proxy Worker
   would keep the token out of the binary and allow rotation without breaking old installs. But it
   adds a service to run, and Modem would rate-limit the relay's IP instead of each client's. The
   recommendation is direct for v1.
2. **Should `DO_NOT_TRACK` hide feedback?** The plan says no, because feedback is never sent without
   asking. Some people may still expect `DO_NOT_TRACK` to remove every Modem-bound code path.
3. **Should the email field exist at all?** It is optional and disclosed, but dropping it would make
   "no identifying information" true without qualification. The alternative is to point people
   who want a reply to GitHub issues.
4. **Is `--skip-confirm` the right name?** `--yes`/`-y` is the more common convention. This plan
   keeps `--skip-confirm` because it says exactly what it does.
