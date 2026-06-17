const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const VAPID_PUBLIC_KEY = "BJxsWmFmCoxLeHMNqdi6cPObz31k2HSbF-xsOQW1yd9z_DAkOaJRRzjEtR7hgdzC8VyvdqunslM48ehpDT1vNX0";
const VAPID_PRIVATE_KEY = "_TuWL5eThYKBcb_Y5bAVcfHyDjS693nxuUggXUceVQA";
const VAPID_PUBLIC_X = "nGxaYWYKjEt4cw2p2Lpw85vPfWTYdJsX7Gw5BbXJ33M";
const VAPID_PUBLIC_Y = "_DAkOaJRRzjEtR7hgdzC8VyvdqunslM48ehpDT1vNX0";
const CALL_PREFIX = "__lcc_call_signal__";
const ROOM_KEY = "room:main";
const PUSH_KEY = "push:subscriptions";

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const stored = await env.CHAT_KV.get(ROOM_KEY);
    let messages = stored ? JSON.parse(stored) : [];

    if (action === "vapidPublicKey") return json({ publicKey: VAPID_PUBLIC_KEY });

    if (action === "subscribe") {
      const body = await req.json();
      const all = await getSubscriptions(env);
      const filtered = all.filter(s => s.endpoint !== body.subscription?.endpoint);
      filtered.push({ user: body.user || "", subscription: body.subscription, time: Date.now() });
      await env.CHAT_KV.put(PUSH_KEY, JSON.stringify(filtered.slice(-500)));
      return new Response("subscribed", { headers: cors });
    }

    if (action === "send") {
      const m = await req.json();
      if (m.imageData && m.imageData.length > 2_800_000) return new Response("image too large", { status: 413, headers: cors });
      const msg = {
        id: crypto.randomUUID(), user: m.user, text: m.text || "", avatar: m.avatar || null,
        imageData: m.imageData || null, imageType: m.imageType || null,
        privateTo: m.privateTo || null, private: !!m.privateTo, time: Date.now(),
        deleted: false, edited: false, reactions: {}
      };
      messages.push(msg);
      if (messages.length > 200) messages = messages.slice(-200);
      await env.CHAT_KV.put(ROOM_KEY, JSON.stringify(messages));
      await notifySubscribers(env, msg);
      return new Response("ok", { headers: cors });
    }

    if (action === "edit") {
      const { id, user, admin, text } = await req.json();
      const msg = messages.find(m => m.id === id);
      if (!msg) return new Response("not found", { status: 404, headers: cors });
      if (msg.user === user || admin === true) {
        msg.text = text || ""; msg.edited = true;
        await env.CHAT_KV.put(ROOM_KEY, JSON.stringify(messages));
        return new Response("edited", { headers: cors });
      }
      return new Response("forbidden", { status: 403, headers: cors });
    }

    if (action === "react" || action === "unreact") {
      const { id, emoji } = await req.json();
      const msg = messages.find(m => m.id === id);
      if (msg && !msg.deleted && emoji) {
        msg.reactions ||= {};
        if (action === "react") msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
        else if (msg.reactions[emoji]) { msg.reactions[emoji] -= 1; if (msg.reactions[emoji] <= 0) delete msg.reactions[emoji]; }
        await env.CHAT_KV.put(ROOM_KEY, JSON.stringify(messages));
      }
      return new Response("ok", { headers: cors });
    }

    if (action === "delete") {
      const { id, user, admin } = await req.json();
      const msg = messages.find(m => m.id === id);
      if (!msg) return new Response("not found", { status: 404, headers: cors });
      if (msg.user === user || admin === true) {
        msg.deleted = true;
        await env.CHAT_KV.put(ROOM_KEY, JSON.stringify(messages));
        return new Response("deleted", { headers: cors });
      }
      return new Response("forbidden", { status: 403, headers: cors });
    }

    const viewer = (url.searchParams.get("user") || "").toLowerCase();
    const isAdmin = url.searchParams.get("admin") === "true";
    const now = Date.now();
    messages = messages.filter(m => {
      if (typeof m.text !== "string" || !m.text.startsWith(CALL_PREFIX)) return true;
      try { const signal = JSON.parse(m.text.slice(CALL_PREFIX.length)); return !(signal.type === "ring" && now - (signal.time || m.time || 0) > 30000); }
      catch { return true; }
    });
    await env.CHAT_KV.put(ROOM_KEY, JSON.stringify(messages));
    const visible = messages.filter(m => !m.privateTo || isAdmin || (m.user || "").toLowerCase() === viewer || (m.privateTo || "").toLowerCase() === viewer);
    return json(visible);
  }
};

function json(value) { return new Response(JSON.stringify(value), { headers: { ...cors, "Content-Type": "application/json" } }); }
async function getSubscriptions(env) { const raw = await env.CHAT_KV.get(PUSH_KEY); return raw ? JSON.parse(raw) : []; }
async function notifySubscribers(env, msg) {
  const all = await getSubscriptions(env);
  const target = (msg.privateTo || "").toLowerCase();
  const payload = { title: msg.text?.startsWith(CALL_PREFIX) ? "📞 lcc-chat call" : `💬 ${msg.user}`, body: msg.text?.startsWith(CALL_PREFIX) ? `${msg.user} is calling` : (msg.text || "Sent an image"), type: msg.text?.startsWith(CALL_PREFIX) ? "call" : "message", url: "/" };
  await Promise.all(all.filter(s => !target || (s.user || "").toLowerCase() === target).map(s => sendWebPush(s.subscription, payload).catch(() => null)));
}
async function sendWebPush(subscription, payload) {
  if (!subscription?.endpoint) return;
  const jwt = await createVapidJwt(new URL(subscription.endpoint).origin);
  return fetch(subscription.endpoint, { method: "POST", headers: { "TTL": "60", "Content-Type": "application/json", "Authorization": `WebPush ${jwt}`, "Crypto-Key": `p256ecdsa=${VAPID_PUBLIC_KEY}` }, body: JSON.stringify(payload) });
}
async function createVapidJwt(aud) {
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: "mailto:lcc-chat@example.com" }));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: VAPID_PRIVATE_KEY, x: VAPID_PUBLIC_X, y: VAPID_PUBLIC_Y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]).catch(() => null);
  if (!key) return `${header}.${body}.`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}
function b64url(v) {
  const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v);
  let s = ""; bytes.forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
