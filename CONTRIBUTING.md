# Contributing to LiteDB

Thank you for your interest in contributing to LiteDB! This document outlines how to get started and what we expect from contributions.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [PostgreSQL](https://www.postgresql.org/download/) (optional, required only for PostgreSQL-related features)

### Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/createdbyadham/LiteDB.git
   cd LiteDB
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the development server:

   ```bash
   npm run tauri dev
   ```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (frontend only) |
| `npm run tauri dev` | Start full Tauri desktop app in dev mode |
| `npm run build` | Build the frontend |
| `npm run tauri build` | Build production desktop app |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type checking |

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** — keep PRs focused and reasonably sized.

3. **Verify locally** before opening a PR:

   ```bash
   npm run lint
   npm run typecheck
   npm run build
   ```

4. **Push** your branch and open a Pull Request against `main`.

5. **CI must pass** — all GitHub Actions checks must be green before a PR can be merged. Fix any failures before requesting review.

6. A maintainer will review your PR. Address feedback promptly.

## Conventional Commits

Going forward, all new commits should follow the [Conventional Commits](https://www.conventionalcommits.org/) specification. Existing commit history will not be rewritten, but new work should use these prefixes:

| Prefix | Use for |
|--------|---------|
| `feat:` | New features |
| `fix:` | Bug fixes |
| `docs:` | Documentation changes |
| `chore:` | Maintenance, tooling, dependencies |
| `ci:` | CI/CD configuration |
| `refactor:` | Code changes that neither fix bugs nor add features |
| `test:` | Adding or updating tests |
| `perf:` | Performance improvements |

### Examples

```
feat: add CSV export for query results
fix: resolve PostgreSQL connection timeout on SSL
docs: update vector search setup instructions
chore: bump @tauri-apps/api to 2.10.1
ci: add typecheck step to release workflow
refactor: extract schema introspection into shared module
test: add unit tests for text-to-SQL prompt builder
perf: cache embedding model after first load
```

## Questions?

Open a [GitHub Discussion](https://github.com/createdbyadham/LiteDB/discussions) or file an issue if you're unsure about anything before starting work.
