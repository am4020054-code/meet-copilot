# Meet Copilot

Local conversation assistant: transcript with speaker labels, early suggestion, final answer,
reading history and a separate next-step suggestion. English answers with Russian support text.
A microphone stream records your speech; shared-tab audio records the other participants.
Speaker names are assigned manually to detected voice labels.

## Run

Requires Python 3.9+ (standard library), a current desktop Chromium browser supporting tab-audio
sharing, and an AssemblyAI account with access to streaming transcription and its LLM gateway.
Provider usage, including diarization, can incur charges. Model availability depends on your account.

Preview without credentials or network calls:

```sh
python3 server.py --port 8765
```

Open http://127.0.0.1:8765. For live use, export `ASSEMBLYAI_API_KEY` in your terminal and run
`python3 server.py --gateway --port 8765`. Do not put the key into frontend files or commit it.
Alternatively use `~/.config/meet-copilot/credentials.json` containing a `key`
field: its directory must have permission 0700 and the file 0600.
The `.env.example` documents settings; the server does not automatically load `.env` files.

## Your context

Put selected UTF-8 `.md` or `.txt` files directly in a private folder and set
`MEET_COPILOT_CONTEXT` to that folder. Default: `~/.config/meet-copilot/context`.
No documents, agreed answers or company facts are bundled. Subfolders and symlinks are excluded.
The selected documents are all included in each hint request (maximum 140,000 bytes in total).
Large context can increase delay. Restart the server after changes. An empty folder is valid;
the assistant then has only the dialogue and must ask for missing facts.

Copy `config.example.json` outside the repository. Set `MEET_COPILOT_CONFIG` to its location.
It controls your instructions, two conversation goals, glossary and default diarization setting.
Keep confidential instructions and context outside version control. The model can make mistakes;
source labels are generated text and are not an independent verification of factual accuracy.

## Live call

Start the local app, select the call tab with audio sharing enabled, and grant microphone access
separately. Meet microphone settings do not control this app. Use headphones to reduce echo.
Early text is provisional and may be corrected after the complete utterance. Final answers remain
in history; navigate with Previous/Next. A displayed suggestion is not treated as spoken speech.

Audio, selected context and transcript excerpts are sent to AssemblyAI when live mode is enabled.
Local dialogue/error journals are stored at `~/.local/share/meet-copilot/sessions`, or the directory
in `MEET_COPILOT_LOG_DIR`. Journals contain conversation text: manage retention yourself.
The long-lived API key stays on the server; the browser receives a short-lived speech token.
Only localhost is supported. Do not expose this development HTTP server to a network.

## Checks

```sh
python3 -B -m unittest discover -s tests
node tests/core.mjs
node tests/ui.mjs
python3 -B audit_public.py
```

The audit reports only filenames and finding categories. Set `PUBLIC_AUDIT_FORBIDDEN` to a
comma-separated list of private terms for an additional project-specific scan.

These are offline checks. They do not establish live microphone capture, provider account access,
recognition quality, attribution accuracy or a guaranteed response time. A live rehearsal is required.

## Origin and licensing

The speculative-generation/cancellation approach and SAY / FACTS / ASK / NOTE output format were
inspired by [irisrumtub/meet-copilot](https://github.com/irisrumtub/meet-copilot).
A source comparison against upstream commit `09b8aea58b902de30de55381f3da80fc2f6a498b`
found separate implementations; no copied upstream source was identified. This package uses a
Python HTTP server, a browser-to-provider speech connection, and its own interface and audio worker;
upstream uses a Node/WebSocket server and an Anthropic backend. No upstream files are distributed here.
Upstream has no published license at that revision. This attribution does not grant rights to
upstream code. No open-source license has been selected for this package.
