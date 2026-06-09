const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(message, response, payload, meta = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = response?.status;
    this.payload = payload;
    this.meta = meta;
  }
}

export class GitHubRequestError extends Error {
  constructor(message, cause, meta = {}) {
    super(message);
    this.name = "GitHubRequestError";
    this.cause = cause;
    this.meta = meta;
  }
}

export class DiscourseError extends Error {
  constructor(message, response, payload, meta = {}) {
    super(message);
    this.name = "DiscourseError";
    this.status = response?.status;
    this.payload = payload;
    this.meta = meta;
  }
}

export class GitHubClient {
  constructor(token) {
    this.token = token;
  }

  async request(path, options = {}) {
    const { payload } = await this.requestWithMeta(path, options);
    return payload;
  }

  async requestWithMeta(path, options = {}) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const method = options.method || "GET";
    const requestMeta = { method, path, url };
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(options.headers || {}),
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        ...options,
        headers,
      });
    } catch (error) {
      throw new GitHubRequestError(error?.message || "GitHub API request failed", error, requestMeta);
    }

    const text = await response.text();
    const payload = parseJson(text);
    const meta = readResponseMeta(response, requestMeta);

    if (!response.ok) {
      const message = payload?.message || response.statusText || "GitHub API request failed";
      throw new GitHubError(message, response, payload, meta);
    }

    return { payload, meta };
  }

  async paginate(path, limitPages = 10) {
    const items = [];
    for (let page = 1; page <= limitPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await this.request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(data)) {
        return data;
      }
      items.push(...data);
      if (data.length < 100) {
        break;
      }
    }
    return items;
  }

  getAuthenticatedUser() {
    return this.request("/user");
  }

  getRepository(owner, repo) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  listBranches(owner, repo) {
    return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
  }

  getBranch(owner, repo, branch) {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
    );
  }

  getGitCommit(owner, repo, sha) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`);
  }

  async listTree(owner, repo, branch, { headSha = "" } = {}) {
    const branchInfo = headSha ? { commit: { sha: headSha } } : await this.getBranch(owner, repo, branch);
    const commit = await this.getGitCommit(owner, repo, branchInfo.commit.sha);
    const tree = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit.tree.sha}?recursive=1`,
    );

    return {
      headSha: branchInfo.commit.sha,
      treeSha: commit.tree.sha,
      truncated: Boolean(tree.truncated),
      tree: tree.tree || [],
    };
  }

  createBranch(owner, repo, branchName, sha) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha,
      }),
    });
  }

  getContent(owner, repo, path, ref, { cacheBust = false } = {}) {
    const query = new URLSearchParams({ ref });
    if (cacheBust) {
      query.set("_", String(Date.now()));
    }
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}?${query.toString()}`,
    );
  }

  getBlob(owner, repo, sha) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`);
  }

  putFile(owner, repo, path, { branch, message, contentBase64, sha }) {
    const body = {
      message,
      content: contentBase64,
      branch,
    };

    if (sha) {
      body.sha = sha;
    }

    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  deleteFile(owner, repo, path, { branch, message, sha }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`, {
      method: "DELETE",
      body: JSON.stringify({
        message,
        sha,
        branch,
      }),
    });
  }

  createTree(owner, repo, { baseTree, tree }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTree,
        tree,
      }),
    });
  }

  createCommit(owner, repo, { message, tree, parents }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message,
        tree,
        parents,
      }),
    });
  }

  updateBranchRef(owner, repo, branch, { sha, force = false }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodePath(branch)}`, {
      method: "PATCH",
      body: JSON.stringify({
        sha,
        force,
      }),
    });
  }

  listPullRequests(owner, repo, params = {}) {
    const query = new URLSearchParams({ state: "open", ...params });
    return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`);
  }

  createPullRequest(owner, repo, body) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  getPullFiles(owner, repo, number) {
    return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`);
  }

  getPullCommits(owner, repo, number) {
    return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/commits`);
  }

  compare(owner, repo, base, head) {
    const spec = encodeURIComponent(`${base}...${head}`);
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${spec}`);
  }

  getCheckRuns(owner, repo, ref) {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
        },
      },
    );
  }

  getCheckRunAnnotations(owner, repo, checkRunId) {
    return this.paginate(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}/annotations`,
    );
  }

  getWorkflowRuns(owner, repo, branch) {
    const query = new URLSearchParams({ branch, per_page: "20" });
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${query.toString()}`,
    );
  }

  rerunWorkflowRun(owner, repo, runId) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun`, {
      method: "POST",
    });
  }

  requestDeviceCode(clientId, scope) {
    const body = new URLSearchParams({
      client_id: clientId,
      scope,
    });

    return fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }).then(readOAuthResponse);
  }

  pollDeviceToken(clientId, deviceCode) {
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    return fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }).then(readOAuthResponse);
  }
}

export class DiscourseClient {
  constructor({ baseUrl, apiKey, apiUsername }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/g, "");
    this.apiKey = apiKey;
    this.apiUsername = apiUsername;
  }

  async request(path, options = {}) {
    const { payload } = await this.requestWithMeta(path, options);
    return payload;
  }

  async requestWithMeta(path, options = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const method = options.method || "GET";
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };

    if (this.apiKey) {
      headers["Api-Key"] = this.apiKey;
    }
    if (this.apiUsername) {
      headers["Api-Username"] = this.apiUsername;
    }
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers,
    });

    const text = await response.text();
    const payload = parseJson(text);
    const meta = readResponseMeta(response, { method, path, url });

    if (!response.ok) {
      const message = payload?.message || payload?.errors?.join?.(", ") || response.statusText || "Discourse API request failed";
      throw new DiscourseError(message, response, payload, meta);
    }

    return { payload, meta };
  }

  async getTopicByExternalId(externalId) {
    return this.request(`/t/external_id/${encodeURIComponent(externalId)}.json`);
  }

  async createTopic({ title, raw, category, tags = [], embedUrl, externalId }) {
    return this.request("/posts.json", {
      method: "POST",
      body: JSON.stringify({
        title,
        raw,
        category,
        tags,
        embed_url: embedUrl,
        external_id: externalId,
      }),
    });
  }
}

function encodePath(path) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readOAuthResponse(response) {
  const payload = parseJson(await response.text());
  if (!response.ok || payload?.error) {
    const message = payload?.error_description || payload?.error || response.statusText;
    throw new GitHubError(message, response, payload, readResponseMeta(response, {
      method: "POST",
      path: response.url,
      url: response.url,
    }));
  }
  return payload;
}

function readResponseMeta(response, request) {
  return {
    method: request.method,
    path: request.path,
    url: request.url,
    status: response.status,
    requestId: response.headers.get("X-GitHub-Request-Id") || "",
    acceptedGithubPermissions: response.headers.get("X-Accepted-GitHub-Permissions") || "",
    acceptedOauthScopes: response.headers.get("X-Accepted-OAuth-Scopes") || "",
    oauthScopes: response.headers.get("X-OAuth-Scopes") || "",
    rateLimitRemaining: response.headers.get("X-RateLimit-Remaining") || "",
  };
}
