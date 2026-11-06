---
description: Write a handoff so a fresh session can take over this work
argument-hint: "[next step]"
effort: low
---
Next step: "$ARGUMENTS", or your own judgement if that is empty. Write the next step and any open questions, at most 20 lines and no code, to `remedy handoff --from -` on stdin, in one call. It adds the stage counts, in-flight items and run reports itself. Repeat the two lines it prints, then tell the owner to start a fresh session. Run nothing else.
