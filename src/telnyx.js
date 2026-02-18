import axios from "axios";

const telnyxRequest = (apiKey, body, path) =>
  axios.post(`https://api.telnyx.com/v2/messages${path}`, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MSG_DELAY_MS = 120;

export async function sendTelnyxMessage({ apiKey, to, from, text, mediaUrls, webhook_url, webhook_failover_url }) {
  const recipients = Array.isArray(to) ? to : [to];

  const buildBody = (singleTo) => {
    const body = { to: singleTo, from, text };
    if (Array.isArray(mediaUrls) && mediaUrls.length > 0) body.media_urls = mediaUrls;
    if (webhook_url) body.webhook_url = webhook_url;
    if (webhook_failover_url) body.webhook_failover_url = webhook_failover_url;
    return body;
  };

  if (recipients.length === 1) {
    return telnyxRequest(apiKey, buildBody(recipients[0]), "");
  }

  const results = [];
  for (let i = 0; i < recipients.length; i++) {
    const resp = await telnyxRequest(apiKey, buildBody(recipients[i]), "");
    results.push(resp.data?.data ?? resp.data);
    if (i < recipients.length - 1) await delay(MSG_DELAY_MS);
  }

  return { data: { messages: results, count: results.length } };
}

/** Group MMS: to must be an array of phone numbers (max 8, US/CAN, long code). */
export async function sendTelnyxGroupMms({ apiKey, to, from, text, mediaUrls }) {
  const body = { to, from, text };

  if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
    body.media_urls = mediaUrls;
  }

  return telnyxRequest(apiKey, body, "/group_mms");
}
