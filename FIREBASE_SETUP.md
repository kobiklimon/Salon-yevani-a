# Firebase setup

The app already writes push jobs to the `pending_pushes` collection. The Cloud Function in `functions/index.js` sends each new job through Firebase Cloud Messaging and removes it after delivery. Invalid device tokens are removed from `push_tokens`; transient delivery errors are retried by Cloud Functions.

## Deploy the push function

1. Install Node.js 20 and the Firebase CLI, then sign in with `firebase login`.
2. From this directory, run `firebase deploy --only functions:deliverPendingPush`.
3. If prompted, enable Cloud Functions and the Cloud Messaging API for the Firebase project. Cloud Functions deployment may require the Blaze billing plan.

## Configure browser push tokens

In Firebase Console, open **Project settings > Cloud Messaging > Web configuration** and create or copy the Web Push certificate key pair. Replace the placeholder currently passed as `vapidKey` in `index.html` with the full public key. The public VAPID key belongs in the client; never put a service-account key in the HTML file.

The site must be served over HTTPS (or localhost during development), and `sw.js` must be available at the site root. After deploying, sign in from a supported browser and grant notification permission so the app can register a token.

## Firestore rules

This project did not include its existing Firestore rules. The function uses Admin SDK credentials, but the client still writes `push_tokens` and `pending_pushes` directly. Before deploying to production, verify that the deployed Firestore rules restrict those writes to trusted users; do not replace the project's existing rules with an unreviewed rules file.