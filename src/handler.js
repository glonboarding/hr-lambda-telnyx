import { requireInternalAuth } from "./auth.js";
import { getTelnyxSecret } from "./secrets.js";
import { sendTelnyxMessage } from "./telnyx.js";

function resp(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

export const handler = async (event) => {
  try {
    // 1) Auth first (prevents random POST abuse)
    requireInternalAuth(event.headers || {});

    const method = event.requestContext?.http?.method || event.httpMethod || "";
    const path = event.rawPath || event.path || "";

    if (method !== "POST") return resp(405, { ok: false, error: "Method not allowed" });

    const body = event.body ? JSON.parse(event.body) : {};
    const { to, from, text, mediaUrls } = body;

    if (!to || !from || !text) {
      return resp(400, { ok: false, error: "Missing required fields: to, from, text" });
    }

    const isMms = Array.isArray(mediaUrls) && mediaUrls.length > 0;

    // 2) Enforce endpoint expectations
    if (path.endsWith("/sendSMS") && isMms) {
      return resp(400, { ok: false, error: "MMS payload not allowed on /sendSMS (remove mediaUrls)" });
    }
    if (path.endsWith("/sendMMS") && !isMms) {
      return resp(400, { ok: false, error: "mediaUrls[] required for /sendMMS" });
    }

    // 3) Retrieve Telnyx key from Secrets Manager (never stored on Express/Vercel)
    const secret = await getTelnyxSecret();

    // 4) Send message via Telnyx
    const telnyxResp = await sendTelnyxMessage({
      apiKey: secret.TELNYX_API_KEY,
      to,
      from,
      text,
      mediaUrls: isMms ? mediaUrls : undefined
    });

    return resp(200, { ok: true, data: telnyxResp.data });
  } catch (err) {
    // IMPORTANT: do NOT console.log headers or axios error objects (can include auth)
    const status = err.statusCode || err.response?.status || 500;
    const msg = err.response?.status === 401
      ? "Telnyx rejected the API key (invalid, expired, or wrong format in Secrets Manager)"
      : err.message;
    return resp(status, { ok: false, error: msg });
  }
};
