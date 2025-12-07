/**
 * =================================================================================
 * Project: free2gpt-2api (Bun Edition - Debug Enhanced)
 * Version: 2.1.0 (Debug Release)
 * Runtime: Bun v1.0+
 * =================================================================================
 */

import { format } from "util"; // Dùng để format log đẹp hơn nếu cần

// --- [1. Configuration] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_KEY || "sk-free2gpt-dev",
  DEBUG: true, // <--- Bật chế độ debug chi tiết

  UPSTREAM_URL: "https://chat3.free2gpt.com/api/generate",
  ORIGIN: "https://chat3.free2gpt.com",
  
  MODELS: ["free2gpt-general", "gpt-3.5-turbo", "gpt-4o-mini"],
  DEFAULT_MODEL: "free2gpt-general",

  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  ]
};

// --- [2. Logger Helper] ---
function logger(id, type, msg, data = null) {
  if (!CONFIG.DEBUG) return;
  const time = new Date().toISOString().split('T')[1].split('.')[0];
  const color = type === 'ERROR' ? '\x1b[31m' : type === 'INFO' ? '\x1b[36m' : '\x1b[33m'; // Red, Cyan, Yellow
  const reset = '\x1b[0m';
  
  console.log(`${color}[${time}] [${type}] [${id}]${reset} ${msg}`);
  if (data) {
    if (typeof data === 'object') console.log(JSON.stringify(data, null, 2));
    else console.log(data);
  }
}

// --- [3. Utilities] ---
function generateRandomIP() {
  const r = () => Math.floor(Math.random() * 255);
  return `${r()}.${r()}.${r()}.${r()}`;
}

async function generateSignature(timestamp, message) {
  try {
    const secretKey = ""; 
    const data = `${timestamp}:${message}:${secretKey}`;
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    throw new Error(`Signature generation failed: ${e.message}`);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- [4. Core Logic] ---
async function handleChatCompletions(req) {
  const reqId = `req-${Math.random().toString(36).substring(7)}`;
  logger(reqId, 'INFO', '🚀 New Chat Completion Request received');

  try {
    // 1. Parse Input
    const body = await req.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];
    
    logger(reqId, 'DEBUG', `Model: ${body.model} | Msg Count: ${messages.length}`);

    if (!lastMsg || !lastMsg.content) {
      throw new Error("Invalid message format: last message content missing");
    }

    // 2. Prepare Upstream Payload
    const timestamp = Date.now();
    const signature = await generateSignature(timestamp, lastMsg.content);
    logger(reqId, 'DEBUG', `Generated Signature: ${signature.substring(0, 10)}... | Timestamp: ${timestamp}`);

    const payload = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      time: timestamp,
      pass: null,
      sign: signature
    };

    // 3. Prepare Headers with IP Spoofing
    const fakeIp = generateRandomIP();
    const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    
    const headers = {
      "Authority": "chat3.free2gpt.com",
      "Method": "POST",
      "Path": "/api/generate",
      "Scheme": "https",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "text/plain;charset=UTF-8",
      "Origin": CONFIG.ORIGIN,
      "Referer": `${CONFIG.ORIGIN}/`,
      "User-Agent": userAgent,
      "X-Forwarded-For": fakeIp,
      "X-Real-IP": fakeIp,
      "Client-IP": fakeIp,
      "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Priority": "u=1, i"
    };

    logger(reqId, 'INFO', `📡 Sending to Upstream...`, { fakeIp, userAgent });

    // 4. Send Request
    const upstreamRes = await fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    // 5. Check Response Status
    logger(reqId, 'INFO', `⬅️ Upstream Response: ${upstreamRes.status} ${upstreamRes.statusText}`);
    
    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger(reqId, 'ERROR', `Upstream Failed Body:`, errText); // <--- Quan trọng: xem lỗi gì
      
      // Phân tích lỗi để trả về đúng code
      if (upstreamRes.status === 403) return createError(reqId, "Upstream Cloudflare Blocked (403)", 403);
      if (upstreamRes.status === 429) return createError(reqId, "Upstream Rate Limit (429)", 429);
      return createError(reqId, `Upstream Error: ${errText}`, 502);
    }

    // 6. Handle Stream
    logger(reqId, 'INFO', '🟢 Starting Stream Transformation');
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Async worker
    (async () => {
      try {
        const reader = upstreamRes.body.getReader();
        let chunkCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            logger(reqId, 'INFO', `✅ Stream Finished. Total chunks: ${chunkCount}`);
            break;
          }
          
          chunkCount++;
          const textChunk = decoder.decode(value, { stream: true });
          
          // Debug: Log 50 ký tự đầu tiên của chunk để xem có phải HTML hay text
          if (chunkCount <= 3 || CONFIG.DEBUG) {
             logger(reqId, 'STREAM', `Chunk #${chunkCount} (${value.byteLength}b): ${textChunk.substring(0, 100).replace(/\n/g, '\\n')}`);
          }

          // Format OpenAI SSE
          const chunkData = {
            id: reqId,
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

        // End Stream
        await writer.write(encoder.encode(`data: [DONE]\n\n`));
      } catch (streamErr) {
        logger(reqId, 'ERROR', `Stream Broken: ${streamErr.message}`);
        const errChunk = {
          id: reqId,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: `\n[Proxy Error: ${streamErr.message}]` }, finish_reason: "error" }]
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
    logger(reqId, 'ERROR', `Catch-all Error: ${e.message}`);
    return createError(reqId, e.message, 500);
  }
}

// Helper: Trả lỗi JSON chuẩn
function createError(id, msg, status = 500) {
  return new Response(JSON.stringify({
    error: { message: msg, type: 'api_error', code: status, param: id }
  }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// --- [5. Server Entry] ---
console.log(`
  ██████╗ ███████╗███████╗    ██████╗  ██████╗ ██████╗ ████████╗
  ██╔══██╗██╔════╝██╔════╝    ╚════██╗██╔═══██╗██╔══██╗╚══██╔══╝
  ██████╔╝█████╗  █████╗       █████╔╝██║   ██║██████╔╝   ██║   
  ██╔═══╝ ██╔══╝  ██╔══╝      ██╔═══╝ ██║   ██║██╔═══╝    ██║   
  ██║     ███████╗███████╗    ███████╗╚██████╔╝██║        ██║   
  ╚═╝     ╚══════╝╚══════╝    ╚══════╝ ╚═════╝ ╚═╝        ╚═╝   
  -------------------------------------------------------------
  🚀 Port: ${CONFIG.PORT} | 🛠️ Debug: ${CONFIG.DEBUG}
`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    
    const url = new URL(req.url);
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(req);
    
    // Auth logic (nếu cần) có thể thêm ở đây
    
    return new Response("Free2GPT Proxy Ready", { status: 200 });
  }
});
