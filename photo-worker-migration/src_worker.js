const WAIT_MS = 60_000;
const RECORDING_MS = 300_000;
const FRAME_INTERVAL_MS = 1_000;
const MAX_FRAMES = 300;
const BATCH_SIZE = 3;
const MAX_FRAME_BYTES = 700_000;
const MAX_BATCH_BYTES = 18_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ success: true, platform: "cloudflare-workers" });
      }
      const match = url.pathname.match(/^\/api\/timelapse\/status\/([a-zA-Z0-9-]+)$/);
      let sessionId;
      if (url.pathname === "/api/timelapse/start" && request.method === "POST") {
        sessionId = crypto.randomUUID();
        const stub = env.TIMELAPSE_SESSIONS.get(env.TIMELAPSE_SESSIONS.idFromName(sessionId));
        return withCors(await stub.fetch("https://do/session/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) }));
      }
      if (url.pathname === "/api/timelapse/begin" && request.method === "POST") {
        const body = await readJson(request);
        sessionId = body?.sessionId;
        return proxySession(env, sessionId, "begin", body);
      }
      if (url.pathname === "/api/timelapse/frame" && request.method === "POST") {
        const body = await readJson(request);
        sessionId = body?.sessionId;
        return proxySession(env, sessionId, "frame", body);
      }
      if (url.pathname === "/api/timelapse/finish" && request.method === "POST") {
        const body = await readJson(request);
        sessionId = body?.sessionId;
        return proxySession(env, sessionId, "finish", body);
      }
      if (match && request.method === "GET") return proxySession(env, match[1], "status");
      return withCors(json({ success: false, error: "Not found" }, 404));
    }
    return env.ASSETS.fetch(request);
  }
};

async function proxySession(env, sessionId, action, body = {}) {
  if (!validId(sessionId)) return withCors(json({ success: false, error: "sessionIdが不正です" }, 400));
  const stub = env.TIMELAPSE_SESSIONS.get(env.TIMELAPSE_SESSIONS.idFromName(sessionId));
  const request = new Request(`https://do/session/${action}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: action === "status" ? undefined : JSON.stringify(body)
  });
  return withCors(await stub.fetch(request));
}

export class TimelapseSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/start") && request.method === "POST") {
      return this.state.blockConcurrencyWhile(async () => {
        const body = await readJson(request);
        const existing = await this.state.storage.get("session");
        if (existing) return json({ success: false, error: "session already exists" }, 409);
        const session = {
          id: body.sessionId || this.state.id.toString(),
          status: "waiting",
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          receivedFrames: 0,
          queuedFrames: 0,
          sentFrames: 0,
          lastFrameNumber: 0
        };
        await this.state.storage.put("session", session);
        return json({
          success: true,
          sessionId: session.id,
          waitMs: WAIT_MS,
          recordingDurationMs: RECORDING_MS,
          frameIntervalMs: FRAME_INTERVAL_MS,
          expectedFrames: MAX_FRAMES,
          batchSize: BATCH_SIZE
        });
      });
    }
    if (path.endsWith("/status") && request.method === "GET") {
      const session = await this.state.storage.get("session");
      if (!session) return json({ success: false, error: "セッションが見つかりません" }, 404);
      return json({ success: true, sessionId: session.id, status: session.status,
        receivedFrames: session.receivedFrames, queuedFrames: session.queuedFrames,
        sentFrames: session.sentFrames });
    }
    if (path.endsWith("/begin") && request.method === "POST") {
      const session = await this.getSession();
      if (!session) return json({ success: false, error: "セッションが見つかりません" }, 404);
      if (session.status !== "waiting") return json({ success: false, error: "撮影開始済みです" }, 409);
      session.startedAt = Date.now();
      session.status = "recording";
      await this.save(session);
      return json({ success: true, message: "撮影を開始しました" });
    }
    if (path.endsWith("/frame") && request.method === "POST") return this.receiveFrame(await readJson(request));
    if (path.endsWith("/finish") && request.method === "POST") return this.finish();
    return json({ success: false, error: "Not found" }, 404);
  }
  async getSession() { return this.state.storage.get("session"); }
  async save(s) { await this.state.storage.put("session", s); }
  async receiveFrame(body) {
    const session = await this.getSession();
    if (!session) return json({ success: false, error: "セッションが見つかりません" }, 404);
    if (session.status !== "recording") return json({ success: false, error: "撮影中のセッションではありません" }, 409);
    const { frameNumber, elapsedMs, image } = body || {};
    if (session.receivedFrames >= MAX_FRAMES) return json({ success: false, error: "フレーム数の上限に達しました" }, 400);
    if (!Number.isInteger(frameNumber) || frameNumber < 1 || frameNumber > MAX_FRAMES) return json({ success: false, error: "frameNumberが不正です" }, 400);
    if (typeof image !== "string" || !image.startsWith("data:image/jpeg;base64,")) return json({ success: false, error: "JPEG画像データが必要です" }, 400);
    if (frameNumber <= session.lastFrameNumber) return json({ success: false, error: "frameNumberが重複しています" }, 409);
    const b64 = image.slice(image.indexOf(",") + 1);
    let raw;
    try { raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return json({ success: false, error: "画像データを読み込めません" }, 400); }
    if (!raw.length) return json({ success: false, error: "画像データが空です" }, 400);
    if (raw.length > MAX_FRAME_BYTES) return json({ success: false, error: "画像サイズが上限を超えています" }, 413);
    session.receivedFrames++;
    session.queuedFrames++;
    session.lastFrameNumber = frameNumber;
    await this.save(session);
    const pending = await this.state.storage.get("pending") || [];
    pending.push({ frameNumber, elapsedMs: Number(elapsedMs) || 0, data: b64 });
    await this.state.storage.put("pending", pending);
    if (pending.length >= BATCH_SIZE) await this.flushBatch();
    return json({ success: true, receivedFrames: session.receivedFrames, queuedFrames: session.queuedFrames });
  }
  async finish() {
    const session = await this.getSession();
    if (!session) return json({ success: false, error: "セッションが見つかりません" }, 404);
    session.finishedAt = Date.now();
    session.status = "sending";
    await this.save(session);
    await this.flushBatch();
    const latest = await this.getSession();
    if (!latest.queuedFrames) latest.status = "completed";
    await this.save(latest);
    return json({ success: true, message: "撮影終了。Discord送信処理を継続しています", receivedFrames: latest.receivedFrames, queuedFrames: latest.queuedFrames });
  }
  async flushBatch() {
    const webhook = this.env.DISCORD_WEBHOOK_URL;
    if (!webhook) return;
    let pending = await this.state.storage.get("pending") || [];
    while (pending.length) {
      const batch = pending.splice(0, BATCH_SIZE);
      await this.state.storage.put("pending", pending);
      const form = new FormData();
      const fileNames = [];
      for (let i = 0; i < batch.length; i++) {
        const bytes = Uint8Array.from(atob(batch[i].data), c => c.charCodeAt(0));
        const name = `frame_${String(batch[i].frameNumber).padStart(4, "0")}.jpg`;
        form.append(`files[${i}]`, new File([bytes], name, { type: "image/jpeg" }));
        fileNames.push(name);
      }
      form.append("payload_json", JSON.stringify({ content: `コマ撮り撮影: ${batch.length}枚 (${fileNames.join(", ")})` }));
      let response;
      try { response = await fetch(webhook, { method: "POST", body: form }); }
      catch (err) { await this.putBack(batch); return; }
      if (!response.ok) { await this.putBack(batch); return; }
      const s = await this.getSession();
      s.sentFrames += batch.length;
      s.queuedFrames = Math.max(0, s.queuedFrames - batch.length);
      if (s.finishedAt && s.queuedFrames === 0) s.status = "completed";
      await this.save(s);
      pending = await this.state.storage.get("pending") || [];
    }
  }
  async putBack(batch) {
    const pending = await this.state.storage.get("pending") || [];
    await this.state.storage.put("pending", [...batch, ...pending]);
  }
}

function validId(id) { return typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id); }
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); }
function corsHeaders() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
function withCors(response) { const headers = new Headers(response.headers); for (const [k,v] of Object.entries(corsHeaders())) headers.set(k,v); return new Response(response.body, { status: response.status, headers }); }