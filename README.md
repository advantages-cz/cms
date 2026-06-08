# Adaptivio CMS

Adaptivio CMS is a static GitHub CMS for a public GitHub Pages app that edits a private GitHub repository through the GitHub API. The goal is a small, auditable tool for Adaptivio content, data, and generated project artifacts without a custom database or server-side secret.

## Why A Custom App

Good open-source Git CMS tools already exist:

- Decap CMS supports a GitHub backend and an editorial workflow built around branches and pull requests.
- Pages CMS provides a simple editing UI for GitHub repositories.

Adaptivio also needs GitHub Actions status, failing check annotations, detection of automation commits pushed after a CMS save, and previews of generated HTML/PDF/image files from the working branch in the same workflow. This repository therefore contains a small specialized app instead of a general-purpose CMS.

## Features

- Connects to a private repo with a manually entered fine-grained GitHub token.
- The target repo is fixed in the app to `advantages-cz/avds`, default branch `master`.
- Installable as a PWA from Chromium browsers, so the CMS can run in its own app window from the Dock.
- Browse repository content as a tree.
- Browser back/forward works for file and folder navigation inside the CMS.
- Read-only browsing workflow with file previews.
- Creates a working branch from the default branch only when the user presses Edit.
- Keeps using the same working branch when the user is already away from the default branch.
- Creates another working branch only when explicitly requested.
- Edits only `.md` and `.mdx` files.
- Commits explicitly through the Contents API.
- Creates pull requests into the default branch.
- Shows branch diff against the default branch.
- Detects changes after the last CMS commit, typically when GitHub Actions push an additional commit.
- Shows workflow runs for the current branch.
- Optionally loads check runs and check annotations for CI errors when the token/installation supports the Checks API.
- Renders Markdown previews including front matter.
- Opens a slide-over Discourse discussion panel for the selected file, using the current CMS file URL plus plain Discourse links for opening search and a pre-filled new-topic composer. Markdown files additionally prefill quote selections, including selected table rows or partial cell ranges converted to Markdown tables, plus front matter-based metadata.
- Previews HTML in a sandboxed iframe with relative image/SVG/CSS assets resolved when possible.
- Previews PDF, SVG, images, and text.
- Supports English and Czech UI through `src/i18n.js`; English is the default language.

## Security Model

The app is fully static. There is no backend that stores secrets or proxies private data. The OAuth token stays in the user's browser and is sent only to `https://api.github.com`.

The recommended OAuth scope is `repo` so the CMS can read and write the private target repository, create pull requests, and read workflow state. For manual fallback tokens, use these fine-grained permissions:

- `Metadata`: read
- `Contents`: read/write
- `Pull requests`: read/write
- `Actions`: read
- `Checks`: optional, only for detailed check runs and annotations; if fine-grained PATs do not expose this permission, the CMS uses `Actions: read`.

Optionally allow `Actions: write` if the CMS should rerun workflow runs.

Token sign-in stores the token in `localStorage` so it persists across browser restarts. Direct commits to the default branch are disabled.

HTML previews are sandboxed without `allow-scripts` and without `allow-same-origin`. The app never injects file content as HTML into its own DOM.

## Configuration

An optional `cms.config.json` file can live next to `index.html`:

```json
{
  "branchPrefix": "cms/",
  "editablePathHints": ["content/", "docs/", "data/", "assets/"],
  "previewPathHints": ["dist/", "public/", "site/", "exports/"],
  "discourseUrl": "https://discourse.example.internal/",
  "discourseCategoryId": 12,
  "discourseTags": ["cms", "docs"]
}
```

The repository and default branch are not configurable in the UI; the app uses `advantages-cz/avds` and `master`.

The CMS stores the selected file or folder in the URL through `path` or `dir`, so links can open a specific branch location:

```text
https://example.github.io/adaptivio-cms/?branch=master&path=content/page.md
```

Authentication is token-only. The app does not use `githubOAuthClientId` for login, and the only required setup is a fine-grained PAT with access to the fixed repository.

For the discussion MVP:

- `discourseUrl` points to the self-hosted Discourse base URL.
- `discourseCategoryId` and `discourseTags` optionally prefill topic creation.
- `Open discussion` uses Discourse search for the current CMS file URL, while `Create topic` opens `/new-topic` with a pre-filled title, body, category, and tags as described in the official Discourse guide.
- Markdown files keep the richer discussion prefill behavior: selected quote snippets, front matter discussion titles, and owner-derived category hints.

## Localization

All UI copy lives in `src/i18n.js`. Add or update strings there instead of hard-coding user-facing text in render or workflow functions.

The language selector is available in the top toolbar and in the GitHub sign-in modal. English is the default language, and the user's selection is saved with other local settings.

## Deploy To GitHub Pages

The project has no build step. A workflow in `.github/workflows/pages.yml` can publish the repository contents as a static Pages app.

In the GitHub repo:

1. Open Settings -> Pages.
2. Set Source to GitHub Actions.
3. Push to `main` or `master`.
4. Open the published Pages URL.

## Run Locally

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

For PWA install testing, use a Chromium browser and install the site from the address bar menu after serving it over HTTP or HTTPS. Desktop link-capturing behavior depends on the browser and operating system; on macOS this works best when the installed app opens same-origin links from Chrome.

## Test

The project uses Node's built-in test runner and has no package manager dependency.

```sh
node --test
```

## Limitations

- The CMS caches repository snapshots and hydrated `.md`, `.mdx`, `.html`, and `.htm` contents in browser IndexedDB by branch head SHA and file blob SHA. If the cached head matches the current branch head, startup uses the local snapshot instead of re-downloading the tree or text contents. Hidden root-level technical content that the CMS omits from the tree/search model is also skipped during startup hydration.
- The CMS loads the repository tree through the Git Trees API when the branch head changes. For very large repositories, GitHub may return a truncated tree.
- Editing is intentionally limited to Markdown. Other files are browsed or created by automation.
- Previews show files committed to the branch. The app does not download separate Actions artifact ZIPs.
- PR merge stays in the GitHub UI so branch protection and review rules remain the source of truth.

## References

- Decap CMS GitHub backend: https://decapcms.org/docs/github-backend/
- Decap CMS editorial workflow: https://decapcms.org/docs/editorial-workflows/
- Pages CMS docs: https://pagescms.org/docs/
- GitHub Contents API: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28
- GitHub Pull Requests API: https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28
- GitHub Checks API: https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28
- GitHub Actions workflow runs API: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28
- GitHub compare commits API: https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28
