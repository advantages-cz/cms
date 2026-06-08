const SETTINGS_KEY = "adaptivio.cms.settings.v1";
const SESSION_TOKEN_KEY = "adaptivio.cms.token.session.v1";
const LOCAL_TOKEN_KEY = "adaptivio.cms.token.local.v1";
const SESSION_DISCOURSE_AUTH_KEY = "adaptivio.cms.discourse-auth.session.v1";
const LAST_SAVE_PREFIX = "adaptivio.cms.last-save.v1";

export function loadSettings() {
  return readJson(localStorage.getItem(SETTINGS_KEY), {});
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadToken() {
  const sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (sessionToken) {
    return { token: sessionToken, persistence: "session" };
  }

  const localToken = localStorage.getItem(LOCAL_TOKEN_KEY);
  if (localToken) {
    return { token: localToken, persistence: "local" };
  }

  return { token: "", persistence: "session" };
}

export function saveToken(token, persistence) {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(LOCAL_TOKEN_KEY);

  if (!token) {
    return;
  }

  if (persistence === "local") {
    localStorage.setItem(LOCAL_TOKEN_KEY, token);
  } else {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  }
}

export function clearToken() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(LOCAL_TOKEN_KEY);
}

export function loadDiscourseAuth() {
  return readJson(sessionStorage.getItem(SESSION_DISCOURSE_AUTH_KEY), {
    apiKey: "",
    apiUsername: "",
  });
}

export function saveDiscourseAuth(auth) {
  const payload = {
    apiKey: String(auth?.apiKey || "").trim(),
    apiUsername: String(auth?.apiUsername || "").trim(),
  };

  if (!payload.apiKey && !payload.apiUsername) {
    sessionStorage.removeItem(SESSION_DISCOURSE_AUTH_KEY);
    return;
  }

  sessionStorage.setItem(SESSION_DISCOURSE_AUTH_KEY, JSON.stringify(payload));
}

export function clearDiscourseAuth() {
  sessionStorage.removeItem(SESSION_DISCOURSE_AUTH_KEY);
}

export function loadLastSave(owner, repo, branch) {
  return readJson(localStorage.getItem(lastSaveKey(owner, repo, branch)), null);
}

export function saveLastSave(owner, repo, branch, snapshot) {
  localStorage.setItem(lastSaveKey(owner, repo, branch), JSON.stringify(snapshot));
}

function lastSaveKey(owner, repo, branch) {
  return `${LAST_SAVE_PREFIX}.${owner}/${repo}.${branch}`;
}

function readJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
