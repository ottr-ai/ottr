---
name: explain-project
description: Use to explain how a project works with Mermaid diagrams, for example "explain how this project works", "architecture diagram", or "how does X work". Reads the code and writes one Markdown file with flowchart, sequence and state diagrams that map to real source paths.
---

# Explain a project

Read a repository and write one Markdown file that explains it with Mermaid diagrams. The diagrams are text. Do not use image models. Do not add dependencies to the project. The render check in step 3 is the only network use.

## 1. Read the code

Read these items in this order:

1. The README and the docs that it links.
2. The package manifest (for example `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`).
3. The entry points: the `main`, `bin`, `scripts` or `start` targets, a `Dockerfile` `CMD`, or a `main()` function.
4. The main modules that the entry points import. Follow the imports one or two levels deep.
5. The store schema (tables, files) and the processes that the code starts, if the project has them.

Do not guess. Every box and every arrow must map to a real file, module, table, or process. If you cannot find the source of a link, do not draw it.

If the caller asks "how does X work", start at X and read only the code that X uses.

## 2. Write the file

Write `docs/how-it-works.md`, or the path that the caller gives. Use this shape:

1. `# How <project> works` and a short overview paragraph: what the project does, for whom, and how it runs.
2. `## Architecture`: a Mermaid `flowchart` with the main components and their links.
3. `## <main use case>`: one Mermaid `sequenceDiagram` that shows the data flow of the main use case.
4. `## Life cycle`: a Mermaid `stateDiagram-v2`. Add it only when the project has a clear life cycle, for example the stages of a task or an order. Use the state names from the code.
5. Under each diagram, a list that maps each node, participant, or state to its source path, for example `- **Store** — src/store.ts`.

Rules for the diagrams:

- Write the labels in the language of the project docs.
- Use 15 nodes or fewer in each diagram. Count the participants in a `sequenceDiagram` and the states without `[*]` in a `stateDiagram-v2`. If a diagram needs more, split it into two diagrams.
- Make the Mermaid valid for GitHub:
  - Use simple node ids (`store`, `apiServer`), and put the label in quotes: `store["Store (SQLite)"]`.
  - Do not use a Mermaid keyword as an id or a state name: `end`, `loop`, `alt`, `else`, `opt`, `par`, `and`, `critical`, `break`, `rect`, `note`, `state`, `class`, `subgraph`.
  - Put a label with `(`, `)`, `:`, `/` or `#` in quotes.
  - Use only `flowchart`, `sequenceDiagram`, and `stateDiagram-v2`.
  - Do not use `%%{init}%%` blocks, `click` lines, or HTML in the labels.
- Label each arrow with a verb or the data that moves, for example `-->|"HTTP /api/tasks"|`.

## 3. Check each diagram

Render each diagram once to prove that it parses. Write the scratch files to the OS temp dir, never to the repository.

```sh
tmp=$(mktemp -d)
awk -v d="$tmp" '/^```mermaid/{n++;f=d"/"n".mmd";next} /^```/{f="";next} f{print > f}' docs/how-it-works.md
echo '{"args":["--no-sandbox"]}' > "$tmp/cfg.json"
for f in "$tmp"/*.mmd; do npx -y @mermaid-js/mermaid-cli@12.0.0 -p "$tmp/cfg.json" -i "$f" -o "${f%.mmd}.svg" || echo "FAIL $f"; done
```

- If a diagram fails, fix the Mermaid and render it again.
- `--no-sandbox` lets Chrome start as root or in a container. The scratch input is your own file, so this is safe.
- On the first run, `npx` downloads Chrome into `~/.cache/puppeteer`. Say so in the report.
- If no renderer runs (no network, no Chrome libraries), say so in the report. Do not install system packages without the approval of the user.
- To give the caller pictures, render PNG files too: `-o "${f%.mmd}.png" -b white -s 2`.

## 4. Report

Give the path of the file, the diagrams that it holds, and the result of the render check. Name each part of the project that you did not read, so the reader knows the limits of the diagrams.
