const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { randomInt } = require("node:crypto");

initializeApp();

const db = getFirestore();

exports.setStaffAdminRole = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לשנות הרשאות.");
    }
    if (request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "רק בעל המערכת יכול לשנות הרשאות מנהל.");
    }

    const musicianId = request.data && request.data.musicianId;
    const makeAdmin = request.data && request.data.makeAdmin;
    if (typeof musicianId !== "string" || !musicianId || typeof makeAdmin !== "boolean") {
        throw new HttpsError("invalid-argument", "פרטי שינוי ההרשאה אינם תקינים.");
    }

    const musicianRef = db.collection("musicians").doc(musicianId);
    const musicianSnapshot = await musicianRef.get();
    if (!musicianSnapshot.exists) {
        throw new HttpsError("not-found", "איש הצוות לא נמצא.");
    }

    const targetPhone = String(musicianSnapshot.data().phone || "").replace(/\D/g, "");
    const usersSnapshot = await db.collection("users").get();
    const matchingUsers = usersSnapshot.docs.filter(userDocument =>
        String(userDocument.data().phone || "").replace(/\D/g, "") === targetPhone
    );
    if (!targetPhone || matchingUsers.length !== 1) {
        throw new HttpsError("failed-precondition", "לא נמצא חשבון יחיד התואם לאיש הצוות.");
    }

    const targetUser = await getAuth().getUser(matchingUsers[0].id);
    const previousClaims = { ...(targetUser.customClaims || {}) };
    if (previousClaims.superOwner === true && !makeAdmin) {
        throw new HttpsError("failed-precondition", "לא ניתן להסיר הרשאת מנהל מבעל המערכת.");
    }

    const previousAdminStatus = musicianSnapshot.data().isAdmin === true;
    await musicianRef.update({ isAdmin: makeAdmin });
    try {
        const updatedClaims = { ...previousClaims };
        if (makeAdmin) updatedClaims.admin = true;
        else delete updatedClaims.admin;
        await getAuth().setCustomUserClaims(targetUser.uid, updatedClaims);
    } catch (error) {
        await musicianRef.update({ isAdmin: previousAdminStatus }).catch(() => {});
        throw new HttpsError("internal", "לא ניתן היה לעדכן את הרשאת Firebase Authentication.");
    }

    return { isAdmin: makeAdmin };
});

function createTemporaryPassword() {
    const characterSets = [
        "ABCDEFGHJKLMNPQRSTUVWXYZ",
        "abcdefghijkmnopqrstuvwxyz",
        "23456789"
    ];
    const allCharacters = characterSets.join("");
    const passwordCharacters = characterSets.map(characters => characters[randomInt(characters.length)]);

    while (passwordCharacters.length < 16) {
        passwordCharacters.push(allCharacters[randomInt(allCharacters.length)]);
    }

    for (let index = passwordCharacters.length - 1; index > 0; index--) {
        const swapIndex = randomInt(index + 1);
        [passwordCharacters[index], passwordCharacters[swapIndex]] = [passwordCharacters[swapIndex], passwordCharacters[index]];
    }

    return passwordCharacters.join("");
}

exports.resetUserPassword = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לאפס סיסמה.");
    }
    if (request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const requestId = request.data && request.data.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) {
        throw new HttpsError("invalid-argument", "בקשת איפוס לא תקינה.");
    }

    const resetRequestRef = db.collection("password_reset_requests").doc(requestId);
    const resetRequestSnapshot = await resetRequestRef.get();
    if (!resetRequestSnapshot.exists || resetRequestSnapshot.data().status !== "pending") {
        throw new HttpsError("failed-precondition", "בקשת האיפוס כבר טופלה או שאינה קיימת.");
    }

    const requestedPhone = String(resetRequestSnapshot.data().userPhone || "").replace(/\D/g, "");
    if (!requestedPhone) {
        throw new HttpsError("failed-precondition", "לבקשה אין מספר טלפון תקין.");
    }

    const usersSnapshot = await db.collection("users").get();
    const matchingUsers = usersSnapshot.docs.filter(userDocument =>
        String(userDocument.data().phone || "").replace(/\D/g, "") === requestedPhone
    );
    if (matchingUsers.length !== 1) {
        throw new HttpsError("failed-precondition", "לא נמצא חשבון יחיד התואם למספר הטלפון.");
    }

    const targetUserDocument = matchingUsers[0];
    const processingAt = FieldValue.serverTimestamp();
    await db.runTransaction(async transaction => {
        const currentRequest = await transaction.get(resetRequestRef);
        if (!currentRequest.exists || currentRequest.data().status !== "pending") {
            throw new HttpsError("failed-precondition", "בקשת האיפוס כבר טופלה.");
        }
        transaction.update(resetRequestRef, {
            status: "processing",
            resetByUid: request.auth.uid,
            processingAt
        });
    });

    const temporaryPassword = createTemporaryPassword();
    const mustChangePasswordBeforeReset = targetUserDocument.data().mustChangePassword === true;
    try {
        await targetUserDocument.ref.update({
            mustChangePassword: true,
            tempPassword: FieldValue.delete()
        });
        await getAuth().updateUser(targetUserDocument.id, { password: temporaryPassword });

        let resetRequestRecorded = true;
        try {
            await resetRequestRef.update({
            status: "approved",
            resetByUid: request.auth.uid,
            processingAt: FieldValue.delete(),
            resetAt: FieldValue.serverTimestamp()
        });
        } catch (recordError) {
            resetRequestRecorded = false;
            logger.error("Password changed, but reset request status could not be finalized", {
                requestId,
                error: String(recordError.message || recordError)
            });
        }

        return {
            temporaryPassword,
            userName: String(targetUserDocument.data().name || resetRequestSnapshot.data().userName || "המשתמש"),
            resetRequestRecorded
        };
    } catch (error) {
        const rollback = [
            resetRequestRef.update({ status: "pending", processingAt: FieldValue.delete() })
        ];
        rollback.push(targetUserDocument.ref.update({
            mustChangePassword: mustChangePasswordBeforeReset ? true : FieldValue.delete()
        }));
        await Promise.allSettled(rollback);
        logger.error("Password reset failed", { requestId, error: String(error.message || error) });
        throw new HttpsError("internal", "איפוס הסיסמה נכשל. ניתן לנסות שוב.");
    }
});

exports.deliverPendingPush = onDocumentCreated(
    { document: "pending_pushes/{pushId}", retry: true },
    async event => {
        const pushRef = event.data.ref;
        const pushData = event.data.data();
        const token = pushData.token;

        if (typeof token !== "string" || !token) {
            logger.warn("Discarding pending push without a valid token", { pushId: event.params.pushId });
            await pushRef.delete();
            return;
        }

        try {
            await getMessaging().send({
                token,
                notification: {
                    title: String(pushData.title || "הודעה חדשה"),
                    body: String(pushData.body || "")
                },
                data: {
                    tabTarget: String(pushData.tabTarget || "notifs")
                }
            });

            await pushRef.delete();
            logger.info("Pending push delivered", { pushId: event.params.pushId });
        } catch (error) {
            if (["messaging/invalid-registration-token", "messaging/registration-token-not-registered"].includes(error.code)) {
                const tokenDocs = await db.collection("push_tokens").where("token", "==", token).get();
                const batch = db.batch();
                tokenDocs.docs.forEach(tokenDoc => batch.delete(tokenDoc.ref));
                batch.delete(pushRef);
                await batch.commit();
                logger.warn("Removed an invalid FCM token", { pushId: event.params.pushId });
                return;
            }

            await pushRef.set({
                deliveryAttempts: FieldValue.increment(1),
                lastDeliveryError: String(error.message || error),
                lastDeliveryErrorAt: FieldValue.serverTimestamp()
            }, { merge: true });
            logger.error("Pending push delivery failed; retrying", {
                pushId: event.params.pushId,
                error: String(error.message || error)
            });
            throw error;
        }
    }
);
