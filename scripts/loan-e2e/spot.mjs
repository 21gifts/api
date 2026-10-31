/**
 * Fixture BTC price for the loan cycle.
 *
 * The app turns a typed peso amount into sats with `GET /fx/spot`. The gift
 * row that prices the ask is a different rate, so this process answers every
 * request with one peso cent per sat (1 BTC = 1_000_000 PHP) in the shape
 * the api already accepts. A live provider quote would mint a different size.
 */
import http from 'node:http';

const port = Number(process.env['LOAN_E2E_SPOT_PORT'] ?? '3996');
const body = JSON.stringify({
  data: {
    currency: 'BTC',
    rates: {
      USD: '1000000',
      CHF: '1000000',
      EUR: '1000000',
      PHP: '1000000',
    },
  },
});

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(body);
});
server.listen(port, '127.0.0.1');
