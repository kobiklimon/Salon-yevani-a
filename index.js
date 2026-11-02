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
const SUPER_OWNER_PHONE = "0547771121";

exports.setStaffAdminRole = onCall(async request => {
    let operation = "אימות בעל המערכת";
    try {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "יש להתחבר כדי לשנות הרשאות.");
        }
        const callerEmail = String(request.auth.token.email || "").toLowerCase();
        if (callerEmail !== `user_${SUPER_OWNER_PHONE}@salonyevani.local`) {
            throw new HttpsError("permission-denied", "רק בעל המערכת יכול לשנות הרשאות מנהל.");
        }

        const musicianId = request.data && request.data.musicianId;
        const makeAdmin = request.data && request.data.makeAdmin;
        if (typeof musicianId !== "string" || !musicianId || typeof makeAdmin !== "boolean") {
            throw new HttpsError("invalid-argument", "פרטי שינוי ההרשאה אינם תקינים.");
        }

        const musicianRef = db.collection("musicians").doc(musicianId);
        operation = "איתור איש הצוות";
        const musicianSnapshot = await musicianRef.get();
        if (!musicianSnapshot.exists) {
            throw new HttpsError("not-found", "איש הצוות לא נמצא.");
        }

        const targetPhone = normalizePhone(musicianSnapshot.data().phone);
        if (!targetPhone) {
            throw new HttpsError("failed-precondition", "לאיש הצוות לא הוגדר מספר טלפון תקין.");
        }

        const auth = getAuth();
        let targetUser = null;
        operation = "איתור חשבון Firebase של איש הצוות";
        try {
            targetUser = await auth.getUserByEmail(`user_${targetPhone}@salonyevani.local`);
            const targetProfile = await db.collection("users").doc(targetUser.uid).get();
            if (!targetProfile.exists || normalizePhone(targetProfile.data().phone) !== targetPhone) {
                targetUser = null;
            }
        } catch (error) {
            if (error.code !== "auth/user-not-found") throw error;
        }

        if (!targetUser) {
            operation = "התאמת חשבון המשתמש למספר הטלפון";
            const usersSnapshot = await db.collection("users").get();
            const matchingUsers = usersSnapshot.docs.filter(userDocument =>
                normalizePhone(userDocument.data().phone) === targetPhone
            );
            if (matchingUsers.length !== 1) {
                throw new HttpsError("failed-precondition", "לא נמצא חשבון יחיד התואם לאיש הצוות. יש לוודא שמספר הטלפון מופיע פעם אחת בלבד בפרופילי המשתמשים.");
            }
            targetUser = await auth.getUser(matchingUsers[0].id);
        }

        const previousClaims = { ...(targetUser.customClaims || {}) };

        const previousAdminStatus = musicianSnapshot.data().isAdmin === true;
        try {
            operation = "עדכון רשומת איש הצוות";
            await musicianRef.update({ isAdmin: makeAdmin });
        } catch (error) {
            logger.error("Could not update staff admin status", {
                musicianId,
                errorCode: String(error.code || "unknown"),
                error: String(error.message || error)
            });
            throw new HttpsError(
                "failed-precondition",
                `עדכון רשומת איש הצוות נכשל (${error.code || "unknown"}). יש לבדוק הרשאות כתיבה של חשבון השירות ל-Firestore.`
            );
        }

        const updatedClaims = { ...previousClaims };
        if (makeAdmin) updatedClaims.admin = true;
        else delete updatedClaims.admin;
        if (targetPhone === SUPER_OWNER_PHONE) updatedClaims.superOwner = true;
        try {
            operation = "שמירת הרשאת Firebase";
            await auth.setCustomUserClaims(targetUser.uid, updatedClaims);
        } catch (error) {
            let rollbackSucceeded = false;
            try {
                await musicianRef.update({ isAdmin: previousAdminStatus });
                rollbackSucceeded = true;
            } catch (rollbackError) {
                logger.error("Could not roll back staff admin status after a failed claims update", {
                    musicianId,
                    errorCode: String(rollbackError.code || "unknown"),
                    error: String(rollbackError.message || rollbackError)
                });
            }
            logger.error("Staff admin role update failed", {
                musicianId,
                targetUid: targetUser.uid,
                errorCode: String(error.code || "unknown"),
                error: String(error.message || error)
            });
            const isPermissionError = String(error.code || "").toLowerCase().includes("permission");
            throw new HttpsError(
                "failed-precondition",
                `Firebase לא שמר את הרשאת החשבון (${error.code || "unknown"}).${isPermissionError ? " יש להעניק לחשבון השירות של הפונקציה תפקיד Firebase Authentication Admin." : ""}${rollbackSucceeded ? " הרשומה הוחזרה למצבה הקודם." : " גם שחזור רשומת הצוות נכשל; נדרשת בדיקה ביומני הפונקציה."}`
            );
        }

        return { isAdmin: makeAdmin };
    } catch (error) {
        if (error instanceof HttpsError) throw error;
        logger.error("Unexpected staff admin role update failure", {
            operation,
            errorCode: String(error.code || "unknown"),
            error: String(error.message || error)
        });
        throw new HttpsError(
            "internal",
            `שגיאה בשלב "${operation}" (${error.code || "unknown"}): ${error.message || error}`
        );
    }
});

function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return /^9725\d{8}$/.test(digits) ? `0${digits.slice(3)}` : digits;
}

function isStaffAssignedToEvent(event, musician) {
    if (Array.isArray(event.assignedStaffIds) && event.assignedStaffIds.includes(musician.id)) return true;
    if (Array.isArray(event.assignedStaffDetails) &&
        event.assignedStaffDetails.some(staff => staff.musicianId === musician.id)) return true;
    return Array.isArray(event.assignedStaff) &&
        event.assignedStaff.includes(`${musician.name} (${musician.role})`);
}

function getEventStaffIds(event, musiciansById) {
    if (Array.isArray(event.assignedStaffIds) && event.assignedStaffIds.length) {
        return [...new Set(event.assignedStaffIds)];
    }
    if (Array.isArray(event.assignedStaffDetails) && event.assignedStaffDetails.length) {
        return [...new Set(event.assignedStaffDetails.map(staff => staff.musicianId).filter(Boolean))];
    }

    return [...new Set((event.assignedStaff || []).flatMap(assignment => {
        const matches = [...musiciansById.values()].filter(musician =>
            `${musician.name} (${musician.role})` === String(assignment).trim()
        );
        return matches.length === 1 ? [matches[0].id] : [];
    }))];
}

function validateReplacement(event, target, replacement, allEvents, unavailablePhones) {
    if (!replacement || replacement.id === target.id || replacement.status === "inactive" ||
        replacement.role !== target.role || !replacement.phone) {
        throw new HttpsError("failed-precondition", "המחליף חייב להיות איש צוות פעיל באותו תפקיד.");
    }
    if (isStaffAssignedToEvent(event, replacement)) {
        throw new HttpsError("failed-precondition", "המחליף כבר משובץ להופעה זו.");
    }
    if (unavailablePhones.has(normalizePhone(replacement.phone))) {
        throw new HttpsError("failed-precondition", "המחליף סימן אי-זמינות בתאריך ההופעה.");
    }
    const hasScheduleConflict = allEvents.some(otherEvent =>
        otherEvent.id !== event.id &&
        otherEvent.date === event.date &&
        otherEvent.branchId !== event.branchId &&
        otherEvent.time === event.time &&
        isStaffAssignedToEvent(otherEvent, replacement)
    );
    if (hasScheduleConflict) {
        throw new HttpsError("failed-precondition", "המחליף משובץ בסניף אחר באותה שעה.");
    }
}

exports.updateStaffProfile = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לעדכן איש צוות.");
    }

    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const { musicianId, name, role, status } = request.data || {};
    if (typeof musicianId !== "string" || !musicianId ||
        typeof name !== "string" || !name.trim() ||
        !["זמר/ת", "קלידים", "בוזוקי", "מנהל סניף"].includes(role) ||
        !["active", "inactive"].includes(status)) {
        throw new HttpsError("invalid-argument", "פרטי איש הצוות אינם תקינים.");
    }

    const musicianRef = db.collection("musicians").doc(musicianId);
    const musicianSnapshot = await musicianRef.get();
    if (!musicianSnapshot.exists) {
        throw new HttpsError("not-found", "איש הצוות לא נמצא.");
    }
    const previousMusician = musicianSnapshot.data();
    if (normalizePhone(previousMusician.phone) === SUPER_OWNER_PHONE && !isSuperOwner) {
        throw new HttpsError("failed-precondition", "לא ניתן לערוך את איש הצוות קובי קלימון.");
    }
    if (status === "inactive" && previousMusician.status !== "inactive") {
        throw new HttpsError("failed-precondition", "יש להשתמש בתהליך ההשבתה כדי לשמור על שיבוצים עתידיים.");
    }

    await musicianRef.update({ name: name.trim(), role, status });
    return { musicianId, name: name.trim(), role, status };
});

exports.changeStaffContact = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לשנות איש צוות.");
    }
    if (request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const musicianId = request.data && request.data.musicianId;
    const action = request.data && request.data.action;
    const replacements = request.data && request.data.replacements;
    const profileUpdates = request.data && request.data.profileUpdates;
    if (typeof musicianId !== "string" || !musicianId ||
        !["deactivate", "delete"].includes(action) ||
        !Array.isArray(replacements)) {
        throw new HttpsError("invalid-argument", "פרטי שינוי איש הצוות אינם תקינים.");
    }
    if (action === "deactivate" &&
        (!profileUpdates || typeof profileUpdates.name !== "string" || !profileUpdates.name.trim() ||
            typeof profileUpdates.role !== "string")) {
        throw new HttpsError("invalid-argument", "פרטי איש הצוות אינם תקינים.");
    }

    const musicianRef = db.collection("musicians").doc(musicianId);
    const musicianSnapshot = await musicianRef.get();
    if (!musicianSnapshot.exists) {
        throw new HttpsError("not-found", "איש הצוות לא נמצא.");
    }
    const target = { id: musicianSnapshot.id, ...musicianSnapshot.data() };
    if (normalizePhone(target.phone) === "0547771121") {
        throw new HttpsError("failed-precondition", "לא ניתן למחוק או להשבית את בעל המערכת.");
    }
    const validRoles = ["זמר/ת", "קלידים", "בוזוקי", "מנהל סניף"];
    if (action === "deactivate" && !validRoles.includes(profileUpdates.role)) {
        throw new HttpsError("invalid-argument", "התפקיד שנבחר אינו תקין.");
    }

    const [eventsSnapshot, musiciansSnapshot, unavailableSnapshot, usersSnapshot] = await Promise.all([
        db.collection("events").get(),
        db.collection("musicians").get(),
        db.collection("unavailabilities").get(),
        db.collection("users").get()
    ]);
    const allEvents = eventsSnapshot.docs.map(eventDocument => ({
        id: eventDocument.id,
        ...eventDocument.data()
    }));
    const allMusicians = musiciansSnapshot.docs.map(musicianDocument => ({
        id: musicianDocument.id,
        ...musicianDocument.data()
    }));
    const musiciansById = new Map(allMusicians.map(musician => [musician.id, musician]));
    const unavailableByDate = new Map();
    unavailableSnapshot.docs.forEach(unavailableDocument => {
        const unavailable = unavailableDocument.data();
        if (!unavailableByDate.has(unavailable.date)) unavailableByDate.set(unavailable.date, new Set());
        unavailableByDate.get(unavailable.date).add(normalizePhone(unavailable.phone));
    });

    const today = new Date().toISOString().slice(0, 10);
    const scheduledEvents = allEvents.filter(event =>
        event.date >= today && isStaffAssignedToEvent(event, target)
    );
    if (scheduledEvents.length > 450) {
        throw new HttpsError("failed-precondition", "לא ניתן לעדכן יותר מ-450 שיבוצים בפעולה אחת.");
    }
    if (replacements.length !== scheduledEvents.length) {
        throw new HttpsError("failed-precondition", "נדרש מחליף לכל הופעה עתידית שבה איש הצוות משובץ.");
    }

    const replacementsByEvent = new Map();
    replacements.forEach(item => {
        if (!item || typeof item.eventId !== "string" || typeof item.replacementMusicianId !== "string" ||
            replacementsByEvent.has(item.eventId)) {
            throw new HttpsError("invalid-argument", "רשימת המחליפים אינה תקינה.");
        }
        replacementsByEvent.set(item.eventId, item.replacementMusicianId);
    });

    const scheduledEventIds = new Set(scheduledEvents.map(event => event.id));
    if ([...replacementsByEvent.keys()].some(eventId => !scheduledEventIds.has(eventId))) {
        throw new HttpsError("failed-precondition", "רשימת ההופעות להחלפה השתנתה. נא לטעון מחדש.");
    }

    const replacementMusicians = new Map();
    scheduledEvents.forEach(event => {
        const replacementId = replacementsByEvent.get(event.id);
        const replacement = musiciansById.get(replacementId);
        validateReplacement(
            event,
            target,
            replacement,
            allEvents,
            unavailableByDate.get(event.date) || new Set()
        );
        replacementMusicians.set(event.id, replacement);
    });
    for (let index = 0; index < scheduledEvents.length; index++) {
        for (let otherIndex = index + 1; otherIndex < scheduledEvents.length; otherIndex++) {
            const event = scheduledEvents[index];
            const otherEvent = scheduledEvents[otherIndex];
            if (replacementMusicians.get(event.id).id === replacementMusicians.get(otherEvent.id).id &&
                event.date === otherEvent.date && event.time === otherEvent.time &&
                event.branchId !== otherEvent.branchId) {
                throw new HttpsError("failed-precondition", "אותו מחליף נבחר לשתי הופעות בסניפים שונים באותה שעה.");
            }
        }
    }

    const targetPhone = normalizePhone(target.phone);
    const matchingUsers = targetPhone
        ? usersSnapshot.docs.filter(userDocument => normalizePhone(userDocument.data().phone) === targetPhone)
        : [];
    if (action === "delete" && matchingUsers.length > 1) {
        throw new HttpsError("failed-precondition", "נמצאו כמה חשבונות למספר הטלפון. יש לפנות לתמיכה לפני המחיקה.");
    }

    const userRefs = matchingUsers.map(userDocument => userDocument.ref);
    const pushTokenRef = action === "delete" && matchingUsers.length === 1
        ? db.collection("push_tokens").doc(matchingUsers[0].id)
        : null;
    await db.runTransaction(async transaction => {
        const currentMusicianSnapshot = await transaction.get(musicianRef);
        const currentEventSnapshots = await Promise.all(scheduledEvents.map(event =>
            transaction.get(db.collection("events").doc(event.id))
        ));
        const currentReplacementSnapshots = await Promise.all(
            [...new Set([...replacementMusicians.values()].map(replacement => replacement.id))]
                .map(replacementId => transaction.get(db.collection("musicians").doc(replacementId)))
        );
        const currentUserSnapshots = await Promise.all(userRefs.map(userRef => transaction.get(userRef)));
        const currentPushTokenSnapshot = pushTokenRef ? await transaction.get(pushTokenRef) : null;
        const currentEventsSnapshot = await transaction.get(db.collection("events"));
        const currentUnavailableSnapshot = await transaction.get(db.collection("unavailabilities"));

        if (!currentMusicianSnapshot.exists) {
            throw new HttpsError("not-found", "איש הצוות כבר אינו קיים.");
        }
        const currentTarget = { id: currentMusicianSnapshot.id, ...currentMusicianSnapshot.data() };
        const currentEvents = currentEventsSnapshot.docs.map(eventDocument => ({
            id: eventDocument.id,
            ...eventDocument.data()
        }));
        const currentUnavailableByDate = new Map();
        currentUnavailableSnapshot.docs.forEach(unavailableDocument => {
            const unavailable = unavailableDocument.data();
            if (!currentUnavailableByDate.has(unavailable.date)) currentUnavailableByDate.set(unavailable.date, new Set());
            currentUnavailableByDate.get(unavailable.date).add(normalizePhone(unavailable.phone));
        });
        const currentScheduledEvents = currentEvents.filter(event =>
            event.date >= today && isStaffAssignedToEvent(event, currentTarget)
        );
        if (currentScheduledEvents.length !== scheduledEvents.length ||
            currentScheduledEvents.some(event => !replacementsByEvent.has(event.id))) {
            throw new HttpsError("failed-precondition", "השיבוצים השתנו. נא לטעון מחדש ולבחור מחליפים.");
        }

        const replacementsById = new Map(currentReplacementSnapshots.map(snapshot =>
            [snapshot.id, snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null]
        ));
        currentScheduledEvents.forEach(event => {
            const replacementId = replacementsByEvent.get(event.id);
            const replacement = replacementsById.get(replacementId);
            validateReplacement(
                event,
                currentTarget,
                replacement,
                currentEvents,
                currentUnavailableByDate.get(event.date) || new Set()
            );
        });
        for (let index = 0; index < currentScheduledEvents.length; index++) {
            for (let otherIndex = index + 1; otherIndex < currentScheduledEvents.length; otherIndex++) {
                const event = currentScheduledEvents[index];
                const otherEvent = currentScheduledEvents[otherIndex];
                if (replacementsByEvent.get(event.id) === replacementsByEvent.get(otherEvent.id) &&
                    event.date === otherEvent.date && event.time === otherEvent.time &&
                    event.branchId !== otherEvent.branchId) {
                    throw new HttpsError("failed-precondition", "אותו מחליף נבחר לשתי הופעות בסניפים שונים באותה שעה.");
                }
            }
        }

        currentEventSnapshots.forEach(eventSnapshot => {
            const event = { id: eventSnapshot.id, ...eventSnapshot.data() };
            const replacement = replacementsByEvent.get(event.id)
                ? replacementsById.get(replacementsByEvent.get(event.id))
                : replacementMusicians.get(event.id);
            if (!eventSnapshot.exists || !isStaffAssignedToEvent(event, currentTarget)) {
                throw new HttpsError("failed-precondition", "אחד השיבוצים השתנה. נא לטעון מחדש.");
            }

            const assignedStaffIds = getEventStaffIds(event, musiciansById)
                .filter(assignedId => assignedId !== currentTarget.id);
            assignedStaffIds.push(replacement.id);
            const assignedStaff = Array.isArray(event.assignedStaff)
                ? event.assignedStaff.filter(entry =>
                    entry !== `${currentTarget.name} (${currentTarget.role})` &&
                    !String(entry).startsWith(`${currentTarget.name} (`)
                )
                : [];
            assignedStaff.push(`${replacement.name} (${replacement.role})`);
            const currentDetails = Array.isArray(event.assignedStaffDetails) && event.assignedStaffDetails.length
                ? event.assignedStaffDetails
                : getEventStaffIds(event, musiciansById)
                    .map(assignedId => musiciansById.get(assignedId))
                    .filter(Boolean)
                    .map(staff => ({
                        musicianId: staff.id,
                        name: staff.name,
                        role: staff.role,
                        phoneId: normalizePhone(staff.phone)
                    }));
            const assignedStaffDetails = currentDetails
                .filter(staff => staff.musicianId !== currentTarget.id);
            assignedStaffDetails.push({
                musicianId: replacement.id,
                name: replacement.name,
                role: replacement.role,
                phoneId: normalizePhone(replacement.phone)
            });

            transaction.update(db.collection("events").doc(event.id), {
                assignedStaff,
                assignedStaffIds,
                assignedStaffDetails
            });
        });

        if (action === "delete") {
            transaction.delete(musicianRef);
            currentUserSnapshots.forEach((userSnapshot, index) => {
                if (userSnapshot.exists) transaction.delete(userRefs[index]);
            });
            if (currentPushTokenSnapshot && currentPushTokenSnapshot.exists) {
                transaction.delete(pushTokenRef);
            }
        } else {
            transaction.update(musicianRef, {
                name: profileUpdates.name.trim(),
                role: profileUpdates.role,
                status: "inactive"
            });
        }
    });

    let authAccountDeleted = true;
    if (action === "delete" && matchingUsers.length === 1) {
        try {
            await getAuth().deleteUser(matchingUsers[0].id);
        } catch (error) {
            authAccountDeleted = false;
            logger.error("Staff contact was deleted, but the Firebase Auth account could not be deleted", {
                musicianId,
                targetUid: matchingUsers[0].id,
                error: String(error.message || error)
            });
        }
    }

    return { action, authAccountDeleted };
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

    const requestedPhone = normalizePhone(resetRequestSnapshot.data().userPhone);
    if (!requestedPhone) {
        throw new HttpsError("failed-precondition", "לבקשה אין מספר טלפון תקין.");
    }

    const usersSnapshot = await db.collection("users").get();
    const matchingUsers = usersSnapshot.docs.filter(userDocument =>
        normalizePhone(userDocument.data().phone) === requestedPhone
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
