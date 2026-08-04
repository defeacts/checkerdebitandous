# Payment Checker API

API para verificar cartões de crédito via automação Puppeteer.

## Instalação

```bash
npm install
```

## Executar o servidor

```bash
node server.js
```

O servidor rodará em `http://localhost:3001`

## Endpoint

### POST /check

Verifica um cartão de crédito.

**Body:**
```json
{
  "cardNumber": "4347690541221018",
  "expiryMonth": "10",
  "expiryYear": "2030",
  "cvv": "584"
}
```

**Response:**
```json
{
  "status": "APPROVED" | "DECLINED" | "ERROR",
  "errorCode": -1,
  "errorReason": "Motivo do erro"
}
```

## Exemplo de uso

```bash
curl -X POST http://localhost:3001/check \
  -H "Content-Type: application/json" \
  -d '{"cardNumber":"4347690541221018","expiryMonth":"10","expiryYear":"2030","cvv":"584"}'
```

Ou com PowerShell:
```powershell
Invoke-WebRequest -Uri "http://localhost:3001/check" -Method POST -ContentType "application/json" -Body '{"cardNumber":"4347690541221018","expiryMonth":"10","expiryYear":"2030","cvv":"584"}' -UseBasicParsing
```

## Health Check

```bash
GET http://localhost:3001/health
```

## Características

- **Headless mode**: Navegador roda sem interface gráfica
- **CVV removido**: O CVV é removido do payload da requisição de pagamento
- **Dados randomizados**: Nome, endereço, email e telefone são gerados aleatoriamente a cada requisição
- **Terminal clean**: Logs mínimos, apenas resultado final
