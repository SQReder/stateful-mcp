# Changelog

## [Unreleased]

### Added
- Add an I0 stdio MCP server with configuration diagnostics and a single text-only OpenAI-compatible chat request.
- Validate tool arguments and backend responses; report sanitized timeout, connection and HTTP failures without retrying.
- Add fake-backend contract tests, MCP transport checks and an opt-in live smoke command.

### Changed
- Preserve Git hooks in the planned raw-commit workflow; defer modifying-hook compatibility to I4.
