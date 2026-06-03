# Adaptivio CMS

Adaptivio CMS is a static GitHub CMS for a public GitHub Pages app that edits a private GitHub repository through the GitHub API. The goal is a small, auditable tool for Adaptivio content, data, and generated project artifacts without a custom database or server-side secret.

## Why A Custom App

Good open-source Git CMS tools already exist:

- Decap CMS supports a GitHub backend and an editorial workflow built around branches and pull requests.
- Pages CMS provides a simple editing UI for GitHub repositories.

Adaptivio also needs GitHub Actions status, failing check annotations, detection of automation commits pushed after a CMS save, and previews of generated HTML/PDF/image files from the working branch in the same workflow. This repository therefore contains a small specialized app instead of a general-purpose CMS.

## Features

- Connects to a private repo with per-user GitHub OAuth device flow. A manual token remains available as a fallback.
- The target repo is fixed in the app to `advantages-cz/avds`, default branch `master`.
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

OAuth sign-in stores the token in `sessionStorage`. Manual fallback tokens can be persisted in `localStorage`, but should be used only on a trusted computer. Direct commits to the default branch are disabled.

HTML previews are sandboxed without `allow-scripts` and without `allow-same-origin`. The app never injects file content as HTML into its own DOM.

## Configuration

An optional `cms.config.json` file can live next to `index.html`:

```json
{
  "branchPrefix": "cms/",
  "editablePathHints": ["content/", "docs/", "data/", "assets/"],
  "previewPathHints": ["dist/", "public/", "site/", "exports/"],
  "githubOAuthClientId": "your_oauth_app_client_id"
}
```

The repository and default branch are not configurable in the UI; the app uses `advantages-cz/avds` and `master`.

The CMS stores the selected file or folder in the URL through `path` or `dir`, so links can open a specific branch location:

```text
https://example.github.io/adaptivio-cms/?branch=master&path=content/page.md
```

`githubOAuthClientId` enables GitHub OAuth device flow and should be configured for production. Device flow does not require a client secret, so it preserves the static GitHub Pages deployment model. GitHub's standard web application OAuth redirect flow requires a server-side token exchange with a client secret and is not implemented in this public static app. A fine-grained PAT remains available only as a fallback.

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

## Test

The project uses Node's built-in test runner and has no package manager dependency.

```sh
node --test
```

## Limitations

- The CMS loads the repository tree through the Git Trees API. For very large repositories, GitHub may return a truncated tree.
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
- GitHub OAuth device flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
