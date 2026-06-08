# Agent Notes For Adaptivio CMS

This file gives future coding agents the project context needed to continue work quickly and safely.

## Product Context

Adaptivio CMS is a small static GitHub-based CMS. It is intended to run publicly on GitHub Pages while connecting to a private GitHub repository with the current user's GitHub token.

GitHub is the source of truth for content, branches, pull requests, checks, workflow runs, and merge governance. The app should not introduce a custom backend, database, or server-side secret.

The living product brief is `PROJECT_BRIEF.md`. Update it whenever product behavior, security assumptions, workflows, or major implementation decisions change.

## Current Architecture

- `index.html`: static application shell.
- `assets/styles.css`: all UI styling.
- `src/app.js`: application state, rendering, event handling, and workflow orchestration.
- `src/github.js`: GitHub REST API client.
- `src/storage.js`: token/config storage helpers.
- `src/utils.js`: encoding, file classification, formatting, and preview helpers.
- `PROJECT_BRIEF.md`: living requirements and decision log.
- `SECURITY.md`: token, rendering, and branch-safety model.

There is no build step and no package manager dependency at the moment. Keep the code dependency-light unless a new dependency clearly reduces security or maintenance risk.

## Local Run

Use:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

If a local server is already running for the user, do not stop or restart it unless the user explicitly asks. The user may be watching changes live.

## Product Rules To Preserve

- Default mode is read-only browsing and preview.
- Pressing `Edit` creates a working branch only when the current branch is the default branch.
- When the user is already on a working branch, `Edit` must keep using that branch.
- Creating another working branch should require an explicit user action.
- Editing is limited to `.md` and `.mdx` files.
- Non-Markdown files are browse/preview only.
- Commit is explicit; do not auto-commit on every keystroke.
- After a commit, refresh branch data, check runs, workflow runs, annotations, changed files, and generated previews.
- Merge remains in GitHub through pull requests and branch protection.

## Preview And Rendering Rules

- Markdown in browse mode should render as formatted HTML.
- Front matter should be supported and collapsed by default.
- Internal Markdown links should open matching repository files inside the CMS, not navigate the browser frame to a 404.
- HTML previews must stay sandboxed and must not be injected directly into the app DOM.
- SVG files should render as previews.
- Relative SVG/image/CSS references inside HTML previews should be resolved from the current branch when possible.
- PDF and generated HTML should be inspectable from the branch after automation commits.

## UI Rules

- Give the tree and preview/detail region most of the available space.
- Keep the top toolbar compact: repository label, branch selector, mode/status, edit/new branch/PR/refresh actions.
- Avoid redundant breadcrumbs over the tree.
- Preserve tree scroll position across renders.
- Preserve filter input focus and caret while filtering.
- The app viewport should not scroll on desktop; tree and preview panes should scroll internally.
- Error and toast messages must be dismissible.

## Security Rules

- Tokens stay in the browser and are sent only to GitHub API endpoints.
- Default token storage should be session-only.
- Persistent token storage must remain an explicit user choice.
- Direct commits to the default branch should remain disabled by default.
- Escape repository content unless it is intentionally rendered in a sandbox.
- Review any Markdown/HTML rendering dependency for XSS behavior before introducing it.

Recommended fine-grained GitHub token permissions:

- Metadata: read
- Contents: read/write
- Pull requests: read/write
- Actions: read
- Checks: read

Optional:

- Actions: write, only if workflow reruns are added.

## Verification

At minimum after JavaScript edits, run:

```sh
node --check src/app.js
node --check src/github.js
node --check src/storage.js
node --check src/utils.js
```

After meaningful UI changes, open the local app in the browser and check for console errors. If possible, verify desktop layout behavior because the app shell is expected to fill the viewport without body scrolling.

After every `assets/styles.css` or `src/*.js` change, perform a cache-bust so the browser does not keep serving stale static assets while verifying the update.

## Documentation Habit

When implementing a meaningful feature or behavior change:

- Update `PROJECT_BRIEF.md`.
- Add a decision log entry when the change affects workflow, security, or product direction.
- Keep `README.md` aligned when user-facing setup or capabilities change.
- Keep `SECURITY.md` aligned when token, rendering, branch, or dependency assumptions change.
