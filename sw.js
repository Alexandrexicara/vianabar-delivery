const CACHE_NAME = 'delivery-day-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Não intercepta nem armazena respostas da API: mantém os dados do delivery atualizados.
self.addEventListener('fetch', () => {});
