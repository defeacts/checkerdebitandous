/**
 * logSender.js - Envia os logs do checker Node.js para o servidor central
 *
 * Intercepta console.log / console.error / console.warn e envia cada log
 * para o endpoint log_receiver.php do servidor central, onde são armazenados
 * e exibidos em tempo real no admin.
 *
 * Uso:
 *   const logSender = require('./logSender');
 *   logSender.init({
 *     checkerId: 'abc123',          // ID do checker no banco central
 *     accessKey: 'XXXX',            // access_key do usuário (opcional)
 *     endpoint: 'http://SEU-DOMINIO/checker/log_receiver.php'
 *   });
 *
 * Depois de init(), console.log/console.error/console.warn continuam
 * funcionando normalmente (saída local) E também são enviados ao servidor.
 *
 * Configuração alternativa via variáveis de ambiente:
 *   CHECKER_ID, ACCESS_KEY, LOG_ENDPOINT
 */

const http = require('http');
const https = require('https');

let config = {
  checkerId: process.env.CHECKER_ID || '',
  accessKey: process.env.ACCESS_KEY || '',
  endpoint: process.env.LOG_ENDPOINT || '',
  enabled: false,
  buffer: [],
  flushTimer: null,
  flushInterval: 2000, // envia em lote a cada 2s
  maxBuffer: 50,        // ou quando acumular 50 logs
};

// Guarda referências originais
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function sendBatch(batch) {
  if (!config.enabled || batch.length === 0) return;

  const payload = JSON.stringify({ logs: batch });

  let url;
  try {
    url = new URL(config.endpoint);
  } catch (e) {
    return;
  }

  const lib = url.protocol === 'https:' ? https : http;
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 5000,
  };

  const req = lib.request(options, (res) => {
    res.resume(); // descarta a resposta
  });

  req.on('error', () => {
    // Falha silenciosa - não quebra o checker
  });

  req.on('timeout', () => {
    req.destroy();
  });

  req.write(payload);
  req.end();
}

function queueLog(level, message) {
  if (!config.enabled) return;

  config.buffer.push({
    checker_id: config.checkerId,
    access_key: config.accessKey,
    level: level,
    message: String(message).slice(0, 2000),
  });

  if (config.buffer.length >= config.maxBuffer) {
    flush();
  }
}

function flush() {
  if (config.buffer.length === 0) return;
  const batch = config.buffer.splice(0, config.buffer.length);
  sendBatch(batch);
}

function init(opts) {
  if (opts) {
    config = { ...config, ...opts };
  }

  if (!config.checkerId || !config.endpoint) {
    // Sem configuração, mantém console normal
    return;
  }

  config.enabled = true;

  // Intercepta console.log
  console.log = function (...args) {
    origLog.apply(console, args);
    queueLog('info', args.map(String).join(' '));
  };

  // Intercepta console.error
  console.error = function (...args) {
    origError.apply(console, args);
    queueLog('error', args.map(String).join(' '));
  };

  // Intercepta console.warn
  console.warn = function (...args) {
    origWarn.apply(console, args);
    queueLog('warn', args.map(String).join(' '));
  };

  // Flush periódico
  config.flushTimer = setInterval(flush, config.flushInterval);
  config.flushTimer.unref?.();

  // Flush no encerramento
  process.on('exit', flush);
  process.on('SIGINT', () => { flush(); process.exit(); });
  process.on('SIGTERM', () => { flush(); process.exit(); });

  origLog('[logSender] Logs serão enviados para o servidor central');
}

function setAccessKey(key) {
  config.accessKey = key || '';
}

module.exports = { init, flush, setAccessKey };
