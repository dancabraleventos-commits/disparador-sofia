const express = require('express');
const { iniciar } = require('./disparador');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'disparador-sofia', timestamp: new Date().toISOString() });
});

app.post('/leads/novo', async (req, res) => {
  const { nome, telefone, categoria, cidade, endereco, nota, score } = req.body || {};
  if (!telefone) {
    return res.status(400).json({ error: 'telefone obrigatório' });
  }
  try {
    const response = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/leads`,
      {
        method: 'POST',
        headers: {
          'apikey': CONFIG.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${CONFIG.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify({
          nome: nome || '',
          telefone,
          categoria: categoria || '',
          cidade: cidade || '',
          endereco: endereco || '',
          nota: nota || null,
          score: score || 0,
          status: 'novo',
          whatsapp_enviado: false,
        }),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      console.error('[Leads] Erro ao inserir:', err);
      return res.status(500).json({ error: err });
    }
    console.log(`[Leads] ✅ Lead inserido: ${nome} (${telefone})`);
    res.json({ ok: true, telefone, nome });
  } catch (err) {
    console.error('[Leads] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Disparador] Servidor na porta ${PORT}`);
  iniciar();
});
