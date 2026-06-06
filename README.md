# Conlab

Controlled collaboration text ledger MVP, version `2.0.0`.

Conlab stores collaborative text work as event log entries in a Git repository. Users do not edit a shared document directly. They create buckets, add content events, ask questions, record decisions, and review changes. The rendered bucket text is calculated from accepted ledger events.

## Local Install

Requirements:

- Node.js
- npm
- access to a GitHub or GitLab repository
- a repository access token for your own user

Install and start:

```bash
make run
```

Equivalent commands:

```bash
npm install
npm run dev
```

Open the local Vite URL printed by the terminal, usually:

```text
http://localhost:5173
```

## Desktop App

Conlab can also be packaged as a macOS desktop app with Tauri.

Download the current MVP desktop build from GitHub Releases:

```text
https://github.com/h4rkon/conlab/releases/tag/v2.0.0
```

Direct macOS Apple Silicon `.dmg` download:

```text
https://github.com/h4rkon/conlab/releases/download/v2.0.0/Conlab_2.0.0_macos_aarch64_icon_adhoc_signed.dmg
```

For the MVP, `.dmg` builds are ad-hoc signed but not Apple-notarized. macOS may show a Gatekeeper warning on first launch. If macOS blocks the app, right-click `Conlab.app`, choose `Open`, and confirm the launch.

Additional desktop build requirements:

- Rust, installed with `rustup`
- macOS build tools, installed with `xcode-select --install`

Install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Run the desktop app in development mode:

```bash
make desktop-dev
```

Build a local desktop bundle:

```bash
make desktop-build
```

The generated macOS artifacts are written under:

```text
src-tauri/target/release/bundle/
```

The Tauri wrapper uses the same app UI and the same GitHub/GitLab workspace connection flow as the browser version.

To publish a new desktop release:

1. Build the desktop app with `make desktop-build`.
2. Create a GitHub Release, for example `v2.0.0`.
3. Upload the generated `.dmg` as a release asset.
4. Users download the `.dmg`, open it, and drag `Conlab.app` into Applications.

## Version And Release Notes

Current MVP version: `2.0.0`.

The version is defined in:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Release-facing references are mirrored in:

- `README.md`

GitHub Release notes for the current MVP are in:

```text
releases/v2.0.0.md
```

## Connect A Workspace

On the install screen, enter:

- Git repo URL
- Access token

For EPAM GitLab evaluation, use:

```text
https://git.epam.com/victor_sauermann/conlab_test
```

Each evaluator should create and paste their own GitLab access token. The app uses the token to:

- identify the current Git user
- read the user's project role
- read or initialize `conlab.json`
- write accepted workspace changes back to Git

For GitLab, the simplest evaluation token scope is:

```text
api
```

The repository role controls the Conlab role:

| GitLab role | Conlab role |
| --- | --- |
| Owner | admin |
| Maintainer | reviewer |
| Developer | contributor |
| Reporter | read-only |
| Guest | read-only |
| Minimal access | read-only |

GitHub repositories are also supported:

| GitHub permission | Conlab role |
| --- | --- |
| admin | admin |
| maintain | reviewer |
| push/write | contributor |
| triage | read-only |
| pull/read | read-only |

The token is stored in browser local storage for the local app session. Do not commit tokens into the repository.

## How The Application Works

### Buckets

A bucket is a controlled text area with:

- name
- description
- type: content or prompt
- review mode
- status

Admins can create buckets, change bucket settings, and archive buckets. Archived buckets stay readable but no longer accept new events. When archived, the bucket is renamed:

```text
archived_<former_name>_<YYYYMMDDHHMMSS>
```

Content buckets hold source material for controlled collaboration. Prompt buckets hold reusable GenAI prompt text and are governed by the same event ledger and review settings. Existing workspaces without a bucket type are treated as content buckets.

### Review Modes

Buckets can require reviewer acceptance or auto-accept content.

Review-required bucket:

- content, revisions, deletes, and decisions are proposed
- reviewer or admin must accept/reject the proposal
- only one proposed event can be open at a time

Auto-accept bucket:

- new content and decisions are accepted immediately
- questions still open a decision workflow

### Content Events

Content events affect rendered bucket text when accepted.

Supported content actions:

- Create: add a new content block
- Revise: add a new accepted version of a previous event
- Delete: remove a previous event from the rendered text

Old event entries are never mutated. Revisions and deletes are new ledger entries.

### Questions And Decisions

A question is an event log entry that does not render into the bucket text.

A question can be:

- standalone
- related to a previous event

If related, the event log shows the earlier content as context before the question.

An open question blocks further bucket work until a decision is added.

A decision answers an open question. Decisions recapture:

- the original context, when present
- the question
- the decision text

Accepted decisions render into the bucket text.

### Rendered Text History

The rendered bucket text is calculated from accepted events only. Use the `<<` and `>>` controls to navigate backward and forward through accepted history.

### GenAI Contribution Review

For content buckets, Conlab can run a GenAI plausibility check before a contribution is posted. The check uses the user's local GenAI API key and compares the new post against the current visible rendered bucket content.

The check evaluates:

- whether the post is mainly one clear statement
- whether it overlaps with visible existing content
- whether it can be rewritten shorter and more directly

Prompt buckets skip this GenAI contribution check because prompt text is managed as governed source material.

### Narrative Generation

Conlab can generate a narrative from selected bucket content.

Use `Create narrative` to select:

- one prompt bucket
- one or more content buckets

The prompt bucket's rendered text is used as the GenAI instruction. The selected content buckets' rendered text is used as source material in the order shown in the modal. The generated narrative is displayed locally and can be copied out for external use.

### Notifications

While the app is open, it polls the connected repository for `conlab.json` changes. If another user writes a workspace update, a banner appears with a summary and a `Load latest` action.

This is an in-app notification. GitHub/GitLab email notifications depend on project/user notification settings and are not directly triggered by Conlab.

## Repository Data

Conlab stores workspace data in:

```text
conlab.json
```

If `conlab.json` does not exist, the app initializes it.

## Development Commands

```bash
make run
make build
make desktop-dev
make desktop-build
make test-e2e
```

Direct npm commands:

```bash
npm run dev
npm run build
npm run desktop:dev
npm run desktop:build
npm run lint
npm run test:e2e
```

## UI Tests

The Playwright suite runs against a temporary GitHub branch and deletes that branch during teardown.

Defaults:

- repo: `https://github.com/h4rkon/conlab`
- token: `TEST_GITHUB_TOKEN`, or ignored `.secret/pat`

Run:

```bash
npm run test:e2e
```

Optional:

```bash
TEST_GITHUB_REPO=https://github.com/owner/repo TEST_GITHUB_TOKEN=... npm run test:e2e
```

## Information Needed To Inspect A Test Repo

To access and inspect a GitLab test repository from the app or via API, the required information is:

- repository URL, for example `https://git.epam.com/victor_sauermann/conlab_test`
- a valid token for a user or project with access to that repository
- token scope, preferably `api` for the current MVP
- the expected user role in the repository, such as Owner, Maintainer, Developer, Reporter, or Guest
- whether `conlab.json` already exists or should be initialized

If access fails, the first things to verify are token scope and project membership.
