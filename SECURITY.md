# Security

Adaptivio CMS is a public static application that can read and write a private GitHub repository only with a manually entered fine-grained GitHub token.

## Token handling

- Tokens are accepted and stored in the browser UI only.
- Token storage is `sessionStorage`.
- Tokens are sent only to `https://api.github.com`.
- No token is committed to this repository and no backend secret exists.
- Repository tree metadata and hydrated `.md`, `.mdx`, `.html`, and `.htm` contents are cached in browser IndexedDB by repository, branch, commit SHA, and blob SHA. This cache is local to the user's browser and is invalidated by the app cache schema version.
For the token, use a fine-grained token scoped to the target repository. Prefer the minimum permissions documented in `README.md`.

## Content rendering

- Repository HTML is previewed in an iframe with an empty `sandbox` attribute.
- Text content is rendered as escaped text.
- Binary previews are loaded on demand from authenticated GitHub blob responses into object URLs.

Do not add dependencies that render Markdown or HTML unless they include an explicit sanitizer strategy and are reviewed for XSS behavior.

## Branch safety

Direct commits to the default branch are disabled by default. The normal flow is:

1. Create a CMS branch.
2. Commit changes to the branch.
3. Open a pull request.
4. Let GitHub branch protections and Actions decide merge readiness.

## Reporting issues

For private deployments, report suspected token leakage, XSS, or authorization bypasses directly to the repository maintainers and rotate affected GitHub tokens immediately.
