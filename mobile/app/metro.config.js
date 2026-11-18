const { getDefaultConfig } = require('expo/metro-config');
const http = require('http');

const config = getDefaultConfig(__dirname);

/**
 * Suporte a web do expo-sqlite: o worker importa `wa-sqlite.wasm`, então o
 * Metro precisa tratar `.wasm` como asset. Além disso, o wa-sqlite usa
 * SharedArrayBuffer, que o navegador só libera com os cabeçalhos
 * COOP/COEP abaixo (ver enhanceMiddleware).
 */
config.resolver.assetExts.push('wasm');

/**
 * Em modo túnel (`expo start --tunnel`), só o Metro (porta 8081) é exposto
 * publicamente pelo ngrok — o app não tem como alcançar o sync-backend
 * (porta 3333) diretamente por trás desse mesmo domínio. Em vez de expor
 * uma segunda porta com outro serviço de túnel (que se mostrou instável
 * nesta rede), o próprio Metro faz proxy de `/api-proxy/*` para
 * `localhost:3333/*` — tudo trafega pela MESMA URL do túnel, diferenciado
 * só pelo prefixo do caminho. Em modo LAN normal isso nem chega a ser
 * usado (o app fala direto com a porta 3333 nesse caso — ver api.ts).
 */

const BACKEND_PORT = 3333;
const PREFIXO_PROXY = '/api-proxy';

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      if (req.url && req.url.startsWith(PREFIXO_PROXY)) {
        const caminhoDestino = req.url.slice(PREFIXO_PROXY.length) || '/';
        const proxyReq = http.request(
          {
            hostname: 'localhost',
            port: BACKEND_PORT,
            path: caminhoDestino,
            method: req.method,
            headers: { ...req.headers, host: `localhost:${BACKEND_PORT}` },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
          }
        );
        proxyReq.on('error', () => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'sync-backend inalcançável via proxy do Metro.' }));
        });
        req.pipe(proxyReq, { end: true });
        return;
      }
      return middleware(req, res, next);
    };
  },
};

module.exports = config;
