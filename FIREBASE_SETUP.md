# Firebase setup

The app already writes push jobs to the `pending_pushes` collection. The Cloud Function in the project-root `index.js` sends each new job through Firebase Cloud Messaging and removes it after delivery. Invalid device tokens are removed from `push_tokens`; transient delivery errors are retried by Cloud Functions.

## Prepare admin authorization

The password reset callable requires Firebase Authentication custom claims. This is deliberate: a role field read by the browser is not sufficient authorization for changing another user's password. The in-app admin promotion action updates both the musician record and the Authentication claim; only the account registered to phone number `0547771121` can use that action, including on its own staff record. Removing that account's `admin` role does not remove its separate super-owner access. The server verifies the owner account from its Firebase Authentication email identity, so admin promotion does not depend on a separately configured `superOwner` claim. Other administrator claims are still required for the password reset and other protected callables.

1. In Firebase Console, open **Authentication > Users** and copy the UID for each system administrator.
2. Set up Google Application Default Credentials locally with `gcloud auth application-default login`, using an account authorized to manage users in this Firebase project. Never commit a service-account key.
3. From the project root, run `GCLOUD_PROJECT=salon-yevani-a node set-admin-claims.js <UID> admin` for each administrator. Run `GCLOUD_PROJECT=salon-yevani-a node set-admin-claims.js <OWNER_UID> superOwner` for the super owner. New claims take effect after that user signs out and signs in again.
4. To revoke a claim, run `node set-admin-claims.js <UID> removeAdmin`.

## Deploy Firebase functions

1. Install Node.js 20 and the Firebase CLI, then sign in with `firebase login`.
2. From the project root, run `firebase deploy --only functions`. The root `index.js` and `package.json` are the configured Functions source.
3. If prompted, enable Cloud Functions and the Cloud Messaging API for the Firebase project. Cloud Functions deployment may require the Blaze billing plan.

When an administrator approves a password reset, the server changes the Firebase Authentication password and returns a newly generated temporary password to that administrator once. It is not stored in Firestore or sent in a push notification. The administrator must give it to the user through a private channel. The app requires the user to choose a permanent password before opening the main interface.

## Verify phone numbers during registration

New registrations verify ownership of an Israeli mobile number by SMS before creating the app account. In Firebase Console, enable **Authentication > Sign-in method > Phone**, allow SMS for Israel in the SMS region policy, and add the deployed site domain under **Authentication > Settings > Authorized domains**. Firebase's reCAPTCHA check is used when sending the code. Registration cannot complete until the code is confirmed. SMS delivery is subject to Firebase quotas and may incur billing.

## Configure browser push tokens

In Firebase Console, open **Project settings > Cloud Messaging > Web configuration** and create or copy the Web Push certificate key pair. The app's `vapidKey` in `index.html` must match the public key shown there. The public VAPID key belongs in the client; never put a private key or service-account key in the HTML file.

The site must be served over HTTPS (or localhost during development), and `sw.js` must be available at the site root. After deploying, sign in from a supported browser and grant notification permission so the app can register a token.

## Firestore rules

This project did not include its existing Firestore rules. The function uses Admin SDK credentials, but the client still writes `push_tokens` and `pending_pushes` directly. Before deploying to production, verify that the deployed Firestore rules restrict those writes to trusted users; do not replace the project's existing rules with an unreviewed rules file.