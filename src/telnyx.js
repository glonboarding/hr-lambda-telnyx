import axios from "axios";

const telnyxRequest = (apiKey, body, path) =>
  axios.post(`https://api.telnyx.com/v2/messages${path}`, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });

export async function sendTelnyxMessage({ apiKey, to, from, text, mediaUrls, webhook_url, webhook_failover_url }) {
  const body = { to, from, text };

  // Telnyx uses media_urls for MMS
  if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
    body.media_urls = mediaUrls;
  }
  if (webhook_url) body.webhook_url = webhook_url;
  if (webhook_failover_url) body.webhook_failover_url = webhook_failover_url;

  return telnyxRequest(apiKey, body, "");
}

/** Group MMS: to must be an array of phone numbers (max 8, US/CAN, long code). */
export async function sendTelnyxGroupMms({ apiKey, to, from, text, mediaUrls }) {
  const body = { to, from, text };

  if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
    body.media_urls = mediaUrls;
  }

  return telnyxRequest(apiKey, body, "/group_mms");
}
