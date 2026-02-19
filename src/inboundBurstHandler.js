/**
 * Handles Telnyx inbound webhook for burst/SMS replies.
 * Telnyx calls POST /inbound-burst when a user responds to a message.
 *
 * Flow:
 * 1. If outbound, ignore. If inbound, insert into lead_texts.
 * 2. If message is STOP/END → set lead.opt_in = false and done.
 * 3. Look up lead by incoming number. If opt_in is false or true → done (no auto-reply).
 * 4. If opt_in is null: set opt_in = true, get reply_message from lead_text_prompt, insert outbound row, send via /sendSMS.
 */

import { createClient } from "@supabase/supabase-js";
import axios from "axios";

function resp(statusCode, body = "") {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

function getApiUrl(event) {
  const requestContext = event.requestContext || {};
  const domainName = requestContext.domainName || requestContext.domain?.name;
  const apiId = requestContext.apiId || requestContext.api?.id;
  const region = process.env.AWS_REGION || requestContext.region || "us-east-1";
  if (domainName) return `https://${domainName}`;
  if (apiId) return `https://${apiId}.execute-api.${region}.amazonaws.com`;
  return null;
}

const STOP_KEYWORDS = ["stop", "end"];

function isOptOutMessage(text) {
  const t = (text || "").trim().toLowerCase();
  return STOP_KEYWORDS.some((k) => t === k);
}

export const handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || "";
    if (method !== "POST") {
      console.warn("[inbound-burst] Method not allowed", { method });
      return resp(405, JSON.stringify({ error: "Method not allowed" }));
    }

    const rawBody = event.body;
    if (!rawBody) {
      console.warn("[inbound-burst] Empty body");
      return resp(400, JSON.stringify({ error: "Empty body" }));
    }

    const payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const data = payload?.data;
    const eventType = data?.event_type;
    const webhookPayload = data?.payload;

    const direction = webhookPayload?.direction;
    if (direction === "outbound") {
      console.log("[inbound-burst] Ignoring outbound message");
      return resp(200, JSON.stringify({ received: true }));
    }

    // Telnyx may send to/from as object, array of objects, or string
    const fromNumber =
      webhookPayload?.from?.phone_number ??
      (Array.isArray(webhookPayload?.from) ? webhookPayload.from[0]?.phone_number : null) ??
      (typeof webhookPayload?.from === "string" ? webhookPayload.from : null);
    const toNumber =
      webhookPayload?.to?.phone_number ??
      (Array.isArray(webhookPayload?.to) ? webhookPayload.to[0]?.phone_number : null) ??
      (typeof webhookPayload?.to === "string" ? webhookPayload.to : null);
    const text = webhookPayload?.text ?? "";
    const messageId = webhookPayload?.id ?? data?.id;

    console.log("[inbound-burst] Webhook received", {
      event_type: eventType,
      from: fromNumber,
      to: toNumber,
      direction
    });

    if (!toNumber) {
      console.warn("[inbound-burst] Missing Telnyx number (to); payload.to shape:", JSON.stringify(webhookPayload?.to));
    }
    if (!fromNumber) {
      console.warn("[inbound-burst] Missing sender number (from); payload.from shape:", JSON.stringify(webhookPayload?.from));
    }

    if (eventType !== "message.received") {
      console.log("[inbound-burst] Ignoring non-message event", { event_type: eventType });
      return resp(200, JSON.stringify({ received: true }));
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const token = process.env.INTERNAL_GATEWAY_TOKEN;

    if (!supabaseUrl || !supabaseKey || !token) {
      console.error("[inbound-burst] Misconfigured: missing env");
      return resp(500, JSON.stringify({ error: "Internal error" }));
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Look up lead by incoming number (the person who sent the message)
    const { data: leads, error: leadError } = await supabase
      .from("leads")
      .select("id, org_id, opt_in")
      .eq("phone", fromNumber)
      .limit(1);

    if (leadError) {
      console.error("[inbound-burst] Lead lookup failed", { error: leadError.message });
      return resp(500, JSON.stringify({ error: "Internal error" }));
    }

    const lead = leads?.[0];
    if (!lead) {
      console.warn("[inbound-burst] No lead found for number", { number: fromNumber });
      return resp(200, JSON.stringify({ received: true }));
    }

    const { id: lead_id, org_id } = lead;

    if (!toNumber) {
      console.error("[inbound-burst] Cannot insert lead_texts: from_number (Telnyx number) is missing in webhook");
      return resp(200, JSON.stringify({ received: true }));
    }

    // 1. Insert inbound row into lead_texts (always for inbound)
    const { error: insertInboundError } = await supabase.from("lead_texts").insert({
      org_id,
      number: fromNumber,
      from_number: toNumber,
      message: text,
      direction: "inbound",
      status: "received",
      telnyx_message_id: messageId ?? null,
      error: null,
      lead_id
    });

    if (insertInboundError) {
      console.error("[inbound-burst] Insert inbound lead_texts failed", { error: insertInboundError.message });
      return resp(500, JSON.stringify({ error: "Internal error" }));
    }

    // 2a. STOP/END → opt_out and skip rest
    if (isOptOutMessage(text)) {
      await supabase.from("leads").update({ opt_in: false }).eq("id", lead_id);
      console.log("[inbound-burst] Opt-out processed", { lead_id });
      return resp(200, JSON.stringify({ received: true }));
    }

    // 2b. If opt_in is false or true, skip auto-reply
    if (lead.opt_in === false || lead.opt_in === true) {
      console.log("[inbound-burst] Lead already has opt_in set", { lead_id, opt_in: lead.opt_in });
      return resp(200, JSON.stringify({ received: true }));
    }

    // 2c. Set opt_in = true
    await supabase.from("leads").update({ opt_in: true }).eq("id", lead_id);

    // 2d. Get reply_message from lead_text_prompt (by org_id)
    const { data: prompts, error: promptError } = await supabase
      .from("lead_text_prompt")
      .select("reply_message")
      .eq("org_id", org_id)
      .limit(1);

    if (promptError || !prompts?.[0]?.reply_message) {
      console.warn("[inbound-burst] No reply_message for org", { org_id });
      return resp(200, JSON.stringify({ received: true }));
    }

    const reply_message = prompts[0].reply_message;

    // 2e. Insert outbound row (status queued; we'll update after send)
    const { data: outboundRow, error: outboundInsertError } = await supabase
      .from("lead_texts")
      .insert({
        org_id,
        number: fromNumber,
        from_number: toNumber,
        message: reply_message,
        direction: "outbound",
        status: "queued",
        telnyx_message_id: null,
        error: null,
        lead_id
      })
      .select("id")
      .single();

    if (outboundInsertError || !outboundRow?.id) {
      console.error("[inbound-burst] Insert outbound lead_texts failed", { error: outboundInsertError?.message });
      return resp(500, JSON.stringify({ error: "Internal error" }));
    }

    // 3. Send via first lambda (/sendSMS)
    const apiUrl = getApiUrl(event);
    if (!apiUrl) {
      console.error("[inbound-burst] Could not determine API URL");
      await supabase
        .from("lead_texts")
        .update({ status: "failed", error: "Could not determine API URL" })
        .eq("id", outboundRow.id);
      return resp(500, JSON.stringify({ error: "Internal error" }));
    }

    try {
      const res = await axios.post(
        `${apiUrl}/sendSMS`,
        { to: fromNumber, from: toNumber, text: reply_message },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 15000
        }
      );

      const ok = res.data?.ok === true;
      const msgData = res.data?.data;
      const telnyxId = msgData?.data?.id ?? msgData?.id ?? msgData?.messages?.[0]?.id ?? null;

      if (ok) {
        await supabase
          .from("lead_texts")
          .update({ status: "sent", telnyx_message_id: telnyxId, error: null })
          .eq("id", outboundRow.id);
        await supabase
          .from("leads")
          .update({ message_status: "sent" })
          .eq("id", lead_id)
          .eq("message_status", "queued");
        console.log("[inbound-burst] Auto-reply sent", { lead_text_id: outboundRow.id, telnyx_message_id: telnyxId });
      } else {
        await supabase
          .from("lead_texts")
          .update({ status: "failed", telnyx_message_id: null, error: res.data?.error ?? "Unknown error" })
          .eq("id", outboundRow.id);
        console.warn("[inbound-burst] Auto-reply send failed", { lead_text_id: outboundRow.id, error: res.data?.error });
      }
    } catch (err) {
      const errMsg = err.response?.data?.error ?? err.message ?? "Request failed";
      await supabase
        .from("lead_texts")
        .update({ status: "failed", telnyx_message_id: null, error: errMsg })
        .eq("id", outboundRow.id);
      console.error("[inbound-burst] Auto-reply request failed", { lead_text_id: outboundRow.id, error: errMsg });
    }

    return resp(200, JSON.stringify({ received: true }));
  } catch (err) {
    console.error("[inbound-burst] Handler error", { error: err.message });
    return resp(500, JSON.stringify({ error: "Internal error" }));
  }
};
