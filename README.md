# conlab

Controlled collaboration platform prototype.

## GitHub Workspace

Run the app, then connect it to a GitHub repository from the install screen.

Required inputs:

- GitHub repository URL, such as `https://github.com/owner/repo`
- GitHub PAT with repository contents read/write access

The app stores bucket and event data in:

```text
conlab.json
```

If the file does not exist, the app initializes it in the repository.

## Current MVP Slice

This first slice models buckets as the texts being created. Contributors do not edit a shared document directly. They record proposed content events inside a bucket, add a comment explaining the change, then accept or reject the active proposal before another content proposal can be added.

Events can create a new content block, revise a previous event, or delete a previous event from the rendered bucket text. Revisions and deletes never mutate old events; they add new history entries that can be accepted or rejected. Deleting a delete event invalidates that delete, which restores the previously removed content in the rendered view.

Implemented:

- connect to a GitHub repo from the app UI
- initialize or load `conlab.json`
- create a bucket with name and description
- see all buckets
- open a bucket workspace
- propose one content event at a time with an explanatory comment
- select a previous event and propose a revision with a new comment
- select a previous event and propose a delete with a new comment
- delete a previous delete event to restore its target content
- accept or reject proposed content
- view rendered bucket text with the accepted events that produced it
- navigate the rendered bucket text backward and forward through accepted event history
- view the bucket event log with content changes and comments

## Run

```bash
npm install
npm run dev
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
