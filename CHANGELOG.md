# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `.env.example` documenting supported environment variables.
- `.editorconfig` enforcing consistent indentation and line endings.
- `.gitattributes` enforcing LF line endings cross-platform.
- `ROADMAP.md` capturing the staged plan for upcoming work.
- README "Troubleshooting" section covering common auth and RBAC failures.
- ESLint (flat config) + Prettier with `lint`, `lint:fix`, `format`,
  `format:check` npm scripts.
- `CONTRIBUTING.md` with branching, Conventional Commits, and PR conventions.
- `.github/` issue and pull request templates.

### Changed
- `index.js` reformatted by Prettier to match the new project style (no
  behavior changes).

## [0.1.0] - 2026-04-27

### Added
- Initial MCP server with read-only tools: `list_pipelines`, `get_pipeline`,
  `query_pipeline_runs`, `query_activity_runs`, `list_triggers`.
- Interactive browser authentication via `@azure/identity`.
- MIT license and `package.json` metadata for distribution.

[Unreleased]: https://github.com/user-vik/adf-mcp-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/user-vik/adf-mcp-server/releases/tag/v0.1.0
