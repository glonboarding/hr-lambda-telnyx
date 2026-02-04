import {
  SecretsManagerClient,
  GetSecretValueCommand
} from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "us-east-1";
const SECRET_ID = process.env.TELNYX_SECRET_ID || "prod/telnyx";

const sm = new SecretsManagerClient({ region: REGION });

// small in-memory cache to reduce Secrets Manager calls
let cache = { value: null, expiresAt: 0 };

export async function getTelnyxSecret() {
  const now = Date.now();
  if (cache.value && now < cache.expiresAt) return cache.value;

  const resp = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const secretString = resp.SecretString || "{}";

  let secret;
  try {
    secret = JSON.parse(secretString);
  } catch {
    // allow plain string secrets too
    secret = { TELNYX_API_KEY: secretString };
  }

  if (!secret.TELNYX_API_KEY) throw new Error("Missing TELNYX_API_KEY in Secrets Manager");

  cache = { value: secret, expiresAt: now + 60_000 }; // 60s TTL
  return secret;
}
