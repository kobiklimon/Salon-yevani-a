# Firebase setup

The app already writes push jobs to the `pending_pushes` collection. The Cloud Function in `functions/index.js` sends each new job through Firebase Cloud Messaging and removes it after delivery. Invalid device tokens are removed from `push_tokens`; transient delivery errors are retried by Cloud Functions.

## Prepare admin authorization

The password reset callable requires Firebase Authentication custom claims. This is deliberate: a role field read by the browser is not sufficient authorization for changing another user's password. The in-app admin promotion action now updates both the musician record and the Authentication claim; only the super owner claim can use that callable.

1. In Firebase Console, open **Authentication > Users** and copy the UID for each system administrator.
2. Set up Google Application Default Credentials locally with `gcloud auth application-default login`, using an account authorized to manage users in this Firebase project. Never commit a service-account key.
3. From the `functions` directory, run `GCLOUD_PROJECT=salon-yevani-a node set-admin-claims.js <UID> admin` for each administrator. Run `GCLOUD_PROJECT=salon-yevani-a node set-admin-claims.js <OWNER_UID> superOwner` for the super owner. New claims take effect after that user signs out and signs in again.
4. To revoke a claim, run `node set-admin-claims.js <UID> removeAdmin`.

## Deploy Firebase functions

1. Install Node.js 20 and the Firebase CLI, then sign in with `firebase login`.
2. From the project directory, run `firebase deploy --only functions`.
3. If prompted, enable Cloud Functions and the Cloud Messaging API for the Firebase project. Cloud Functions deployment may require the Blaze billing plan.

When an administrator approves a password reset, the server changes the Firebase Authentication password and returns a newly generated temporary password to that administrator once. It is not stored in Firestore or sent in a push notification. The administrator must give it to the user through a private channel. The app requires the user to choose a permanent password before opening the main interface.

## Configure browser push tokens

In Firebase Console, open **Project settings > Cloud Messaging > Web configuration** and create or copy the Web Push certificate key pair. Replace the placeholder currently passed as `vapidKey` in `index.html` with the full public key. The public VAPID key belongs in the client; never put a service-account key in the HTML file.

The site must be served over HTTPS (or localhost during development), and `sw.js` must be available at the site root. After deploying, sign in from a supported browser and grant notification permission so the app can register a token.

## Firestore rules

This project did not include its existing Firestore rules. The function uses Admin SDK credentials, but the client still writes `push_tokens` and `pending_pushes` directly. Before deploying to production, verify that the deployed Firestore rules restrict those writes to trusted users; do not replace the project's existing rules with an unreviewed rules file.