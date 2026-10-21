---
title: "Legion: One Secretary, a Legion of Its Own"
description: "When there is a lot to do, the secretary splits the work, sends out a batch of helpers, and pulls the results together for you"
---

# Legion: One Secretary, a Legion of Its Own

When there's a lot to do, the secretary doesn't work through things one by one. It splits the work, sends out a batch of **helpers**, and pulls the results together for you. We call this capability the legion.

## When it's used

There's no switch and no setting — the secretary decides based on the job. Work that is independent and takes a while per item suits it best:

- Dozens of documents to read, each needing a summary
- A codebase to review file by file
- A pile of files to sort and organize

For small jobs, it just does the work itself.

## How many

Within one task, up to 200 helpers can be unfinished at a time. A dispatch that would go over is sent back with an explanation, and the secretary dispatches more once some have finished.

Every helper that is dispatched gets started. How many model requests run at the same moment is adjusted automatically from the API's feedback: opened up gradually while nothing is rate-limited, slowed down when it is. Extra requests wait in line and show as "Waiting for model" — nothing is stuck. There is no concurrency number to set, and nowhere to set it.

## A real test

A list of 201 files, one helper per file, each reading its file and writing a one-line description, then everything gathered into a single table. With a fast model: about 75 seconds from dispatch to wrap-up, about 2 minutes (116 seconds) for the whole round, all 201 rows handed in, and the descriptions we spot-checked were accurate. A different model or API quota will give different speeds.

## What helpers can do

- **Know what you asked for**: by default they start with what you've said in this conversation and the conclusions the secretary has already stated. The secretary can also give them only the last few turns, or none.
- **Work on this computer**: read, write, search and organize local files, run commands locally, and use the skills the secretary already has.
- **Hand in the result**: when done, they return the result to the secretary, who sums it up for you.

## What helpers can't do

Helpers do the work, but they don't decide for you:

- They can't ask you questions, ask for passwords, or contact you on their own
- They can't send email, change your calendar, or create watches
- They can't change the task's plan, and they don't touch the artifacts panel
- They don't use terminal panes — their commands run in the background on this computer
- They can't dispatch further helpers

Actions that need your approval aren't asked on the helper's side. They come up in the conversation you're looking at, following the approval mode you chose (Strict / Relaxed / Free / Approve for me). For a more cautious setup, turn on "Extra ban: helpers cannot do high-risk actions" in Settings — high-risk actions are then blocked outright instead of asked.

Helpers aren't separate conversations either: they don't appear in Recent Conversations, aren't saved as conversations of their own, don't write to long-term memory, and you can't switch into a helper's conversation. In terminal conversations connected to a remote server (SSH), dispatching helpers isn't available yet.

## What you'll see

- A line in the conversation reading "Sending N colleagues" (the app's conversation view calls helpers "colleagues"). Progress is folded into that one line; expand it to see what each helper is doing.
- Long results are saved as files, with only the key points and the location left in the conversation. There is also an overview with one line per helper: its status and where its result is.
- Stop ends all helpers at once, and the secretary won't wrap up while any helper is still working.

## About cost

Every helper sends requests to the model, so the more you dispatch, the more you use — roughly in proportion to the number of helpers. SailFish doesn't estimate cost before dispatching, and doesn't ask for confirmation because of cost. What helpers spend on the model counts toward this conversation's usage. For reference, the 201-file test above made 678 requests to the model, with about 6.47 million input tokens (about 90% served from cache) and about 110 thousand output tokens. If your model is billed by usage, keep an eye on it before starting a big batch.
