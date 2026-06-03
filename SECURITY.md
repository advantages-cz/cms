# Security

Adaptivio CMS is a public static application that can read and write a private GitHub repository only with the current user's GitHub OAuth token or manual fallback token.

## Token handling

- GitHub OAuth device flow is the primary sign-in path.
- Tokens are accepted and stored in the browser UI only.
- The default OAuth storage is `sessionStorage`.
- Persistent storage uses `localStorage` only when the user selects it.
- Tokens are sent only to `https://api.github.com` and GitHub OAuth endpoints.
- No token is committed to this repository and no backend secret exists.
- Direct browser calls to GitHub OAuth endpoints are blocked by GitHub CORS behavior; production OAuth needs a trusted OAuth proxy/serverless function or the manual token fallback.
- The app does not implement GitHub's standard redirect OAuth code exchange because that requires a server-side client secret/token exchange for a public static deployment.

For the manual fallback, use a fine-grained token scoped to the target repository. Prefer the minimum permissions documented in `README.md`.

## Content rendering

- Repository HTML is previewed in an iframe with an empty `sandbox` attribute.
- Text content is rendered as escaped text.
- Binary previews are loaded from authenticated GitHub blob responses into object URLs.

Do not add dependencies that render Markdown or HTML unless they include an explicit sanitizer strategy and are reviewed for XSS behavior.

## Branch safety

Direct commits to the default branch are disabled by default. The normal flow is:

1. Create a CMS branch.
2. Commit changes to the branch.
3. Open a pull request.
4. Let GitHub branch protections and Actions decide merge readiness.

## Reporting issues

For private deployments, report suspected token leakage, XSS, or authorization bypasses directly to the repository maintainers and rotate affected GitHub tokens immediately.
