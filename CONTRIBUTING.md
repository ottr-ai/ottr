# Contributing to Ottr

Thank you for your interest in the Ottr source. This file gives the shortest path to a working setup and a pull request. The longer guides stay in their own files.

## Setup

You need [Bun](https://bun.sh) 1.4.2 or newer, git, and `omp` on `PATH`. The full requirement list is in [docs/install.md](docs/install.md#requirements).

```sh
git clone https://github.com/ottr-ai/ottr.git ottr
cd ottr
bun install
```

## Checks

Run these two commands before you open a pull request. Each one must exit 0:

```sh
bun run check
bun test --timeout=20000
```

`bun run check` runs the type check, the linter, and the project guards. `bun test --timeout=20000` runs the unit tests. The flag sets the 20 s per-test ceiling. Bun's default is 5 s, and bunfig.toml has no key that Bun honors for it. What each check does, the mutation tests, and the UI development workflow are in [docs/development.md](docs/development.md).

To try the board on your own projects, follow [Quick start](README.md#quick-start) in the README.

## Pull requests

1. Make one branch per change. Keep the diff small.
2. Run the two check commands again before you push.
3. Open the pull request. The template asks for a short summary and the test results, and no more.

A pull request that changes the UI follows [DESIGN.md](DESIGN.md), and it keeps the accessibility rules in [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Report a problem

A bug or a feature idea goes to the [issue tracker](https://github.com/ottr-ai/ottr/issues). A security problem goes only through [private vulnerability reporting](https://github.com/ottr-ai/ottr/security/advisories/new). See [SECURITY.md](SECURITY.md). This project follows its [code of conduct](CODE_OF_CONDUCT.md).
