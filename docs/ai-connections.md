# ChatGPT and Claude connection paths

Documentation checked on 6 November 2026. The wallet has one provider-neutral tool schema. No model-provider credential is placed in the contract, browser assets or tool arguments.

## What is implemented and tested

| Path | Current evidence |
| --- | --- |
| Direct JavaScript API | Schema, auth-scope, expiry, rate-limit, encryption, idempotency, restart, error and receipt tests in `tests/protocol.test.mjs` |
| Local MCP stdio | Tools-only protocol `2025-11-25`; deterministic subprocess probe in `services/mcp/scripted-agent.mjs` |
| Live wallet backend through MCP | Not wired; all CLI payment requests fail with `PAYMENT_UNAVAILABLE` |
| ChatGPT product | Documentation verified; not connected or exercised |
| OpenAI Responses API | Configuration example only; no API call made |
| Claude Code / Desktop | Local launch examples only; neither application exercised |
| Claude consumer remote connector | Documentation verified; not connected or exercised |
| Claude Messages API | Configuration example only; no API call made |

Passing the scripted probe does not prove AI interoperability, proof generation or settlement. The inspection process intentionally has no credentials or payment authority.

## Local Claude inspection

Claude Code supports local stdio subprocesses. After checking the absolute Node and project paths, register the inspection server:

```sh
claude mcp add --transport stdio midnight-wallet-inspection -- node /absolute/path/to/repository/services/mcp/stdio.mjs
```

Then inspect `get_wallet_capabilities` with `{"vaultRef":"local-inspection"}`. Its expected `paymentsAvailable` is `false`. The command format is documented by [Claude Code](https://code.claude.com/docs/en/mcp); it was not run against a signed-in Claude Code installation.

Claude Desktop's local `claude_desktop_config.json` mechanism is separate from its cloud-brokered remote connectors. A local configuration shape is:

```json
{
  "mcpServers": {
    "midnight-wallet-inspection": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\absolute\\repository\\services\\mcp\\stdio.mjs"]
    }
  }
}
```

Replace the path before use. Do not place owner seeds or wallet keys in this configuration. Claude's [custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) distinguishes the local Desktop mechanism from remote connectors, which are reached from Anthropic infrastructure. Remote setup and organization permissions must be checked in the actual account; no account entitlement was inspected here.

## ChatGPT product

The current OpenAI guide uses ChatGPT's Plugins page: add a custom MCP server, supply a server URL or supported Secure MCP Tunnel, configure authentication, then install the plugin. It supports Streamable HTTP/SSE and read/write tools subject to permissions and confirmation settings. [Official connection guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).

This repository's stdio inspection entry point is not an HTTP endpoint or a configured tunnel. Do not enter a `localhost` URL and infer that ChatGPT can reach it. Build and test the authenticated adapter before connecting the real wallet. Consumer app support is distinct from OpenAI API support.

Private wallet tools need user authentication. The future adapter must implement MCP-compatible OAuth, verify each token's signature, issuer, audience, expiry and scope, and map it to the fixed server-side vault/agent/deployment scope. Use an established identity provider; do not accept a model-supplied `agentRef` as authority. [OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth).

## API examples for a future authenticated HTTP adapter

These snippets describe configuration fields only. `WALLET_MCP_URL` must be an explicitly configured endpoint, and `WALLET_MCP_ACCESS_TOKEN` must be a scoped agent credential obtained outside the prompt. Neither endpoint nor credentials are created by this code. Select a model supported by the account; no model name or account access is assumed.

OpenAI Responses API:

```js
const tool = {
  type: 'mcp',
  server_label: 'midnight_wallet',
  server_url: process.env.WALLET_MCP_URL,
  authorization: process.env.WALLET_MCP_ACCESS_TOKEN,
  allowed_tools: ['get_wallet_capabilities', 'request_payment', 'get_payment_status'],
  require_approval: 'always',
};
// Supply tool in responses.create({ model, tools: [tool], input }).
```

Responses supports remote Streamable HTTP/SSE and supported secure tunnels. Keep approval handling enabled while validating the integration; a client approval is not contract authorization or proof of finality. [Responses MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

Claude Messages API:

```js
const mcp_servers = [{
  type: 'url', name: 'midnight_wallet',
  url: process.env.WALLET_MCP_URL,
  authorization_token: process.env.WALLET_MCP_ACCESS_TOKEN,
}];
const tools = [{ type: 'mcp_toolset', mcp_server_name: 'midnight_wallet' }];
// Supply both to a Messages request with beta mcp-client-2025-11-20.
```

The connector supports tool calls over remote HTTP transports and bearer-token authentication; it cannot directly launch this stdio process. Its request configuration and beta requirements are described in the [Claude MCP connector guide](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector). Confirmation behavior must be verified separately in the selected application/API flow; no automatic per-payment confirmation is assumed.

## Before enabling an AI payment path

The concrete integration test must exercise authentication, permitted tool discovery, one scoped request, repeated identical requests, changed-payload conflicts, cross-vault rejection, expired credentials, unresolved outcomes and finalized receipt lookup. Record the actual client/version/account path and transaction evidence. Never report a mock receipt or MCP handshake as a real payment. Keep owner administration in a separate interface, and keep policy openings, keys and full spending history out of tool outputs.

The model sees the payment it proposes and its minimal result. The trusted runner/prover sees the private witnesses. MCP schemas and reduced errors do not hide those facts. The [MCP stdio specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) governs transport framing; remote authentication and deployment still require their own implementation and verification.
