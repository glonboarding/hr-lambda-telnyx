import axios from "axios";

export async function sendTelnyxMessage({ apiKey, to, from, text, mediaUrls }) {
  const body = { to, from, text };

  // Telnyx uses media_urls for MMS
  if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
    body.media_urls = mediaUrls;
  }

  return axios.post("https://api.telnyx.com/v2/messages", body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });
}
