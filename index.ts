/**
 * =================================================================================
 * Project: free2gpt-2api (Bun Production Edition)
 * Compatible: OpenAI Standard, Kilo Code, Roo Code, Cline
 * =================================================================================
 */

// --- [1. Configuration] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_KEY: process.env.API_KEY || "sk-free2gpt-key", // Bearer Token
  
  UPSTREAM_URL: "https://chat3.free2gpt.com/api/generate",
  ORIGIN: "https://chat3.free2gpt.com",
  
  // Danh sách model để Agent nhận diện
  MODELS: [
    "free2gpt-general",
    "gpt-3.5-turbo",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-3-5-sonnet" // Alias cho agent thích dùng tên này
  ],
  DEFAULT_MODEL: "free2gpt-general",

  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  ]
};

// --- [2. Helper Functions] ---

// Tạo IP ngẫu nhiên để bypass rate limit
function generateRandomIP() {
  const r = () => Math.floor(Math.random() * 255);
  return `${r()}.${r()}.${r()}.${r()}`;
}

// Tạo chữ ký SHA-256 theo logic upstream
async function generateSignature(timestamp, message) {
  const secretKey = ""; 
  const data = `${timestamp}:${message}:${secretKey}`;
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Headers chuẩn cho CORS và API
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- [3. Core Logic] ---

async function handleChatCompletions(req) {
  try {
    const body = await req.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];
    const isStream = body.stream === true; // Check chính xác boolean

    if (!lastMsg || !lastMsg.content) {
      return new Response(JSON.stringify({ error: { message: "Message content missing", type: "invalid_request_error" } }), { status: 400 });
    }

    // 1. Prepare Upstream Request
    const timestamp = Date.now();
    const signature = await generateSignature(timestamp, lastMsg.content);
    
    // Upstream Payload
    const payload = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      time: timestamp,
      pass: null,
      sign: signature
    };

    // Fake Headers
    const fakeIp = generateRandomIP();
    const headers = {
      "Authority": "chat3.free2gpt.com",
      "Method": "POST",
      "Path": "/api/generate",
      "Scheme": "https",
      "Content-Type": "text/plain;charset=UTF-8",
      "Origin": CONFIG.ORIGIN,
      "Referer": CONFIG.ORIGIN + "/",
      "User-Agent": CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)],
      "X-Forwarded-For": fakeIp,
      "X-Real-IP": fakeIp,
      "Client-IP": fakeIp,
    };

    // 2. Call Upstream
    const upstreamRes = await fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error(`Upstream Error [${upstreamRes.status}]: ${errText}`);
      return new Response(JSON.stringify({ error: { message: `Upstream error: ${errText}`, code: upstreamRes.status } }), { 
        status: 502, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const requestId = `chatcmpl-${crypto.randomUUID()}`;
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const created = Math.floor(Date.now() / 1000);

    // --- CASE A: STREAM MODE (Standard OpenAI SSE) ---
    if (isStream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        try {
          const reader = upstreamRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const textChunk = decoder.decode(value, { stream: true });
            
            // Format chunk chuẩn OpenAI
            const chunkData = {
              id: requestId,
              object: "chat.completion.chunk",
              created: created,
              model: model,
              system_fingerprint: "fp_free2gpt",
              choices: [{
                index: 0,
                delta: { content: textChunk },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`));
          }
          
          // Gửi chunk kết thúc (quan trọng cho Agent biết để dừng)
          const endChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: created,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (e) {
          console.error("Stream Error:", e);
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
    }

    // --- CASE B: NON-STREAM MODE (Buffering for Agents) ---
    else {
      // Upstream trả về stream text, ta phải đọc hết rồi mới trả JSON
      const fullText = await upstreamRes.text(); // Bun tự handle việc đọc stream thành text

      const responseData = {
        id: requestId,
        object: "chat.completion",
        created: created,
        model: model,
        system_fingerprint: "fp_free2gpt",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: fullText
          },
          finish_reason: "stop"
        }],
        // Fake usage để tránh lỗi client validation
        usage: {
          prompt_tokens: JSON.stringify(messages).length, 
          completion_tokens: fullText.length,
          total_tokens: JSON.stringify(messages).length + fullText.length
        }
      };

      return new Response(JSON.stringify(responseData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

  } catch (e) {
    console.error("Internal Error:", e);
    return new Response(JSON.stringify({ error: { message: e.message, type: "internal_error" } }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// --- [4. Server Entry] ---

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Auth Check (Bắt buộc)
    const authHeader = req.headers.get('Authorization');
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    // Allow root & models without auth logic IF needed, but standard safe practice:
    if (url.pathname.startsWith('/v1/') && token !== CONFIG.API_KEY) {
       return new Response(JSON.stringify({ error: { message: "Invalid API Key", type: "auth_error" } }), { 
         status: 401, 
         headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
       });
    }

    // 3. Routing
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return handleChatCompletions(req);
    }

    // Endpoint Models (Các tool rất hay gọi cái này đầu tiên để init)
    if (url.pathname === '/v1/models') {
      return new Response(JSON.stringify({
        object: 'list',
        data: CONFIG.MODELS.map(id => ({
          id: id,
          object: 'model',
          created: 1677610602,
          owned_by: 'openai' // Fake owner để pass filter
        }))
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: "ok", message: "Free2GPT Proxy Active" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders });
  }
});

console.log(`[Free2GPT] Server running on port ${CONFIG.PORT}`);
