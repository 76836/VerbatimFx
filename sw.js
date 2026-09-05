const CACHE_NAME = 'VerbatimFx-v2-icemorphic';
const ASSETS = [
    './',
    './index.html',
    './css/studio.css',
    './css/icemorphic.css',
    './js/main.js',
    './js/ux.js',
    './js/audio-manager.js',
    './js/midi-synth.js',
    './js/midi-recorder.js',
    './js/timeline.js',
    './js/storage.js',
    './js/visualizers.js',
    './manifest.json',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => response || fetch(event.request))
    );
});
