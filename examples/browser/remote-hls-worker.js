/**
 * Service Worker for Remote HLS
 * Intercepts requests for HLS playlists and segments,
 * communicates with main page to get data from RemoteMp4
 */

const CACHE_NAME = 'remote-hls-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only intercept our virtual HLS paths
  if (!url.pathname.startsWith('/hls/')) {
    return;
  }
  
  event.respondWith(handleHlsRequest(event, url));
});

async function handleHlsRequest(event, url) {
  const path = url.pathname.replace('/hls/', '');
  
  // Get the client that made this request
  const client = await clients.get(event.clientId);
  if (!client) {
    return new Response('No client', { status: 500 });
  }
  
  // Create a message channel for response
  const messageChannel = new MessageChannel();
  
  return new Promise((resolve) => {
    messageChannel.port1.onmessage = (event) => {
      const { data, contentType, error } = event.data;
      
      if (error) {
        resolve(new Response(error, { status: 500 }));
        return;
      }
      
      resolve(new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*'
        }
      }));
    };
    
    // Request data from main page
    client.postMessage({ type: 'hls-request', path }, [messageChannel.port2]);
  });
}

