# conlab

Controlled collaboration platform prototype.

## Current MVP Slice

This first slice models buckets as the texts being created. Contributors do not edit a shared document directly. They record proposed content events inside a bucket, add a comment explaining the change, then accept or reject the active proposal before another content proposal can be added.

Events can create a new content block or revise a previous event. Revisions never mutate the old event; they add a new history entry that can be accepted into the rendered bucket text.

Implemented:

- create a bucket with name and description
- see all buckets
- open a bucket workspace
- propose one content event at a time with an explanatory comment
- select a previous event and propose a revision with a new comment
- accept or reject proposed content
- view rendered bucket text with the accepted events that produced it
- view the bucket event log with content changes and comments

## Run

```bash
npm install
npm run dev
```
