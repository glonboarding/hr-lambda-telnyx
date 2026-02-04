import crypto from "crypto";

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function requireInternalAuth(headers) {
  const auth = headers?.authorization || headers?.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const expected = process.env.INTERNAL_GATEWAY_TOKEN || "";
  if (!expected) throw new Error("INTERNAL_GATEWAY_TOKEN not set");

  if (!token || !timingSafeEqual(token, expected)) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
