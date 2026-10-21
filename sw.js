// sw.js - Service Worker לקבלת התראות פוש ברקע
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

messaging.onBackgroundMessage((payload) => {
    console.log('[sw.js] Received background message: ', payload);
    const notificationTitle = payload.notification ? payload.notification.title : '🏛️ סלון יווני';
    const notificationOptions = {
        body: payload.notification ? payload.notification.body : payload.data ? payload.data.message : '',
        icon: 'https://salon-yevani-a.web.app/icon.png',
        badge: 'https://salon-yevani-a.web.app/icon.png',
        vibrate: [200, 100, 200]
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});
