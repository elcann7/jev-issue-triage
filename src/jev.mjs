// Jev API client: dependency-free (Node 20+ fetch). An error is an error, never an answer.

export class JevError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function askJev({
  apiKey,
  state,
  questions,
  model = "jev-latest",
  baseUrl = "https://api.typesafe.ai",
  timeoutMs = 20000,
  retries = 2,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
}) {
  if (!apiKey) throw new JevError("Missing TypeSafe API key (set the api_key input / TYPESAFE_API_KEY).");
  const body = JSON.stringify({ state, model, questions });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = new JevError(`Network error calling Jev: ${e.message}`);
      if (attempt < retries) await sleepImpl(500 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const missing = Object.keys(questions).filter((k) => !json.answers || !json.answers[k]);
      if (missing.length) throw new JevError(`Jev response is missing answers for: ${missing.join(", ")}`);
      return json;
    }

    const retryable = res.status === 429 || res.status >= 500;
    let detail;
    try { detail = await res.json(); } catch { detail = undefined; }
    lastErr = new JevError(`Jev API returned HTTP ${res.status}`, { status: res.status, detail });
    if (!retryable) throw lastErr;
    if (attempt < retries) {
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      await sleepImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    }
  }
  throw lastErr;
}
