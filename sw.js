importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyCis-H1d8436iH6vBkNfGWoy3ekkIDSflU",
    authDomain: "salon-yevani-a.firebaseapp.com",
    projectId: "salon-yevani-a",
    storageBucket: "salon-yevani-a.firebasestorage.app",
    messagingSenderId: "659584308438",
    appId: "1:659584308438:web:7ee8f7bc62e1b2132c6577"
});

const messaging = firebase.messaging();

// טיפול בהתראות פוש ברקע
messaging.onBackgroundMessage((payload) => {
    const notificationTitle = payload.notification ? payload.notification.title : 'הודעה חדשה';
    const notificationOptions = {
        body: payload.notification ? payload.notification.body : (payload.data ? payload.data.message : 'הודעה חדשה מהמערכת'),
        icon: '/icon.png'
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});

// מטמון (Cache) בסיסי לתמיכה במצב אופליין
const CACHE_NAME = 'salon-yevani-cache-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/icon.png'
];

// התקנת ה-Service Worker ושמירת קבצים בזיכרון המקומי
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll(urlsToCache);
            })
            .catch((err) => {
                console.log('Cache install error:', err);
            })
    );
});

// הפעלה וניקוי מטמון ישן אם צריך
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// שליפת נתונים ברשת או נפילה למצב אופליין (Cache)
self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request)
            .catch(() => {
                return caches.match(event.request);
            })
    );
});
