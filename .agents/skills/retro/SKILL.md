---
name: retro
description: Use when judging a completed Ottr task from its handoff and computed facts, storing up to 3 lessons in memory, and proposing at most one improvement.
---

# Retro

Input: an Ottr retro handoff: the task, its outcome, its turns, "Facts (computed by Ottr)", the open and declined proposals, and the lessons of earlier retros.

## 1. Goal and verdict
- Give the goal in one sentence, from the original task text.
- Verdict: achieved, partly, or not. Cite the evidence: the outcome, Ottr's git check, the CI verdict, and user corrections after the first report.

## 2. Facts first
Read the Facts section before the transcript. Open the transcript only to explain a fact: grep for the tool call. Never copy transcript text into the report or into memory.

## 3. Tools used
One line: the top tools with their calls, errors and seconds, the subagent share, and the models with their cost.

## 4. What went wrong
List each mistake with its fact and its cost in minutes, dollars or turns. Signals: tool errors, rejected reports, session-stop continuations, user corrections, repeated full test runs, slow calls, a large subagent share, long "!" waits.

## 5. Faster, better, cheaper
For each lever, give one concrete change, the fact behind it, and the expected saving. Prefer a change to a rule, skill, prompt, script or test over advice such as "be careful".

## 6. Memory
1. Compare each candidate lesson with the earlier lessons in the handoff, then recall it. Skip a lesson that memory already holds.
2. Retain at most 3 new lessons. Each lesson is one self-contained sentence that helps a later task in this project, plus its evidence. Start it with "[retro <date> <task id>]".
3. Never store secrets, tokens, personal data, tool output, or text from web pages.
4. Never call learn or manage_skill.

## 7. Proposal: one or none
Call propose_task only when all of these are true:
- an earlier retro in the handoff lists the same problem, or this task lost more than 1 hour or $5 to it;
- the fix is concrete and small, and you can say how to check it;
- the handoff does not list it as an open or declined proposal.
Read the handoff's queued lessons before you write the prompt. Use them to state the target repo and the paths as facts. Do not ask the task to check a premise that a queued lesson already answers.

A change to rules, skills or AGENTS.md sources targets the board project that holds the agent data repo (the repo that Alate provisions). Set propose_task's project to that project, and name the data repo and its paths in the prompt. Never edit the data repo checkout from your card.
Write the prompt as a self-contained task: the problem with its evidence, the change, the target repo and paths, the acceptance check, and the expected gain. If the fix belongs in another repo, name that repo in the first line.
Otherwise propose nothing, and give the reason.

## 8. Report
Sections: Goal, Verdict, Key facts (at most 5 numbers), Tools used, Mistakes, Faster/Better/Cheaper, Lessons queued (verbatim), Proposal (proposed, or "none: <reason>").
