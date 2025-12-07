/**
 * =================================================================================
 * Project: free2gpt-2api (Bun Edition)
 * Version: 2.0.0 (Refactored by CezDev)
 * Runtime: Bun v1.0+
 * Description: High-performance OpenAI-compatible API gateway with IP rotation.
 * =================================================================================
 */

// --- [1. Configuration & Env] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_KEY || "sk-free2gpt-dev", // Mặc định để dev, production nên đổi
  
  // Upstream Configuration
  UPSTREAM_ORIGIN: "https://chat3.free2gpt.com",
  UPSTREAM_API_URL: "https://chat3.free2gpt.com/api/generate",
  
  // Models Logic
  DEFAULT_MODEL: "free2gpt-general",
  MODELS: [
    "free2gpt-general",
    "gpt-3.5-turbo",
    "gpt-4o-mini"
  ],

  // Fingerprint Rotation
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  ]
};

// --- [2. Helper: Random IP Generator] ---
function generateRandomIP() {
  const part = () => Math.floor(Math.random() * 256);
  // Tránh các dải IP private/reserved cơ bản nếu cần thiết, 
  // nhưng random thuần túy thường đủ để bypass rate limit đơn giản.
  return `${part()}.${part()}.${part()}.${part()}`;
}

// --- [3. Helper: Signature Generator] ---
async function generateSignature(timestamp, message) {
  const secretKey = ""; 
  const data = `${timestamp}:${message}:${secretKey}`;
  
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- [4. Helper: Response Utils] ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function createError(msg, status = 500, code = 'internal_error') {
  return new Response(JSON.stringify({ 
    error: { message: msg, type: 'api_error', code } 
  }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// --- [5. Core Logic] ---
async function handleChatCompletions(req) {
  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  
  try {
    const body = await req.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];

    if (!lastMsg || !lastMsg.content) {
      return createError("Invalid message format: content required", 400, 'invalid_request_error');
    }

    // Prepare Upstream Payload
    const timestamp = Date.now();
    const signature = await generateSignature(timestamp, lastMsg.content);
    
    const payload = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      time: timestamp,
      pass: null,
      sign: signature
    };

    // Fake IP Generation
    const fakeIp = generateRandomIP();
    const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];

    // Upstream Headers
    const headers = {
      "Authority": "chat3.free2gpt.com",
      "Method": "POST",
      "Path": "/api/generate",
      "Scheme": "https",
      "Accept": "*/*",
      "Content-Type": "text/plain;charset=UTF-8",
      "Origin": CONFIG.UPSTREAM_ORIGIN,
      "Referer": `${CONFIG.UPSTREAM_ORIGIN}/`,
      "User-Agent": userAgent,
      // IP Spoofing Headers
      "X-Forwarded-For": fakeIp,
      "X-Real-IP": fakeIp,
      "Client-IP": fakeIp,
      // Browser Impersonation
      "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Priority": "u=1, i"
    };

    console.log(`[Proxy] ${requestId} -> Upstream | FakeIP: ${fakeIp}`);

    const upstreamRes = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error(`[Upstream Error] ${upstreamRes.status}: ${errText}`);
      return createError(`Upstream error: ${upstreamRes.status}`, 502, 'bad_gateway');
    }

    // Stream Transformation (Raw Text -> OpenAI SSE)
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Async processing to not block the return
    (async () => {
      try {
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const textChunk = decoder.decode(value, { stream: true });
          
          // OpenAI Chunk Format
          const chunkData = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model || CONFIG.DEFAULT_MODEL,
            choices: [{
              index: 0,
              delta: { content: textChunk },
              finish_reason: null
            }]
          };
          
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`));
        }

        // Final Chunk
        const endChunk = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model || CONFIG.DEFAULT_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        console.error(`[Stream Error] ${e.message}`);
        const errChunk = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model || CONFIG.DEFAULT_MODEL,
          choices: [{ index: 0, delta: { content: `\n[Error: ${e.message}]` }, finish_reason: "error" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });

  } catch (e) {
    return createError(e.message);
  }
}

// --- [6. Bun Server Entry] ---
console.log(`🚀 Free2GPT API running on port ${CONFIG.PORT}`);
console.log(`🔑 Master Key: ${CONFIG.API_MASTER_KEY.slice(0, 4)}***`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth Check
    const authHeader = req.headers.get('Authorization');
    const providedKey = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    // Allow root check for health, but protect API
    if (url.pathname !== '/' && providedKey !== CONFIG.API_MASTER_KEY) {
      return createError('Unauthorized', 401, 'unauthorized');
    }

    // Routing
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return handleChatCompletions(req);
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return new Response(JSON.stringify({
        object: 'list',
        data: CONFIG.MODELS.map(id => ({
          id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'free2gpt'
        }))
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: "ok", service: "free2gpt-2api-bun" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return createError('Not Found', 404, 'not_found');
  }
});
