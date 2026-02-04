# Telnyx SMS/MMS Gateway

AWS SAM project that exposes API Gateway endpoints for sending SMS and MMS via [Telnyx](https://telnyx.com). Your Express (or other) server forwards requests to this gateway; the Lambda validates an internal token, fetches the Telnyx API key from AWS Secrets Manager, and sends the message.

## Architecture

```
Express/Vercel Server
        │
        │  POST /sendSMS or /sendMMS
        │  Authorization: Bearer <INTERNAL_GATEWAY_TOKEN>
        ▼
   API Gateway (HTTP API)
        │
        ▼
   Lambda (SendFunction)
        │
        ├── auth.js      → Validates internal token
        ├── secrets.js   → Fetches TELNYX_API_KEY from Secrets Manager
        └── telnyx.js    → Sends SMS/MMS via Telnyx API
```

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [AWS CLI](https://aws.amazon.com/cli/) (configured with credentials)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

## Project Structure

```
.
├── template.yaml       # SAM template (API Gateway + Lambda + IAM)
├── package.json        # Dependencies (AWS SDK, axios)
├── samconfig.toml      # SAM deploy config (gitignored; copy from samconfig.toml.example)
└── src/
    ├── handler.js      # Lambda entry: routes /sendSMS and /sendMMS
    ├── auth.js         # Bearer token validation (blocks random callers)
    ├── secrets.js      # Fetches TELNYX_API_KEY from Secrets Manager (60s TTL cache)
    └── telnyx.js       # Sends messages via Telnyx API
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the Telnyx secret in Secrets Manager

Store your Telnyx API key in AWS Secrets Manager before deploying:

```bash
aws secretsmanager create-secret \
  --name Telnyx-1 \
  --secret-string "YOUR_TELNYX_API_KEY"
```

Or as JSON:

```bash
aws secretsmanager create-secret \
  --name Telnyx-1 \
  --secret-string '{"TELNYX_API_KEY":"YOUR_TELNYX_API_KEY"}'
```

### 3. Configure deploy (optional)

Copy `samconfig.toml.example` to `samconfig.toml` and replace `REPLACE_WITH_YOUR_TOKEN` with your internal gateway token. (`samconfig.toml` is gitignored because it contains secrets.)

### 4. Build and deploy

```bash
sam build
sam deploy --guided
```

Or if you have `samconfig.toml` configured:

```bash
sam build
sam deploy
```

When prompted (or in `samconfig.toml`), set `InternalGatewayToken` to a shared secret your Express server will use in the `Authorization: Bearer` header.

## API Endpoints

| Method | Path      | Payload                                                                 | Description |
|--------|-----------|-------------------------------------------------------------------------|-------------|
| POST   | /sendSMS  | `{ "to", "from", "text" }`                                              | Send SMS only. `mediaUrls` not allowed. |
| POST   | /sendMMS  | `{ "to", "from", "text", "mediaUrls": ["https://..."] }`                 | Send MMS. `mediaUrls[]` required. |

**Headers:** `Authorization: Bearer <INTERNAL_GATEWAY_TOKEN>`

**Example (SMS):**
```bash
curl -X POST https://<API_ID>.execute-api.us-east-1.amazonaws.com/sendSMS \
  -H "Authorization: Bearer your-internal-token" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","from":"+15559876543","text":"Hello from Lambda"}'
```

**Example (MMS):**
```bash
curl -X POST https://<API_ID>.execute-api.us-east-1.amazonaws.com/sendMMS \
  -H "Authorization: Bearer your-internal-token" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","from":"+15559876543","text":"Check this out","mediaUrls":["https://example.com/image.jpg"]}'
```

## Security

- **Internal token:** Only requests with the correct `Authorization: Bearer` token are accepted.
- **Telnyx key:** Stored in Secrets Manager; never in your Express app or Vercel env.
- **Timing-safe comparison:** Token validation uses `crypto.timingSafeEqual` to avoid timing attacks.

## Outputs

After deploy, `ApiUrl` is printed. Use it as the base URL for `/sendSMS` and `/sendMMS`.
