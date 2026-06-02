# Adaptivio CMS Project Brief

This document is the living project brief for Adaptivio CMS. It should be updated as the product, security model, repository workflow, and integration details evolve.

## Purpose

Adaptivio CMS is a lightweight, static, GitHub-based headless CMS intended to run publicly on GitHub Pages while editing content and generated artifacts in a private GitHub repository.

The CMS should support day-to-day content work without introducing a database, server-side secrets, or a custom backend. GitHub remains the source of truth for content, branches, pull requests, CI status, and merge governance.

## Current Product Direction

The first version is a specialized static web application rather than a generic CMS product. Existing open-source CMS tools such as Decap CMS and Pages CMS cover parts of the desired workflow, but the Adaptivio use case also needs visibility into GitHub Actions, post-CMS automation commits, and previews of generated outputs such as HTML pages, PDFs, and visual assets.

The product should stay small, auditable, and easy to deploy.

## Core Goals

- Run as a public static application on GitHub Pages.
- Connect to a private GitHub repository using a per-user GitHub token.
- Target `advantages-cz/avds` with `master` as the fixed default branch.
- Avoid storing secrets on a server.
- Support a branch-first editing workflow.
- Support pull request creation and review readiness checks.
- Show GitHub Actions and check-run status for the edited branch.
- Make automation-generated commits visible after a CMS edit.
- Preview relevant generated artifacts directly from the branch.
- Keep the codebase maintainable, dependency-light, and security-conscious.

## Non-Goals

- Replace GitHub as the source of truth.
- Implement a custom merge system outside GitHub.
- Store content in a database.
- Require a proprietary CMS backend.
- Render untrusted repository HTML inside the application DOM.
- Add rich editors before the basic Git workflow is reliable.

## Primary Users

- Adaptivio maintainers editing content, documentation, data, and assets.
- Reviewers who need to inspect generated outputs before merging.
- Operators who need to understand whether CI failed and what automation changed.

## Expected Workflow

1. The user opens the public CMS page.
2. The user opens the login modal and provides a GitHub token scoped to `advantages-cz/avds`.
3. The CMS connects to `advantages-cz/avds` on the `master` default branch.
4. The user browses files in read-only mode and inspects previews.
5. The user presses Edit when they want to make changes.
6. If the user is on the default branch, the CMS creates a working branch automatically from the current head.
7. The CMS turns Markdown files into editors.
8. The user saves a deliberate commit to the working branch.
9. GitHub Actions run against the branch.
10. The CMS shows workflow status, check runs, and failure annotations.
11. If automation adds commits, the CMS highlights those changes.
12. The user previews generated artifacts such as HTML, PDF, or images.
13. The user opens a pull request from the CMS.
14. Final merge remains in GitHub, respecting branch protection and review rules.

## Security Principles

- Tokens are entered by the user and stay in the browser.
- Default token storage is session-only.
- Persistent token storage must be an explicit user choice.
- The application sends tokens only to GitHub API endpoints.
- Fine-grained GitHub tokens should be scoped to `advantages-cz/avds` only.
- Default product mode is read-only browsing.
- Pressing Edit creates a working branch only from the default branch; existing working branches are reused.
- Direct commits to the default branch are disabled by default.
- Repository HTML previews must remain sandboxed.
- User-provided repository content must be escaped unless intentionally rendered in a sandbox.
- The app should avoid unnecessary third-party runtime dependencies.

## Recommended GitHub Token Permissions

For a fine-grained personal access token:

- Metadata: read
- Contents: read/write
- Pull requests: read/write
- Actions: read
- Checks: read

Optional:

- Actions: write, if rerunning workflows from the CMS is required.

## Current Implementation Snapshot

The current implementation is a static application with no build step.

Key files:

- `index.html`: application shell.
- `assets/styles.css`: UI styling.
- `src/app.js`: application state, UI rendering, and workflow orchestration.
- `src/github.js`: GitHub REST API client.
- `src/storage.js`: local/session storage helpers.
- `src/utils.js`: encoding, preview, formatting, and classification helpers.
- `.github/workflows/pages.yml`: GitHub Pages deployment workflow.
- `README.md`: setup and usage documentation.
- `SECURITY.md`: security model and reporting notes.

Implemented capabilities:

- Modal token entry and storage mode selection.
- Fixed repository connection to `advantages-cz/avds`, default branch `master`.
- Branch listing and branch creation.
- Repository tree loading.
- Tree browser for repository contents.
- CMS-oriented tree sorting: root `README.md` opens by default; each level sorts `README.md` first, regular files, dotfiles, regular folders, then dot-prefixed folders.
- Markdown front matter titles in the tree when available, with the filename shown in muted parentheses.
- Collapsed tree by default, except when opening a URL or link that targets a deeper file or directory.
- Browse-first approval workflow.
- Automatic edit branch creation from the default branch.
- Reuse of the current working branch when editing outside the default branch.
- Explicit new edit branch creation when the user asks for it.
- Markdown-only editing for `.md` and `.mdx` files.
- Commit creation through GitHub Contents API.
- Pull request creation.
- Pull request diff summary.
- Detection of changes after the last CMS save.
- Check-run and workflow-run display.
- Check annotation loading.
- HTML, PDF, image, and text previews.
- SVG file preview and SVG assets in HTML preview.
- Rendered Markdown preview in browse mode.
- Front matter-aware Markdown rendering.
- Collapsed front matter display in rendered Markdown preview.
- Internal Markdown links resolved through the CMS tree instead of navigating the browser frame.
- Markdown preview hides HTML comments and supports angle-bracket link destinations with spaces, such as `[PDF](<vystupy/test pozvanky/file.pdf>)`.
- Browser history integration for repository file and folder navigation via URL `path` and `dir` parameters.
- Sandboxed HTML preview with relative image, SVG, and CSS assets inlined from the current branch.
- Fixed-height application shell with internal scrolling in the tree and preview regions.
- Resizable file tree width in the files workbench.
- Dismissible error and notification messages.
- Consolidated top workflow toolbar for branch, mode, edit, pull request, and refresh actions.
- User menu in the top toolbar for changing the token and logging out.
- CMS design-system pass based on Adaptivio brand rules: role-based CSS tokens, approved black Adaptivio symbol in the toolbar, compact product toolbar, explicit branch/mode status patterns, restrained brand treatment, quieter panels, denser tree rows, and document-like previews.
- Refined toolbar action model: edit/browse state lives in the primary workflow button, refresh is icon-only with a local Lucide-style SVG and an accessible label, PR creation is hidden until the branch has changes, and the signed-in user control looks like an account menu.
- Review workspace split into separate `Změny` and `Commity` tabs with badge counts. PR creation/opening lives in the toolbar, while the tabs focus on changed-file and commit lists and refresh after commit operations.
- Post-commit Actions feedback shows concrete files changed after the last CMS commit as clickable CMS links instead of a generic completed-workflow banner.
- Actions tab has a status badge for running, failing, or completed branch checks/workflows, the current action status is shown at the right edge of the tab strip, and action polling performs a full branch/review/actions refresh when work finishes.
- Automation output banners are dismissible per branch/head and show changed-file status labels plus local file-type icons with stable, colored added/modified/removed treatment.
- Changed-file status colors are shared across automation banners, change lists, and tree indicators. The file tree marks changed files with a dedicated indicator before the file icon, uses local Lucide-style SVG icons for folders and file types, omits redundant extension subtitles, and de-emphasizes miscellaneous technical files.
- Directory file counts in the tree align in the same right-hand column as file sizes.
- Changed-file rows in `Změny` use the file path itself as the CMS preview link instead of a separate Preview button, include the same local file-type icons as the tree, and show front matter titles in parentheses as non-link text when available. The Actions tab focuses on workflow runs, while outbound buttons such as PR and GitHub links carry an external-link icon.

## Open Questions

- Which paths should be editable by default?
- Which paths should be considered generated preview outputs?
- Should the CMS support GitHub App authentication later, or is per-user PAT enough?
- Should workflow reruns be enabled by default, or kept as an optional permission?
- Which generated artifact types are most important: PDF, static HTML, images, JSON reports, or something else?
- Should we add schema-aware editors for Markdown, YAML, JSON, or frontmatter?
- Should preview include downloaded Actions artifacts, not only files committed to the branch?

## Backlog

### Reliability

- Add clearer connection diagnostics for token scope and repository access.
- Add a compact debug panel for last GitHub API error details.
- Preserve selected file after branch refresh where possible.
- Handle very large repositories with path-scoped tree loading.

### Editing

- Add JSON validation.
- Add YAML validation.
- Add conflict detection before saving.
- Add rename and delete operations.
- Consider a structured front matter editor after the Markdown-only workflow stabilizes.

### Review And CI

- Show required checks separately from optional checks.
- Show latest workflow run per workflow.
- Highlight failing annotations by file path.
- Link changed files to the editor/preview view.
- Compare automation commits separately from human commits.

### Preview

- Support Actions artifact downloads and ZIP browsing.
- Support generated site preview roots.
- Add PDF metadata and page thumbnails if useful.
- Add richer generated-output navigation for multi-page HTML exports.

### Security

- Add a content security policy suitable for GitHub Pages.
- Document token creation with screenshots or exact GitHub settings.
- Add dependency policy before introducing external packages.
- Review sandbox settings before enabling any richer preview mode.

### Deployment

- Add `cms.config.json` generation guidance for production.
- Add branch protection recommendations.
- Add example private repository structure.
- Add a smoke-test checklist after deployment.

## Decision Log

### 2026-06-02: Build A Small Static CMS

Decision: Build a custom static CMS instead of adopting a generic OSS CMS directly.

Reasoning: The Adaptivio workflow needs branch editing, pull requests, GitHub Actions state, automation commit visibility, and generated artifact preview in one place. Existing tools cover only part of that workflow.

### 2026-06-02: Use Per-User GitHub Tokens First

Decision: Start with per-user GitHub tokens stored in the browser.

Reasoning: A public GitHub Pages application cannot safely hold a server-side secret. Per-user tokens keep repository access tied to GitHub identity and permissions.

### 2026-06-02: Keep Merge In GitHub

Decision: The CMS creates pull requests but does not merge them.

Reasoning: GitHub branch protection, required reviews, and required checks should remain authoritative.

### 2026-06-02: Browse First, Edit By Approval

Decision: The CMS defaults to read-only browsing and preview. Editing starts only after the user presses Edit. From the default branch, the CMS creates a working branch; from an existing working branch, it reuses that branch unless the user explicitly requests a new branch.

Reasoning: Most CMS sessions should be safe inspection sessions. Branch creation should be automatic and tied to explicit editing intent, not a manual prerequisite.

### 2026-06-02: Commit Deliberately, Then Check CI

Decision: Changes are committed explicitly with a Save commit action rather than on every local edit.

Reasoning: Explicit commits produce cleaner history, avoid excessive CI runs, and give the CMS a clear moment to refresh GitHub Actions, check-run errors, annotations, automation commits, and previews.

### 2026-06-02: Treat File Navigation As Browser History

Decision: Selecting files and folders updates the URL with repository, branch, and selected path state, and browser back/forward restores that CMS selection.

Reasoning: File browsing is a primary navigation workflow. The browser history controls should move through selected repository files without leaving the static CMS shell.

### 2026-06-02: Edit Markdown Only

Decision: The approval workflow only allows editing `.md` and `.mdx` files. Other repository contents remain browse and preview only.

Reasoning: Markdown is the content-authoring surface. Generated files, PDFs, images, HTML, and structured build outputs should be inspected through preview and changed by source edits or automation.

### 2026-06-02: Render Markdown As First-Class Preview

Decision: Browse mode renders Markdown as formatted HTML with front matter collapsed by default. Internal Markdown links are resolved against the loaded Git tree and opened inside the CMS.

Reasoning: Browsing should feel like reviewing published content, not like reading source text. Front matter is useful metadata, but it should not dominate the reading experience.

### 2026-06-02: Keep Preview Separate From Editing

Decision: Edit mode shows only the Markdown editor and commit workflow. It does not show a second live preview pane.

Reasoning: The current editing workflow should stay focused on deliberate source changes and explicit commits. Browse mode remains the source of truth for rendered previews and generated artifacts.

### 2026-06-02: Give Tree And Preview Priority

Decision: The main UI is organized around a large repository tree and a large preview/detail region. Redundant per-panel breadcrumbs and extra tree controls were removed, while the branch picker and workflow controls moved into the top toolbar.

Reasoning: The CMS is mostly a browse/review tool until the user explicitly enters editing. Vertical space should go to repository navigation and content inspection.

### 2026-06-02: Fix The Target Repository

Decision: The CMS targets `advantages-cz/avds` with `master` as the fixed default branch. Repository and default branch inputs were removed from the always-visible UI.

Reasoning: The current deployment is specialized for one Adaptivio repository. Removing repository setup keeps login from interrupting normal browsing and reduces accidental connection to the wrong repository.

### 2026-06-02: Apply A Product Design System Layer

Decision: Adaptivio CMS uses a restrained product design-system layer based on the Adaptivio brand palette rather than a generic teal UI theme.

Reasoning: The CMS is a working editor for repository, branch, token, preview, PR, and CI state. The UI should stay quiet and dense while clearly distinguishing browse mode, edit sessions, default branches, working branches, and risky actions.

### 2026-06-03: Split Review Into Changes And Commits

Decision: Replace the single Review tab with separate `Změny` and `Commity` tabs, each with its own badge count. Keep PR creation and opening in the top toolbar.

Reasoning: Changed files and commits answer different review questions. Keeping PR actions in the toolbar avoids duplicating workflow controls inside the review surface, and refreshing review data after commit operations keeps badges and lists current.

### 2026-06-03: Show Automation Output Files After Actions

Decision: When Actions finish after a CMS commit and the branch head changed, show the concrete files changed after the last CMS commit as clickable links into the CMS.

Reasoning: A generic completed-workflow banner does not help the editor decide what to review. The useful next step is opening the generated or changed files that automation committed.

### 2026-06-03: Simplify Review And Actions Navigation

Decision: In `Změny`, changed file paths are the primary navigation targets and the separate Preview button is removed. The Actions tab no longer renders the check-runs detail panel, and buttons that open GitHub or other external pages show an external-link icon.

Reasoning: Review lists should behave like lists first. Removing duplicate actions and broken detail surfaces makes the workflow easier to scan, while outbound icons make it clear when a button leaves the CMS.

### 2026-06-02: Move Login Into A Modal

Decision: GitHub token entry now opens as a modal from the top toolbar or empty state. Once authenticated, the top toolbar shows the GitHub login/token state as a menu with token change and logout actions.

Reasoning: Authentication is setup work, not primary content work. Keeping it out of the persistent sidebar gives more attention to repository navigation and preview while preserving explicit logout.

### 2026-06-02: Make Tree Width Resizable

Decision: The files workbench includes a draggable splitter between the repository tree and preview/editor panel. The chosen tree width is stored in browser settings.

Reasoning: Repository trees and previews need different amounts of space depending on path depth, file names, and review task. A splitter keeps the no-sidebar layout flexible without adding more persistent chrome.

### 2026-06-02: Sort Tree For CMS Browsing

Decision: If no URL selection is present, the CMS opens root `README.md` by default. Each tree level shows `README.md` first, then regular files, dotfiles, regular folders, and dot-prefixed folders such as `.github`. `README.md` uses a home-style icon.

Reasoning: Content editors usually need the local landing page or index before implementation folders. This keeps CMS-oriented content near the top without changing repository structure.

### 2026-06-02: Show Front Matter Titles In Tree

Decision: Markdown files can display their front matter `title` in the tree, with the filename in parentheses. Titles are loaded from smaller Markdown blobs in a capped background scan and cached by blob SHA.

Reasoning: Editors recognize content by page title more easily than by slug. Capping and caching the scan keeps the static GitHub API workflow reasonable for larger repositories.

### 2026-06-02: Keep Initial Tree Collapsed

Decision: The repository tree starts collapsed on a fresh load. Deep links and URL-restored selections still expand the ancestors needed to reveal the target file or directory.

Reasoning: A collapsed tree keeps the first view compact and CMS-like, while preserving orientation when the user enters through a link into the middle of the content structure.

## Update Protocol

When the project changes, update this document in the same commit as the related code or configuration change.

Recommended updates:

- Add new decisions to the decision log.
- Move completed backlog items into the implementation snapshot.
- Add newly discovered risks to the security principles or backlog.
- Keep open questions current.
- Record assumptions that affect repository structure, authentication, previews, or CI behavior.
