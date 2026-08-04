const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'logs.txt');

let total = 0;
let success = 0;
let declined = 0;
let error = 0;
let startTime = Date.now();

if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

function ts() {
  return chalk.gray(`[${new Date().toISOString()}]`);
}

function elapsed() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function addLog(message, type = 'info') {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(logFile, line + '\n');

  const icons = { success: '✔', error: '✘', warning: '⚠', info: '›' };
  const colors = {
    success: chalk.greenBright,
    error:   chalk.redBright,
    warning: chalk.yellowBright,
    info:    chalk.cyanBright,
  };

  const icon  = icons[type]  || icons.info;
  const color = colors[type] || colors.info;

  console.log(`${ts()} ${color(icon)} ${chalk.white(message)}`);
}

function addCard(cardNumber, status, duration, errorReason = null, details = null) {
  const line = `[${new Date().toISOString()}] CARD ${cardNumber} | ${status} | ${duration}${errorReason ? ' | ' + errorReason : ''}`;
  fs.appendFileSync(logFile, line + '\n');

  const bar   = chalk.gray('│');
  const sep   = chalk.gray('─'.repeat(52));

  let statusLabel;
  if (status === 'APPROVED')      statusLabel = chalk.bgGreen.black(` ${status} `);
  else if (status === 'DECLINED') statusLabel = chalk.bgYellow.black(` ${status} `);
  else                            statusLabel = chalk.bgRed.white(` ${status} `);

  console.log('');
  console.log(sep);
  console.log(`${bar} ${chalk.bold.white(cardNumber)}  ${statusLabel}  ${chalk.gray(duration)}`);
  if (errorReason) console.log(`${bar} ${chalk.yellow('Motivo:')} ${chalk.white(errorReason)}`);
  if (details && details !== errorReason) console.log(`${bar} ${chalk.gray('Info:')}   ${chalk.white(details)}`);
  console.log(sep);
}

function updateStats(totalCount = null, successCount = null, declinedCount = null, errorCount = null) {
  if (totalCount  !== null) total    = totalCount;
  if (successCount !== null) success = successCount;
  if (declinedCount !== null) declined = declinedCount;
  if (errorCount  !== null) error    = errorCount;

  const rate    = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
  const pending = Math.max(0, total - success - declined - error);
  const bar     = chalk.gray('│');

  console.log('');
  console.log(chalk.gray('╔' + '═'.repeat(52) + '╗'));
  console.log(`${chalk.gray('║')}  ${chalk.bold.white('STATS')}  ${chalk.gray('elapsed:')} ${chalk.cyan(elapsed())}${' '.repeat(Math.max(0, 36 - elapsed().length))}${chalk.gray('║')}`);
  console.log(chalk.gray('╠' + '═'.repeat(52) + '╣'));
  console.log(`${bar}  ${chalk.white('Total   ')} ${chalk.bold.white(String(total).padEnd(6))}  ${chalk.white('Aprovados')} ${chalk.bold.greenBright(String(success).padEnd(6))}  ${bar}`);
  console.log(`${bar}  ${chalk.white('Declined')} ${chalk.bold.yellowBright(String(declined).padEnd(6))}  ${chalk.white('Erros    ')} ${chalk.bold.redBright(String(error).padEnd(6))}  ${bar}`);
  console.log(`${bar}  ${chalk.white('Taxa     ')} ${chalk.bold.cyanBright(rate + '%')}${' '.repeat(42 - rate.length)}${bar}`);
  console.log(chalk.gray('╚' + '═'.repeat(52) + '╝'));
  console.log('');
}

module.exports = { addLog, addCard, updateStats };
