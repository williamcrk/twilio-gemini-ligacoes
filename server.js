const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

// ── LOG em memória ─────────────────────────────────────────────
const logs = [];
function log(level, msg, data = null) {
  const entry = { ts: new Date().toISOString(), level, msg, data: data ? JSON.stringify(data).slice(0,200) : null };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${level}] ${msg}`, data || "");
}

// ── Groq client ────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) log("WARN", "GROQ_API_KEY não definida!");

const conversationHistory = {};

const SYSTEM_PROMPT = `Você é um assistente de voz amigável falando em português brasileiro.
Você está em uma ligação telefônica. Seja natural, cordial e conciso.
Responda sempre em português, de forma clara e direta.
Não use emojis ou formatação especial — sua resposta será convertida em áudio.
Mantenha respostas curtas (máximo 2 frases) para a conversa fluir naturalmente.
Se a pessoa quiser encerrar, despeça-se educadamente.`;

async function askGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 150,
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data.choices[0].message.content;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── DIAGNÓSTICO ────────────────────────────────────────────────
app.get("/diagnostico", (req, res) => {
  const SERVER_URL = process.env.SERVER_URL || `https://${req.headers.host}`;
  res.json({
    status: "online",
    server_url: SERVER_URL,
    env: {
      GROQ_API_KEY:       GROQ_KEY ? `✅ definida (${GROQ_KEY.slice(0,8)}...)` : "❌ FALTANDO",
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? `✅ ${process.env.TWILIO_ACCOUNT_SID.slice(0,8)}...` : "❌ FALTANDO",
      TWILIO_AUTH_TOKEN:  process.env.TWILIO_AUTH_TOKEN  ? "✅ definido" : "❌ FALTANDO",
      TWILIO_FROM:        process.env.TWILIO_FROM || "❌ FALTANDO",
      SERVER_URL:         process.env.SERVER_URL || `⚠️ usando ${SERVER_URL}`,
    },
    conversasAtivas: Object.keys(conversationHistory).length,
    logs: logs.slice(0, 50),
  });
});

// ── WEBHOOK VOICE ──────────────────────────────────────────────
app.post("/voice", async (req, res) => {
  const callSid      = req.body.CallSid || "unknown";
  const speechResult = req.body.SpeechResult;
  const answeredBy   = req.body.AnsweredBy;
  const SERVER_URL   = process.env.SERVER_URL || `https://${req.headers.host}`;

  log("INFO", `[VOICE] CallSid=${callSid} | AnsweredBy=${answeredBy} | Speech="${speechResult}"`);

  if (answeredBy && answeredBy.startsWith("machine")) {
    log("INFO", `[AMD] Caixa postal — encerrando`);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`);
  }

  if (!conversationHistory[callSid]) {
    conversationHistory[callSid] = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  let responseText = "";

  if (!speechResult) {
    responseText = "Olá! Tudo bem? Sou um assistente virtual. Como posso te ajudar hoje?";
    log("INFO", `[VOICE] Saudação inicial`);
  } else {
    conversationHistory[callSid].push({ role: "user", content: speechResult });
    log("INFO", `[VOICE] Usuário disse: "${speechResult}"`);

    if (!GROQ_KEY) {
      responseText = "Desculpe, o sistema está em manutenção. Tente mais tarde.";
      log("ERROR", "GROQ_API_KEY ausente");
    } else {
      try {
        responseText = await askGroq(conversationHistory[callSid]);
        conversationHistory[callSid].push({ role: "assistant", content: responseText });
        log("INFO", `[GROQ] Resposta: "${responseText.slice(0, 100)}"`);
      } catch (err) {
        log("ERROR", `[GROQ] Erro: ${err.message}`);
        responseText = "Desculpe, tive um problema. Pode repetir?";
      }
    }
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.pt-BR-Wavenet-A" language="pt-BR">${escapeXml(responseText)}</Say>
  <Gather input="speech" action="${SERVER_URL}/voice" method="POST"
          language="pt-BR" speechTimeout="2" timeout="10">
  </Gather>
  <Say voice="Google.pt-BR-Wavenet-A" language="pt-BR">Não ouvi nada. Até logo!</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ── DISPARA LIGAÇÕES ───────────────────────────────────────────
app.post("/dial", async (req, res) => {
  const twilio = require("twilio");
  const SID    = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN  = process.env.TWILIO_AUTH_TOKEN;
  const FROM   = process.env.TWILIO_FROM;
  const SERVER_URL = process.env.SERVER_URL || `https://${req.headers.host}`;

  log("INFO", `[DIAL] SID=${SID?.slice(0,8)} | FROM=${FROM} | URL=${SERVER_URL}`);

  if (!SID || !TOKEN || !FROM) {
    const erro = `Credenciais faltando: ${!SID?"TWILIO_ACCOUNT_SID ":""}${!TOKEN?"TWILIO_AUTH_TOKEN ":""}${!FROM?"TWILIO_FROM":""}`;
    log("ERROR", erro);
    return res.status(500).json({ error: erro });
  }

  const { phones } = req.body;
  if (!phones?.length) return res.status(400).json({ error: "Envie phones: [{nome, telefone}]" });

  const client = twilio(SID, TOKEN);
  const results = [];

  for (const contact of phones) {
    try {
      const call = await client.calls.create({
        to: contact.telefone,
        from: FROM,
        url: `${SERVER_URL}/voice`,
        statusCallback: `${SERVER_URL}/status`,
        statusCallbackMethod: "POST",
        machineDetection: "Enable",
      });
      log("INFO", `[DIAL] ✅ ${contact.nome} → CallSid=${call.sid}`);
      results.push({ ...contact, callSid: call.sid, status: "disparado" });
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      log("ERROR", `[DIAL] ❌ ${contact.telefone}: ${err.message}`, { code: err.code, info: err.moreInfo });
      results.push({ ...contact, status: "erro", erro: err.message, codigo: err.code, detalhes: err.moreInfo || "" });
    }
  }

  res.json({ total: phones.length, results });
});

// ── STATUS ─────────────────────────────────────────────────────
app.post("/status", (req, res) => {
  const { CallSid, CallStatus, To, From, CallDuration, ErrorCode, ErrorMessage } = req.body;
  log(ErrorCode ? "ERROR" : "INFO",
    `[STATUS] ${From}→${To} | ${CallStatus} | ${CallDuration}s | Erro: ${ErrorCode||"nenhum"} ${ErrorMessage||""}`);
  if (["completed","failed","busy","no-answer"].includes(CallStatus)) delete conversationHistory[CallSid];
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("✅ Servidor Twilio + Groq online. /diagnostico para detalhes."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log("INFO", `✅ Servidor rodando na porta ${PORT}`));
