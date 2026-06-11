const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

const logs = [];
function log(level, msg, data = null) {
  const entry = { ts: new Date().toISOString(), level, msg, data: data ? JSON.stringify(data).slice(0,200) : null };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${level}] ${msg}`, data || "");
}

const GROQ_KEY = process.env.GROQ_API_KEY;
const conversationHistory = {};

// ── PROMPT DE CONSÓRCIO ────────────────────────────────────────
const SYSTEM_PROMPT = `Você é um consultor de vendas especialista em consórcio da empresa Contemplax.
Você está fazendo uma ligação telefônica para oferecer consórcio.
Fale sempre em português brasileiro, de forma natural, amigável e profissional.
Não use emojis ou formatação especial — sua resposta será convertida em áudio.
Mantenha respostas curtas (máximo 2 frases) para a conversa fluir naturalmente.

Seu objetivo é:
1. Se apresentar como consultor da Contemplax
2. Perguntar se a pessoa tem interesse em adquirir um bem (imóvel, veículo, etc) sem pagar juros
3. Explicar brevemente como funciona o consórcio: sem juros, só taxa de administração, carta de crédito
4. Tentar agendar uma conversa mais detalhada com um especialista
5. Se a pessoa não tiver interesse, agradecer educadamente e encerrar

Se perguntarem o valor das parcelas, diga que depende do bem desejado e que um especialista pode montar uma simulação gratuita.
Se pedirem para ligar depois, pergunte o melhor horário e agradeça.
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
  const callSid    = req.body.CallSid || "unknown";
  const speech     = req.body.SpeechResult;
  const answeredBy = req.body.AnsweredBy;
  const SERVER_URL = process.env.SERVER_URL || `https://${req.headers.host}`;

  log("INFO", `[VOICE] CallSid=${callSid} | AnsweredBy=${answeredBy} | Speech="${speech}"`);

  // Caixa postal → desliga
  if (answeredBy && answeredBy.startsWith("machine")) {
    log("INFO", "[AMD] Caixa postal detectada — encerrando");
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  if (!conversationHistory[callSid]) {
    conversationHistory[callSid] = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  let responseText = "";

  if (!speech) {
    // Primeira fala — apresentação
    responseText = "Olá, boa tarde! Aqui é o consultor da Contemplax Consórcios. Tudo bem? Tenho uma proposta especial para você adquirir um bem sem pagar juros. Posso te explicar rapidinho?";
    log("INFO", "[VOICE] Saudação inicial de consórcio");
  } else {
    conversationHistory[callSid].push({ role: "user", content: speech });
    log("INFO", `[VOICE] Cliente disse: "${speech}"`);

    if (!GROQ_KEY) {
      responseText = "Desculpe, estamos com uma instabilidade. Posso retornar a ligação mais tarde?";
      log("ERROR", "GROQ_API_KEY ausente");
    } else {
      try {
        responseText = await askGroq(conversationHistory[callSid]);
        conversationHistory[callSid].push({ role: "assistant", content: responseText });
        log("INFO", `[GROQ] Resposta: "${responseText.slice(0, 100)}"`);
      } catch (err) {
        log("ERROR", `[GROQ] Erro: ${err.message}`);
        responseText = "Desculpe, tive um probleminha. Pode repetir?";
      }
    }
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.pt-BR-Wavenet-A" language="pt-BR">${escapeXml(responseText)}</Say>
  <Gather input="speech" action="${SERVER_URL}/voice" method="POST"
          language="pt-BR" speechTimeout="3" timeout="10">
  </Gather>
  <Say voice="Google.pt-BR-Wavenet-A" language="pt-BR">Não ouvi nada. Obrigado e até logo!</Say>
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

app.get("/", (req, res) => res.send("✅ Servidor Twilio + Groq (Consórcio Contemplax) online."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log("INFO", `✅ Servidor rodando na porta ${PORT}`));
