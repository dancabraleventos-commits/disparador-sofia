/**
 * Disparador Sofia — Railway Service
 *
 * Substitui o workflow N8N "Disparador Sofia — 1 lead por vez"
 * Intervalo de 10 minutos entre cada envio.
 * Limite de 40 leads por dia (reseta à meia-noite).
 * Só dispara em horário comercial: Seg-Sáb, 8h-17h (horário de SP)
 */

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'Sofia',
  SOFIA_URL: process.env.SOFIA_URL,
  INTERVALO_MS: parseInt(process.env.INTERVALO_MS || '600000'), // 10 minutos
  LIMITE_DIARIO: parseInt(process.env.LIMITE_DIARIO || '40'),
};

let rodando = false;

// Contador diário — reseta quando o dia muda
let contadorDiario = 0;
let ultimoDia = null;

function getSPDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function resetarContadorSeNovoDia() {
  const sp = getSPDate();
  const diaHoje = sp.toDateString();
  if (ultimoDia !== diaHoje) {
    contadorDiario = 0;
    ultimoDia = diaHoje;
    console.log(`[Disparador] Novo dia — contador resetado.`);
  }
}

function dentroDoHorarioComercial() {
  const sp = getSPDate();
  const hora = sp.getHours();
  const diaSemana = sp.getDay(); // 0=domingo, 6=sábado

  // Seg (1) a Sáb (6) — exclui apenas domingo (0)
  if (diaSemana === 0) return false;
  // Das 8h às 17h
  if (hora < 8 || hora >= parseInt(process.env.HORA_FIM || '19')) return false;

  return true;
}

/**
 * Calcula quantos ms faltam até o próximo horário comercial (8h do próximo dia útil).
 * Usado para o processo dormir sem ficar logando em loop.
 */
function msFateProximoHorario() {
  const sp = getSPDate();
  const hora = sp.getHours();
  const diaSemana = sp.getDay();

  // Próximo início: 8h de hoje ainda? ou amanhã?
  const proximo = new Date(sp);
  proximo.setSeconds(0);
  proximo.setMilliseconds(0);

  if (hora < 8) {
    // Hoje mesmo às 8h
    proximo.setHours(8, 0, 0, 0);
  } else {
    // Próximo dia útil às 8h
    proximo.setDate(proximo.getDate() + 1);
    proximo.setHours(8, 0, 0, 0);
    // Pula domingo
    if (proximo.getDay() === 0) proximo.setDate(proximo.getDate() + 1);
  }

  return proximo - sp;
}

async function buscarLead() {
  const res = await fetch(
    `${CONFIG.SUPABASE_URL}/rest/v1/leads?status=eq.novo&whatsapp_enviado=eq.false&order=score.desc&limit=1`,
    {
      headers: {
        'apikey': CONFIG.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase busca falhou: ${res.status}`);
  const data = await res.json();
  return data?.[0] || null;
}

async function enviarWhatsApp(telefone) {
  const res = await fetch(
    `${CONFIG.EVOLUTION_API_URL}/message/sendText/${CONFIG.EVOLUTION_INSTANCE}`,
    {
      method: 'POST',
      headers: {
        'apikey': CONFIG.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: telefone,
        text: 'Oi, tudo bem? 😊',
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution API falhou: ${res.status} — ${err}`);
  }
}

async function notificarSofia(telefone) {
  if (!CONFIG.SOFIA_URL) return;
  await fetch(`${CONFIG.SOFIA_URL}/webhooks/first-contact-sent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: telefone }),
  });
}

async function atualizarLead(id) {
  const res = await fetch(
    `${CONFIG.SUPABASE_URL}/rest/v1/leads?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': CONFIG.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        whatsapp_enviado: true,
        status: 'contactado',
        whatsapp_enviado_em: new Date().toISOString(),
        tentativas: 1,
      }),
    }
  );
  if (!res.ok) throw new Error(`Supabase update falhou: ${res.status}`);
}

async function tick() {
  resetarContadorSeNovoDia();

  // Fora do horário: dorme até o próximo horário comercial sem logar em loop
  if (!dentroDoHorarioComercial()) {
    const msAteAbertura = msFateProximoHorario();
    const horas = (msAteAbertura / 3600000).toFixed(1);
    console.log(`[Disparador] Fora do horário (Seg-Sáb 8h-${process.env.HORA_FIM || 19}h). Dormindo ${horas}h até a abertura...`);
    setTimeout(iniciarCiclo, msAteAbertura);
    return;
  }

  // Atingiu o limite diário
  if (contadorDiario >= CONFIG.LIMITE_DIARIO) {
    const msAteAbertura = msFateProximoHorario();
    const horas = (msAteAbertura / 3600000).toFixed(1);
    console.log(`[Disparador] Limite diário de ${CONFIG.LIMITE_DIARIO} mensagens atingido. Dormindo até amanhã (${horas}h)...`);
    setTimeout(iniciarCiclo, msAteAbertura);
    return;
  }

  if (rodando) {
    console.log('[Disparador] Tick anterior ainda em execução, pulando...');
    return;
  }

  rodando = true;

  try {
    const lead = await buscarLead();

    if (!lead) {
      console.log('[Disparador] Nenhum lead pendente. Próxima verificação em 10 min.');
      return;
    }

    const telefone = lead.telefone || lead.phone || '';
    const nome = lead.nome || lead.name || '';
    const categoria = lead.categoria || lead.business_type || '';
    const cidade = lead.cidade || lead.city || '';

    if (!telefone) {
      console.warn(`[Disparador] Lead ${lead.id} sem telefone, pulando.`);
      await atualizarLead(lead.id);
      return;
    }

    console.log(`[Disparador] [${contadorDiario + 1}/${CONFIG.LIMITE_DIARIO}] Enviando para ${nome} (${categoria} — ${cidade}) | ${telefone}`);

    try {
      await enviarWhatsApp(telefone);
      contadorDiario++;
      console.log(`[Disparador] ✅ WhatsApp enviado para ${telefone}. Total hoje: ${contadorDiario}/${CONFIG.LIMITE_DIARIO}`);
    } catch (e) {
      console.error(`[Disparador] ⚠️ Erro no envio, marcando mesmo assim: ${e.message}`);
    }

    await atualizarLead(lead.id);

    // Notifica Sofia para registrar timestamp (filtro de bot 10s)
    try {
      await notificarSofia(telefone);
    } catch (e) {
      console.warn(`[Disparador] Aviso: não notificou Sofia — ${e.message}`);
    }

  } catch (err) {
    console.error('[Disparador] Erro no tick:', err.message);
  } finally {
    rodando = false;
  }
}

let intervaloAtivo = null;

function iniciarCiclo() {
  // Limpa intervalo anterior se existir
  if (intervaloAtivo) {
    clearInterval(intervaloAtivo);
    intervaloAtivo = null;
  }

  tick(); // Executa imediatamente
  intervaloAtivo = setInterval(tick, CONFIG.INTERVALO_MS);
}

function iniciar() {
  console.log(`[Disparador] Iniciando — intervalo: ${CONFIG.INTERVALO_MS / 60000} min | limite diário: ${CONFIG.LIMITE_DIARIO} msgs | horário: Seg-Sáb 8h-${process.env.HORA_FIM || 19}h`);
  iniciarCiclo();
}

module.exports = { iniciar };
