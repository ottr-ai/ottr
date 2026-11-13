# Ottr

A local kanban board that runs omp coding agents on git projects. A card gets
a worktree, an agent does the work in it, and the board checks and merges the
result.

## Language

**Deepen**:
The composer's opt-in rewrite that turns a task draft into a deeper version
against five fixed points. It never invents a requirement the draft did not
ask for.
_Avoid_: rewrite, expansion

**Prompt gate**:
The tool-free model check that reads a card's prompt before a work turn and
answers what it would build, how it would check the result, and what it would
still ask. Only a blocking question parks a card.
_Avoid_: comprehension check, quality gate

**Gate assumption**:
A gate question together with the default answer the builder would take when
the user stays silent. An assumption never parks a card; it rides to the work
turn as untrusted data.
_Avoid_: fact, auto-answer

**Blocking question**:
A gate question with no default, because only the user can decide. It is the
only kind of question that parks a card.
_Avoid_: decision question, open question

**Card title**:
The name a board card shows. It comes from the card's own session history, and
a card with no title yet shows a short cut of its prompt line.
_Avoid_: session name, task name

**Draft title**:
The first card title. The title model makes it from the prompt text before the
run starts. It names the action and the source of the content it cannot see,
and never guesses that content.
_Avoid_: generated title, auto title

**Work title**:
The card title that replaces the draft title one time. It is the run agent's
first valid rename. After it lands, later renames change nothing.
_Avoid_: agent title, rename title
