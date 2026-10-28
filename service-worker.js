"use strict";

const CACHE_NAME = "sales-tracker-v31";
const APP_FILES = [
    "./",
    "./index.html",
    "./app.js",
    "./db.js",
    "./service-worker.js",
    "./TERMS_AND_CONDITIONS.md",
    "./LICENSE.md",
    "./assets/app.css",
    "./assets/icon.svg",
    "./manifest.webmanifest",
    "./vendor/fontawesome.css",
    "./vendor/webfonts/fa-brands-400.woff2",
    "./vendor/webfonts/fa-regular-400.woff2",
    "./vendor/webfonts/fa-solid-900.woff2",
    "./vendor/webfonts/fa-v4compatibility.woff2",
    "./vendor/sql-asm.js",
    "./assets/fonts/plus-jakarta-sans-latin-400-normal.woff2",
    "./assets/fonts/plus-jakarta-sans-latin-500-normal.woff2",
    "./assets/fonts/plus-jakarta-sans-latin-600-normal.woff2",
    "./assets/fonts/plus-jakarta-sans-latin-700-normal.woff2",
    "./assets/fonts/plus-jakarta-sans-latin-800-normal.woff2"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(
                names.filter(name => name.startsWith("sales-tracker-") && name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin) return;

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
                    return response;
                })
                .catch(() => caches.match("./index.html"))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then(cached => cached || fetch(request).then(response => {
            if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
            }
            return response;
        }))
    );
});
