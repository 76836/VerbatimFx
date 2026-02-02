const CACHE_NAME = 'VerbatimFx-v1';
const ASSETS = [
    './',
    './index.html',
    './css/studio.css',
    './js/main.js',
    './js/audio-manager.js',
    './js/midi-synth.js',
    './js/timeline.js',
    './js/storage.js',
    './js/visualizers.js',
    './manifest.json',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
