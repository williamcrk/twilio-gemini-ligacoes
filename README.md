# 📞 Sistema de Ligações Automáticas — Twilio + Gemini

## Arquitetura
```
Google Sheets → Apps Script → Netlify Function (dial.js)
                                      ↓
                              Twilio (faz a ligação)
                                      ↓
                          Netlify Function (voice.js)
                                      ↓
                            Gemini 1.5 Flash (conversa)
```

## Deploy no Netlify

### 1. Suba para o GitHub
```bash
git init
git add .
git commit -m "twilio gemini ligacoes"
git remote add origin https://github.com/SEU_USUARIO/twilio-gemini
git push -u origin main
```

### 2. Conecte no Netlify
1. Acesse netlify.com → New site from Git
2. Selecione seu repositório
3. Build command: `npm install`
4. Publish directory: `public`
5. Clique em **Deploy**

### 3. Configure as variáveis de ambiente
No painel Netlify → Site settings → Environment variables, adicione:

| Variável | Valor |
|----------|-------|
| `GEMINI_API_KEY` | AIzaSyADlkH_kU-4ihh5UuXq3gZrLK-w4Ug6vBY |
| `TWILIO_ACCOUNT_SID` | ACxxxxxxxx... |
| `TWILIO_AUTH_TOKEN` | seu token |
| `TWILIO_FROM` | +15551234567 |
| `NETLIFY_URL` | https://twilio-gemini-ligacoes.onrender.com |

### 4. Configure o Google Apps Script
1. Abra sua planilha Google Sheets
2. Menu → Extensões → Apps Script
3. Cole o conteúdo de `google-apps-script.js`
4. Substitua `NETLIFY_URL` pela URL do seu deploy
5. Salve e execute `onOpen` uma vez para criar o menu

### 5. Configure o Twilio (webhook)
No painel Twilio → Phone Numbers → seu número:
- Voice webhook: `https://twilio-gemini-ligacoes.onrender.com/.netlify/functions/voice`
- Método: POST

## Uso
1. Preencha a planilha com Nome (col A) e Telefone (col B) no formato E.164 (+5511999990000)
2. Use o menu "📞 Ligações" → "Ligar para todos os pendentes"
3. OU acesse o painel web em https://twilio-gemini-ligacoes.onrender.com

## Estrutura de arquivos
```
├── netlify/functions/
│   ├── voice.js          ← webhook Twilio + Gemini
│   ├── dial.js           ← dispara as ligações
│   └── status.js         ← status das chamadas (AMD)
├── public/
│   └── index.html        ← painel web
├── google-apps-script.js ← código para o Apps Script
├── netlify.toml
└── package.json
```
