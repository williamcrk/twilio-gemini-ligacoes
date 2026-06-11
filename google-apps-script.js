// ============================================================
// COLE ESTE CÓDIGO NO GOOGLE APPS SCRIPT DA SUA PLANILHA
// Planilha precisa ter colunas: A=Nome, B=Telefone, C=Status
// ============================================================

const NETLIFY_URL = "https://twilio-gemini-ligacoes.onrender.com"; // ← substitua pela URL do seu deploy

function ligarParaTodos() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data  = sheet.getDataRange().getValues();
  
  const contacts = [];
  
  for (let i = 1; i < data.length; i++) { // começa na linha 2 (pula cabeçalho)
    const nome     = data[i][0];
    const telefone = data[i][1];
    const status   = data[i][2];
    
    if (!nome || !telefone) continue;
    if (status === "Ligado" || status === "Erro") continue; // pula já processados
    
    contacts.push({ nome: String(nome), telefone: String(telefone) });
  }
  
  if (contacts.length === 0) {
    SpreadsheetApp.getUi().alert("Nenhum contato pendente encontrado!");
    return;
  }
  
  const payload = JSON.stringify({ phones: contacts });
  
  const options = {
    method: "post",
    contentType: "application/json",
    payload: payload,
    muteHttpExceptions: true,
  };
  
  const response = UrlFetchApp.fetch(`${NETLIFY_URL}/dial`, options);
  const result   = JSON.parse(response.getContentText());
  
  // Atualiza status na planilha
  let row = 2;
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0] || !data[i][1]) continue;
    const found = result.results.find(r => r.telefone === String(data[i][1]));
    if (found) {
      const status = found.status === "disparado" ? "Ligando..." : "Erro";
      sheet.getRange(row, 3).setValue(status);
    }
    row++;
  }
  
  SpreadsheetApp.getUi().alert(
    `✅ ${result.results.filter(r => r.status === "disparado").length} ligações disparadas!\n` +
    `❌ ${result.results.filter(r => r.status === "erro").length} erros.`
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📞 Ligações")
    .addItem("Ligar para todos os pendentes", "ligarParaTodos")
    .addToUi();
}
