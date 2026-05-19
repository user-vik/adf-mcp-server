# Contributing to adf-mcp-server

Thanks for your interest. This guide covers the conventions for filing issues,
opening PRs, and making changes to the code.

## Local setup

```sh
git clone https://github.com/user-vik/adf-mcp-server
cd adf-mcp-server
npm install
```

You'll need Node.js ≥ 20 and an Azure account with at least `Reader` RBAC on
the Data Factory you intend to test against. See the [README](README.md) for
details on wiring the server into an MCP client.

## Before you push

Run these locally; CI will reject PRs that fail either:

```sh
npm run lint          # ESLint
npm run format:check  # Prettier
```

To auto-fix:

```sh
npm run lint:fix
npm run format
```

The repo includes an `.editorconfig` so most editors will match the project
style automatically.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). Use the
narrowest type that fits and write the subject in the imperative mood:

| Type       | When to use                                              |
| ---------- | -------------------------------------------------------- |
| `feat`     | A new tool, capability, or user-visible behavior.        |
| `fix`      | A bug fix.                                               |
| `docs`     | README, CHANGELOG, ROADMAP, or in-code doc changes only. |
| `chore`    | Tooling, dependencies, build/release plumbing.           |
| `refactor` | Internal reshuffle, no behavior change.                  |
| `test`     | Adding or updating tests.                                |
| `perf`     | A change motivated by performance.                       |

Examples:

```
feat: add device-code auth mode
fix: handle 429 throttling with Retry-After backoff
docs: clarify RBAC requirements for write tools
chore: bump @azure/identity to 4.6.0
```

For breaking changes, append `!` to the type (e.g. `feat!:`) and explain the
break in the commit body.

## Branching

- Branch off `main`.
- Use a short, hyphenated branch name: `feat/device-code-auth`,
  `fix/throttle-backoff`, `docs/troubleshooting`.
- Keep branches focused — one logical change per PR is easier to review and
  easier to revert.

## Pull requests

- Open against `main`.
- Fill in the PR template (summary, type, testing, changelog).
- Reference the related issue (`Closes #123`) if there is one.
- Add a `## [Unreleased]` entry to `CHANGELOG.md` for any user-visible change.
- Keep diffs small. If a refactor and a feature could be separate PRs, prefer
  separate PRs.

## Manual testing

There is no automated test suite yet (it's on the [roadmap](ROADMAP.md)).
For now, validate changes by:

1. Wiring the server into your MCP client per the README.
2. Invoking the affected tool(s) against a real factory you have access to.
3. For auth changes: verify each supported `ADF_AUTH_MODE` you touched.
4. For write tools (once they land): test against a non-production factory.

Paste a brief test transcript in the PR description so reviewers can see what
you ran.

## Filing issues

- **Bug:** include OS, Node version, MCP client, the failing tool call, and
  the stderr output. The `bug.md` issue template prompts for these.
- **Feature:** describe the problem first, then the proposed shape. The
  `feature.md` template helps.

## Security

If you find a security issue (token leakage, accidental write surface, etc.),
**do not file a public issue**. Email the maintainer listed in `package.json`.
