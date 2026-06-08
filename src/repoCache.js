const DB_NAME = "adaptivio-cms-repository-cache";
const DB_VERSION = 1;
export const REPOSITORY_CACHE_VERSION = 1;

let dbPromise = null;

export async function loadRepositoryCache(owner, repo, branch) {
  const db = await openDatabase();
  const key = repositoryKey(owner, repo, branch);
  const meta = await getFromStore(db, "repositories", key);
  if (!meta || meta.cacheVersion !== REPOSITORY_CACHE_VERSION) {
    return null;
  }
  return meta;
}

export async function saveRepositoryCache(owner, repo, branch, snapshot) {
  const db = await openDatabase();
  const key = repositoryKey(owner, repo, branch);
  await putToStore(db, "repositories", {
    ...snapshot,
    key,
    owner,
    repo,
    branch,
    cacheVersion: REPOSITORY_CACHE_VERSION,
    savedAt: new Date().toISOString(),
  });
}

export async function loadCachedContents(owner, repo, shas) {
  const db = await openDatabase();
  const result = new Map();
  const uniqueShas = [...new Set(shas.filter(Boolean))];
  await Promise.all(
    uniqueShas.map(async (sha) => {
      const record = await getFromStore(db, "contents", contentKey(owner, repo, sha));
      if (record?.cacheVersion === REPOSITORY_CACHE_VERSION) {
        result.set(sha, record.content);
      }
    }),
  );
  return result;
}

export async function saveCachedContent(owner, repo, sha, content, path = "") {
  if (!sha) {
    return;
  }
  const db = await openDatabase();
  await putToStore(db, "contents", {
    key: contentKey(owner, repo, sha),
    owner,
    repo,
    sha,
    path,
    content,
    cacheVersion: REPOSITORY_CACHE_VERSION,
    savedAt: new Date().toISOString(),
  });
}

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("repositories")) {
        db.createObjectStore("repositories", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("contents")) {
        db.createObjectStore("contents", { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  return dbPromise;
}

function getFromStore(db, storeName, key) {
  return transactionRequest(db, storeName, "readonly", (store) => store.get(key));
}

function putToStore(db, storeName, value) {
  return transactionRequest(db, storeName, "readwrite", (store) => store.put(value));
}

function transactionRequest(db, storeName, mode, createRequest) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = createRequest(transaction.objectStore(storeName));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function repositoryKey(owner, repo, branch) {
  return `${owner}/${repo}:${branch}`;
}

function contentKey(owner, repo, sha) {
  return `${owner}/${repo}:${sha}`;
}
