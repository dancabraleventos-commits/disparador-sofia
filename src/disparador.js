/**
 * Disparador Sofia — Railway Service
 *
 * Substitui o workflow N8N "Disparador Sofia — 1 lead por vez"
 * Roda a cada 40 segundos, busca 1 lead novo e envia "Oi, tudo bem? 😊"
 * Sem limite de execuções, sem timeout de 60s.
 * Só dispara em horário comercial: Seg-Sex, 8h-18h (horário de SP)
 */

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'Sofia',
  SOFIA_URL: process.env.SOFIA_URL,
  INTERVALO_MS: parseInt(process.env.INTERVALO_MS || '40000'),
};

let rodando = false;

function dentroDoHorarioComercial() {
  const agora = new Date();
  // Converte para horário de São Paulo (UTC-3)
  const sp = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = sp.getHours();
  const diaSemana = sp.getDay(); // 0=domingo, 6=sábado

  // Apenas Seg (1) a Sex (5)
  if (diaSemana === 0 || diaSemana === 6) return false;
  // Das 8h às 18h
  if (hora < 8 || hora >= 18) return false;

  return true;
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
  // Verifica horário comercial antes de qualquer coisa
  if (!dentroDoHorarioComercial()) {
    console.log('[Disparador] Fora do horário comercial (Seg-Sex 8h-18h), aguardando...');
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
      console.log('[Disparador] Nenhum lead pendente.');
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

    console.log(`[Disparador] Enviando para ${nome} (${categoria} — ${cidade}) | ${telefone}`);

    try {
      await enviarWhatsApp(telefone);
      console.log(`[Disparador] ✅ WhatsApp enviado para ${telefone}`);
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

function iniciar() {
  console.log(`[Disparador] Iniciando — intervalo: ${CONFIG.INTERVALO_MS / 1000}s`);
  tick();
  setInterval(tick, CONFIG.INTERVALO_MS);
}

module.exports = { iniciar };
