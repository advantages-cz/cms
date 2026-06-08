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
- Connect to a private GitHub repository using a manually entered fine-grained GitHub token.
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
2. The user opens the login modal and pastes a GitHub token.
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

- Tokens stay in the browser.
- Token storage is session-only by default.
- The application sends tokens only to GitHub API endpoints.
- Fine-grained GitHub tokens should be scoped to `advantages-cz/avds` only.
- Default product mode is read-only browsing.
- Pressing Edit creates a working branch only from the default branch; existing working branches are reused.
- Direct commits to the default branch are disabled by default.
- Repository HTML previews must remain sandboxed.
- User-provided repository content must be escaped unless intentionally rendered in a sandbox.
- The app should avoid unnecessary third-party runtime dependencies.

## Recommended Token Permissions

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

- Token-only GitHub sign-in.
- Fixed repository connection to `advantages-cz/avds`, default branch `master`.
- Branch listing and branch creation.
- Repository tree loading.
- Persistent IndexedDB repository cache keyed by owner/repo/branch/head SHA, with a cache schema version and stored startup content extension list.
- Startup content hydration for `.md`, `.mdx`, `.html`, and `.htm` files through the Contents API, reusing cached file content by blob SHA and downloading only changed or missing allowed text files.
- Repository content refresh shows an animated busy status with loaded/total/remaining file counts while startup text contents are being hydrated.
- After a saved token or login starts repository connection, the welcome/workflow page is replaced by a focused connection status screen; token or repository errors remain visible with retry and change-token actions.
- Tree browser for repository contents.
- CMS-oriented tree sorting: root `README.md` opens by default; each level sorts `README.md` first, regular files, dotfiles, regular folders, then dot-prefixed folders.
- Markdown front matter titles in the tree when available, with the filename shown in muted parentheses.
- Front matter titles and fulltext search are populated from hydrated startup content instead of separate background Git blob reads.
- Search input rendering is debounced so fast typing is not interrupted by immediate result re-renders.
- Live front matter title updates while editing Markdown, reflected in the tree and changed-file metadata before the commit finishes.
- Collapsed tree by default, except when opening a URL or link that targets a deeper file or directory.
- Browse-first approval workflow.
- Automatic edit branch creation from the default branch.
- Reuse of the current working branch when editing outside the default branch.
- Explicit new edit branch creation when the user asks for it.
- Browser URL branch state is updated immediately after automatic or manual edit branch creation so reload stays on the working branch.
- Markdown-only editing for `.md` and `.mdx` files.
- Commit creation through GitHub Contents API.
- Pre-commit file SHA resync, 409 retry with cache-busted Contents reads, and post-commit selected-file reload through GitHub Contents API at the returned commit SHA.
- Editor form submit captures Markdown content from form data before any busy-state render.
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
- Internal Markdown links resolved through the CMS tree instead of navigating the browser frame; links to existing directories select and expand the matching tree folder.
- Markdown heading anchors normalize diacritics consistently between generated heading IDs and rendered internal links.
- Markdown preview hides HTML comments and supports angle-bracket link destinations with spaces, such as `[PDF](<vystupy/test pozvanky/file.pdf>)`.
- Browser history integration for repository file and folder navigation via URL `path` and `dir` parameters.
- Sandboxed HTML preview with relative image, SVG, and CSS assets inlined from the current branch.
- Fixed-height application shell with internal scrolling in the tree and preview regions.
- Resizable file tree width in the files workbench.
- Dismissible error and notification messages.
- Consolidated top workflow toolbar for branch, mode, edit, pull request, and refresh actions.
- User menu in the top toolbar for changing sign-in and logging out.
- English/Czech localization with English as the default language, UI copy centralized in `src/i18n.js`, and language selectors in both the top toolbar and GitHub sign-in modal.
- Light, dark, and automatic appearance modes in the top toolbar. Automatic mode follows `prefers-color-scheme`, and the selected preference is stored with other browser-local CMS settings.
- CMS design-system pass based on Adaptivio brand rules: role-based CSS tokens, approved black Adaptivio symbol in the toolbar, compact product toolbar, explicit branch/mode status patterns, restrained brand treatment, quieter panels, denser tree rows, and document-like previews.
- Refined toolbar action model: edit/browse state lives in the primary workflow button, refresh is icon-only with a local Lucide-style SVG and an accessible label, PR creation is hidden until the branch has changes, and the signed-in user control looks like an account menu.
- Review workspace split into separate `Změny` and `Commity` tabs with badge counts. PR creation/opening lives in the toolbar, while the tabs focus on changed-file and commit lists and refresh after commit operations.
- Post-commit Actions feedback shows concrete files changed after the last CMS commit as clickable CMS links instead of a generic completed-workflow banner.
- Commit-result tracking is anchored after every explicit CMS write action, including save, create, file delete, and folder delete, so Actions polling and automation diff feedback start consistently.
- Actions tab has a status badge for running, failing, or completed branch checks/workflows, the current action status is shown at the right edge of the tab strip, and action polling performs a full branch/review/actions refresh when work finishes.
- The Actions tab badge shows the number of workflow runs listed in the tab. Running/failing/OK state belongs to the right-side status pill, not the numeric badge.
- Automation output banners are dismissible per branch/head and show changed-file status labels plus local file-type icons with stable, colored added/modified/removed treatment. Removed files remain visible in the banner but are not clickable because they no longer exist in the current tree.
- Changed-file status colors are shared across automation banners, change lists, and tree indicators. The file tree marks changed files with a dedicated indicator before the file icon, uses local Lucide-style SVG icons for folders and file types, omits redundant extension subtitles, and de-emphasizes miscellaneous technical files.
- Directory file counts in the tree align in the same right-hand column as file sizes.
- Changed-file rows in `Změny` use the file path itself as the CMS preview link instead of a separate Preview button, include the same local file-type icons as the tree, and show front matter titles in parentheses as non-link text when available. The Actions tab focuses on workflow runs, while outbound buttons such as PR and GitHub links carry an external-link icon.

## Open Questions

- Which paths should be editable by default?
- Which paths should be considered generated preview outputs?
- Should the CMS support GitHub App authentication later, or is token-only login enough?
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
- Document OAuth App setup with screenshots or exact GitHub settings.
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

### 2026-06-08: Simplify Login To Token Entry

Decision: The sign-in screen now focuses on a single token input and no longer exposes OAuth device flow or fallback branching.

Reasoning: The deployment does not have a backend secret or OAuth proxy, so a token-only login keeps the entry point honest, reduces UI complexity, and makes the required GitHub permissions explicit up front.

### 2026-06-02: Keep Merge In GitHub

Decision: The CMS creates pull requests but does not merge them.

Reasoning: GitHub branch protection, required reviews, and required checks should remain authoritative.

### 2026-06-02: Browse First, Edit By Approval

Decision: The CMS defaults to read-only browsing and preview. Editing starts only after the user presses Edit. From the default branch, the CMS creates a working branch; from an existing working branch, it reuses that branch unless the user explicitly requests a new branch.

Reasoning: Most CMS sessions should be safe inspection sessions. Branch creation should be automatic and tied to explicit editing intent, not a manual prerequisite.

### 2026-06-02: Commit Deliberately, Then Check CI

Decision: Changes are committed explicitly with a Save commit action rather than on every local edit.

Reasoning: Explicit commits produce cleaner history, avoid excessive CI runs, and give the CMS a clear moment to refresh GitHub Actions, check-run errors, annotations, automation commits, and previews.

### 2026-06-03: Track Every Explicit CMS Write

Decision: Save, create, file delete, and folder delete operations all record their resulting CMS commit as the latest write anchor before refreshing review and Actions data.

Reasoning: Any explicit CMS write can trigger Actions or follow-up automation. Treating only editor saves as the anchor left deletes and creates without the same post-action status and automation diff feedback.

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

### 2026-06-03: Keep Deleted Files In Automation Output

Decision: Automation output banners include removed files from the post-CMS-commit diff, but render them as non-clickable rows.

Reasoning: Deleted files are part of the automation impact and should be visible to editors, while linking them into the CMS would fail because they are absent from the current branch tree.

### 2026-06-03: Simplify Review And Actions Navigation

Decision: In `Změny`, changed file paths are the primary navigation targets and the separate Preview button is removed. The Actions tab no longer renders the check-runs detail panel, and buttons that open GitHub or other external pages show an external-link icon.

Reasoning: Review lists should behave like lists first. Removing duplicate actions and broken detail surfaces makes the workflow easier to scan, while outbound icons make it clear when a button leaves the CMS.

### 2026-06-03: Centralize UI Copy And Add Language Selection

Decision: Move UI copy into `src/i18n.js`, ship English and Czech resources, default the app to English, and expose language selection in the toolbar and sign-in modal.

Reasoning: The CMS is used by both Czech and English-speaking maintainers. Centralized resources keep translations auditable and prevent future UI copy from being scattered through workflow and render code.

### 2026-06-04: Add User-Selectable Appearance Modes

Decision: Add light, dark, and automatic appearance modes. Automatic mode follows the browser or operating-system `prefers-color-scheme` setting, while explicit light/dark choices override it. The preference is saved in the same local CMS settings object as language, branch, tab, and tree width.

Reasoning: Editors may use the CMS for long review sessions across different environments. A theme preference improves comfort without changing the GitHub workflow or adding dependencies, and keeping the default as automatic respects the user's device setting.

### 2026-06-04: Prioritize Tree Titles Before Fulltext

Decision: Superseded by the 2026-06-08 repository snapshot and startup content cache. Repository refresh no longer starts separate front matter title or fulltext background scans; both are derived from hydrated startup content as the tree is applied.

Reasoning: Startup hydration already fetches or reuses the Markdown and HTML blobs needed for titles and search, so a second background pass would duplicate API/cache work and could trigger avoidable UI re-renders.

### 2026-06-02: Move Login Into A Modal

Decision: GitHub sign-in opens as a modal from the top toolbar or empty state. Once authenticated, the top toolbar shows the GitHub login/token state as a menu with sign-in change and logout actions.

Reasoning: Authentication is setup work, not primary content work. Keeping it out of the persistent sidebar gives more attention to repository navigation and preview while preserving explicit logout.

### 2026-06-02: Make Tree Width Resizable

Decision: The files workbench includes a draggable splitter between the repository tree and preview/editor panel. The chosen tree width is stored in browser settings.

Reasoning: Repository trees and previews need different amounts of space depending on path depth, file names, and review task. A splitter keeps the no-sidebar layout flexible without adding more persistent chrome.

### 2026-06-02: Sort Tree For CMS Browsing

Decision: If no URL selection is present, the CMS opens root `README.md` by default. Each tree level shows `README.md` first, then regular files, dotfiles, regular folders, and dot-prefixed folders such as `.github`. `README.md` uses a home-style icon.

Reasoning: Content editors usually need the local landing page or index before implementation folders. This keeps CMS-oriented content near the top without changing repository structure.

### 2026-06-02: Show Front Matter Titles In Tree

Decision: Markdown files can display their front matter `title` in the tree, with the filename in parentheses. The original capped background scan was superseded on 2026-06-08 by startup content hydration and blob-SHA caching.

Reasoning: Editors recognize content by page title more easily than by slug. Loading titles from already hydrated startup content keeps the static GitHub API workflow predictable without a second scan.

### 2026-06-03: Keep Edited Front Matter Titles Live

Decision: While a Markdown file is being edited, changes to its front matter `title` update the current file metadata by path so the tree and changed-file lists reflect the draft title immediately.

Reasoning: Editors expect a page rename in front matter to rename the CMS navigation label without waiting for a full Git blob refresh. Updating by path avoids corrupting the blob-SHA title cache with unsaved draft metadata.

### 2026-06-03: Resync File SHA Before Commit

Decision: Before committing an edited Markdown file, the CMS refreshes the file through GitHub's Contents API and updates the editor's file SHA when the remote content still matches the editor's original base content. GitHub API requests use `cache: "no-store"`, and a 409 save response retries once after a cache-busted Contents read. If the remote file content changed, the commit is blocked and the draft remains in the editor.

Reasoning: GitHub's Contents API rejects writes with stale blob SHAs, so the preflight should use the same API surface that validates the write. This prevents avoidable 409 errors while still protecting against silent overwrites of external or automation edits.

### 2026-06-03: Reload Saved File From Contents

Decision: After a successful Markdown save, the CMS reloads the selected file from GitHub's Contents API using the returned commit SHA, applies tree refresh data only when it matches the known save commit, and skips an extra branch sync while refreshing Actions for that known commit.

Reasoning: GitHub tree and branch reads can briefly lag a Contents write. Guarding tree refreshes and reloading the saved file through the immutable commit ref and the same API surface as the write prevents the editor from flashing back to the previous blob after commit.

### 2026-06-08: Persist Repository Snapshot And Startup Content

Decision: Repository refresh now stores the Git tree, head commit SHA, tree SHA, startup content extension list, and hydrated `.md`, `.mdx`, `.html`, and `.htm` contents in IndexedDB. When the cached branch snapshot matches the known branch head SHA and cache version, the CMS applies the local snapshot without downloading the tree or file contents. When the head changes, the CMS refreshes the tree and downloads only allowed startup files whose blob SHA is not already cached.

Reasoning: GitHub API rate limits are tight during token verification and branch startup. Caching by commit and blob SHA avoids repeated tree, title, fulltext, and blob calls while keeping GitHub as the source of truth whenever the branch head changes.

### 2026-06-03: Capture Editor Submit Content From Form Data

Decision: The save form includes the Markdown textarea in `FormData`, and the submit handler passes that content into the save workflow before any busy-state render.

Reasoning: The editor DOM can be replaced during busy rendering or delayed metadata refreshes. Reading the submitted form payload is the stable source of the user's current draft at commit time.

### 2026-06-02: Keep Initial Tree Collapsed

Decision: The repository tree starts collapsed on a fresh load. Deep links and URL-restored selections still expand the ancestors needed to reveal the target file or directory.

Reasoning: A collapsed tree keeps the first view compact and CMS-like, while preserving orientation when the user enters through a link into the middle of the content structure.

### 2026-06-03: Markdown Folder Links Select Tree Folders

Decision: When a rendered Markdown link points at an existing repository directory rather than a direct file path, the CMS selects that directory in the tree and expands it instead of opening an inferred Markdown file such as `index.md`.

Reasoning: Folder links are navigation cues for editors browsing a content structure. Keeping them in the tree preserves orientation and avoids surprising file selection when the Markdown source intentionally points to a directory.

### 2026-06-03: Normalize Markdown Anchors With Heading IDs

Decision: Rendered internal Markdown links normalize hash anchors with the same diacritic-stripping slug logic used for generated Markdown heading IDs.

Reasoning: Czech and Slovak headings can include diacritics while generated heading IDs do not. Using one normalization path keeps links such as `#expertíza` aligned with headings rendered as `id="expertiza"`.

### 2026-06-04: Add Unified Header Search

Decision: The top toolbar includes one search box for folder path, file name, front matter title, and indexed Markdown/HTML content. Without a query the left pane shows the repository tree; with a query it switches to ranked search results with match type labels and content snippets where available. Opening a content match highlights the term in Markdown/text previews. Hydrated Markdown and HTML startup blobs up to a capped size are indexed in memory by blob SHA; binary files are not indexed.

Reasoning: Editors need one predictable place to search navigation and content, and content matches need enough context to decide which result to open. Keeping the index client-side and capped preserves the static GitHub API architecture while avoiding large assets.

Follow-up: The earlier background title and fulltext scans were removed after startup content hydration became the single source for title/search cache population.

### 2026-06-04: Move Locale And Theme Controls Into User Menu

Decision: Language and theme selectors live inside the signed-in user menu, whose trigger now includes a visible caret and expanded state.

Reasoning: Locale and visual theme are account/session preferences, not primary content workflow actions. Moving them into the menu leaves toolbar space for repository search and branch actions.

## Update Protocol

When the project changes, update this document in the same commit as the related code or configuration change.

Recommended updates:

- Add new decisions to the decision log.
- Move completed backlog items into the implementation snapshot.
- Add newly discovered risks to the security principles or backlog.
- Keep open questions current.
- Record assumptions that affect repository structure, authentication, previews, or CI behavior.
