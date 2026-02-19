import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import { requireInternalAuth } from "./auth.js";

const MSG_DELAY_MS = 150;

function resp(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const handler = async (event) => {
  try {
    requireInternalAuth(event.headers || {});

    const method = event.requestContext?.http?.method || event.httpMethod || "";
    if (method !== "POST") {
      console.warn("[sendBurstSMS] Method not allowed", { method });
      return resp(405, { ok: false, error: "Method not allowed" });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { org_id } = body;

    if (!org_id) {
      console.warn("[sendBurstSMS] Missing org_id");
      return resp(400, { ok: false, error: "Missing required field: org_id" });
    }

    console.log("[sendBurstSMS] Start", { org_id });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const token = process.env.INTERNAL_GATEWAY_TOKEN;

    if (!supabaseUrl || !supabaseKey || !token) {
      console.error("[sendBurstSMS] Misconfigured: missing env (SUPABASE_URL, SUPABASE_SERVICE_KEY, or INTERNAL_GATEWAY_TOKEN)");
      return resp(500, { ok: false, error: "Burst handler misconfigured (missing env)" });
    }

    // Construct API URL from the API Gateway event context
    const requestContext = event.requestContext || {};
    // For HTTP API v2, domainName is available directly
    const domainName = requestContext.domainName || requestContext.domain?.name;
    const apiId = requestContext.apiId || requestContext.api?.id;
    const region = process.env.AWS_REGION || requestContext.region || "us-east-1";
    
    const apiUrl = domainName 
      ? `https://${domainName}`
      : apiId 
        ? `https://${apiId}.execute-api.${region}.amazonaws.com`
        : null;

    if (!apiUrl) {
      console.error("[sendBurstSMS] Could not determine API URL from event context", {
        hasDomainName: !!domainName,
        hasApiId: !!apiId
      });
      return resp(500, { ok: false, error: "Could not determine API Gateway URL from event context" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: rows, error: queryError } = await supabase
      .from("lead_texts")
      .select("id, lead_id, number, from_number, message")
      .eq("org_id", org_id)
      .eq("direction", "outbound")
      .eq("status", "queued");

    if (queryError) {
      console.error("[sendBurstSMS] Supabase query failed", { org_id, error: queryError.message });
      return resp(500, { ok: false, error: `Supabase query failed: ${queryError.message}` });
    }

    if (!rows || rows.length === 0) {
      console.log("[sendBurstSMS] No queued texts to send", { org_id, count: 0 });
      return resp(200, { ok: true, data: { processed: 0, sent: 0, failed: 0 } });
    }

    console.log("[sendBurstSMS] Queued rows found", { org_id, count: rows.length });

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const payload = {
        to: row.number,
        from: row.from_number,
        text: row.message
      };

      try {
        const res = await axios.post(`${apiUrl}/sendSMS`, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 20000
        });

        const ok = res.data?.ok === true;
        const msgData = res.data?.data;
        const telnyxId = msgData?.data?.id ?? msgData?.id ?? msgData?.messages?.[0]?.id ?? null;

        if (ok) {
          sent++;
          console.log("[sendBurstSMS] Sent", { lead_text_id: row.id, to: row.number, telnyx_message_id: telnyxId });
          await supabase
            .from("lead_texts")
            .update({
              status: "sent",
              telnyx_message_id: telnyxId,
              error: null
            })
            .eq("id", row.id);
          if (row.lead_id) {
            await supabase
              .from("leads")
              .update({ message_status: "sent" })
              .eq("id", row.lead_id)
              .eq("message_status", "queued");
          }
        } else {
          failed++;
          const err = res.data?.error ?? "Unknown error";
          console.warn("[sendBurstSMS] Send failed (API)", { lead_text_id: row.id, to: row.number, error: err });
          await supabase
            .from("lead_texts")
            .update({
              status: "failed",
              telnyx_message_id: null,
              error: err
            })
            .eq("id", row.id);
        }
      } catch (err) {
        failed++;
        const errMsg = err.response?.data?.error ?? err.message ?? "Request failed";
        console.warn("[sendBurstSMS] Send failed (exception)", { lead_text_id: row.id, to: row.number, error: errMsg });
        await supabase
          .from("lead_texts")
          .update({
            status: "failed",
            telnyx_message_id: null,
            error: errMsg
          })
          .eq("id", row.id);
      }

      if (i < rows.length - 1) await delay(MSG_DELAY_MS);
    }

    console.log("[sendBurstSMS] Complete", { org_id, processed: rows.length, sent, failed });
    return resp(200, {
      ok: true,
      data: { processed: rows.length, sent, failed }
    });
  } catch (err) {
    const status = err.statusCode || err.response?.status || 500;
    console.error("[sendBurstSMS] Handler error", { error: err.message, status });
    return resp(status, { ok: false, error: err.message });
  }
};
