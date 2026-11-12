const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { logger } = require("firebase-functions");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { createHash, randomInt } = require("node:crypto");

initializeApp();

const db = getFirestore();
const SUPER_OWNER_PHONE = "0547771121";

function getTodayInJerusalem() {
    const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());
    const dateValues = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
    return `${dateValues.year}-${dateValues.month}-${dateValues.day}`;
}

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
        logger.info("Updating staff admin role", {
            musicianId,
            makeAdmin,
            callerUid: request.auth.uid
        });

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
            await musicianRef.set({ isAdmin: makeAdmin }, { merge: true });
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

function getVerifiedAccountPhone(request) {
    if (!request.auth || request.auth.token.phoneVerified !== true) return "";
    const phone = normalizePhone(request.auth.token.verifiedPhone);
    return /^05\d{8}$/.test(phone) ? phone : "";
}

async function enqueuePushNotifications(phones, title, body, tabTarget = "notifs") {
    const normalizedPhones = new Set(phones.map(normalizePhone).filter(Boolean));
    if (!normalizedPhones.size) return 0;

    const tokensSnapshot = await db.collection("push_tokens").get();
    const tokens = new Map();
    tokensSnapshot.docs.forEach(tokenSnapshot => {
        const tokenData = tokenSnapshot.data();
        if (normalizedPhones.has(normalizePhone(tokenData.userPhone)) &&
            typeof tokenData.token === "string" && tokenData.token) {
            tokens.set(tokenData.token, tokenData.token);
        }
    });

    const tokenValues = [...tokens.values()];
    for (let offset = 0; offset < tokenValues.length; offset += 400) {
        const batch = db.batch();
        tokenValues.slice(offset, offset + 400).forEach(token => {
            batch.set(db.collection("pending_pushes").doc(), {
                token,
                title,
                body,
                tabTarget,
                createdAt: FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
    }
    return tokenValues.length;
}

async function getAdministratorPhones() {
    const musiciansSnapshot = await db.collection("musicians").get();
    return [...new Set([
        SUPER_OWNER_PHONE,
        ...musiciansSnapshot.docs
            .filter(musicianSnapshot => musicianSnapshot.data().isAdmin === true)
            .map(musicianSnapshot => normalizePhone(musicianSnapshot.data().phone))
            .filter(Boolean)
    ])];
}

function getPhoneFromAuthEmail(email) {
    const match = String(email || "").toLowerCase().match(/^user_(\d{10,12})@salonyevani\.local$/);
    const phone = match ? normalizePhone(match[1]) : "";
    return /^05\d{8}$/.test(phone) ? phone : "";
}

async function verifyPhoneProof(request, phoneVerificationIdToken) {
    const accountPhone = getPhoneFromAuthEmail(request.auth.token.email);
    if (!accountPhone || typeof phoneVerificationIdToken !== "string" || !phoneVerificationIdToken) {
        throw new HttpsError("invalid-argument", "לא ניתן לאמת את מספר הטלפון של החשבון.");
    }

    let verificationToken;
    try {
        verificationToken = await getAuth().verifyIdToken(phoneVerificationIdToken);
    } catch (error) {
        logger.warn("Phone verification proof token was rejected", {
            uid: request.auth.uid,
            errorCode: String(error.code || "unknown")
        });
        throw new HttpsError("permission-denied", "אימות ה-SMS פג או שאינו תקין. יש לשלוח קוד חדש.");
    }

    const verifiedPhone = normalizePhone(verificationToken.phone_number);
    if (!verifiedPhone || verifiedPhone !== accountPhone ||
        verificationToken.firebase?.sign_in_provider !== "phone") {
        throw new HttpsError("permission-denied", "מספר הטלפון שאומת אינו תואם לחשבון.");
    }

    return accountPhone;
}

exports.completeStaffRegistration = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי להשלים הרשמה.");
    }
    const { name, role, phoneVerificationIdToken } = request.data || {};
    if (typeof name !== "string" || !name.trim() ||
        !["זמר/ת", "קלידים", "בוזוקי"].includes(role)) {
        throw new HttpsError("invalid-argument", "פרטי ההרשמה אינם תקינים. תפקיד מנהל סניף מוקצה על ידי בעל המערכת.");
    }

    const phone = await verifyPhoneProof(request, phoneVerificationIdToken);
    const userRef = db.collection("users").doc(request.auth.uid);
    const existingUsers = await db.collection("users").where("phone", "==", phone).get();
    const existingUserForPhone = existingUsers.docs.find(profile => profile.id !== request.auth.uid);
    if (existingUserForPhone) {
        throw new HttpsError("already-exists", "מספר הטלפון כבר משויך לחשבון אחר.");
    }

    const musiciansSnapshot = await db.collection("musicians").get();
    const existingMusicians = musiciansSnapshot.docs.filter(musician =>
        normalizePhone(musician.data().phone) === phone
    );
    if (existingMusicians.length > 1) {
        throw new HttpsError("failed-precondition", "נמצאו כמה אנשי צוות למספר הטלפון. יש לפנות לבעל המערכת.");
    }

    const musicianRef = existingMusicians[0]?.ref || db.collection("musicians").doc();
    const musicianData = existingMusicians[0]?.data();
    if (musicianData && musicianData.role !== role) {
        throw new HttpsError("failed-precondition", "מספר הטלפון כבר רשום בתפקיד אחר. יש לפנות לבעל המערכת לעדכון.");
    }

    const auth = getAuth();
    const userRecord = await auth.getUser(request.auth.uid);
    await auth.setCustomUserClaims(request.auth.uid, {
        ...(userRecord.customClaims || {}),
        phoneVerified: true,
        verifiedPhone: phone
    });

    await db.runTransaction(async transaction => {
        const [userSnapshot, musicianSnapshot] = await Promise.all([
            transaction.get(userRef),
            transaction.get(musicianRef)
        ]);
        if (userSnapshot.exists &&
            (normalizePhone(userSnapshot.data().phone) !== phone ||
                userSnapshot.data().phoneVerified !== true)) {
            throw new HttpsError("already-exists", "לחשבון כבר קיים פרופיל שאינו תואם להרשמה.");
        }

        transaction.set(userRef, {
            phone,
            phoneVerified: true,
            role: "user",
            name: name.trim(),
            musicianId: musicianRef.id
        }, { merge: true });
        if (musicianSnapshot.exists) {
            transaction.update(musicianRef, {
                name: name.trim(),
                phone,
                status: musicianSnapshot.data().status || "active"
            });
        } else {
            transaction.set(musicianRef, {
                name: name.trim(),
                role,
                phone,
                status: "active",
                isAdmin: false
            });
        }
    });

    return { phoneVerified: true };
});

exports.verifyPhoneForAccount = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לאמת את מספר הטלפון.");
    }
    const phone = await verifyPhoneProof(request, request.data?.phoneVerificationIdToken);
    const profileRef = db.collection("users").doc(request.auth.uid);
    const profileSnapshot = await profileRef.get();
    if (!profileSnapshot.exists || normalizePhone(profileSnapshot.data().phone) !== phone) {
        throw new HttpsError("failed-precondition", "פרופיל החשבון אינו תואם למספר שאומת.");
    }

    const musicianSnapshot = await db.collection("musicians").get();
    const matchingMusicians = musicianSnapshot.docs.filter(musician =>
        normalizePhone(musician.data().phone) === phone
    );
    if (matchingMusicians.length > 1) {
        throw new HttpsError("failed-precondition", "נמצאו כמה אנשי צוות למספר הטלפון. יש לפנות לבעל המערכת.");
    }

    await profileRef.set({
        phoneVerified: true,
        ...(matchingMusicians.length ? { musicianId: matchingMusicians[0].id } : {})
    }, { merge: true });
    if (matchingMusicians.length) {
        await matchingMusicians[0].ref.update({ phone });
    }

    const auth = getAuth();
    const userRecord = await auth.getUser(request.auth.uid);
    await auth.setCustomUserClaims(request.auth.uid, {
        ...(userRecord.customClaims || {}),
        phoneVerified: true,
        verifiedPhone: phone
    });
    return { phoneVerified: true };
});

exports.getBranchDirectory = onCall(async request => {
    if (!request.auth || request.auth.token.phoneVerified !== true) {
        throw new HttpsError("unauthenticated", "יש להתחבר ולאמת את מספר הטלפון.");
    }
    const profileSnapshot = await db.collection("users").doc(request.auth.uid).get();
    const verifiedPhone = normalizePhone(request.auth.token.verifiedPhone);
    if (!profileSnapshot.exists || !verifiedPhone ||
        normalizePhone(profileSnapshot.data().phone) !== verifiedPhone ||
        profileSnapshot.data().phoneVerified !== true) {
        throw new HttpsError("permission-denied", "אימות הטלפון של החשבון אינו תקף.");
    }

    const branchIds = request.data?.branchIds;
    if (!Array.isArray(branchIds) || branchIds.length > 100 ||
        branchIds.some(branchId => typeof branchId !== "string" || !branchId)) {
        throw new HttpsError("invalid-argument", "רשימת הסניפים אינה תקינה.");
    }

    const branchSnapshots = await Promise.all([...new Set(branchIds)].map(branchId =>
        db.collection("branches").doc(branchId).get()
    ));
    return {
        branches: branchSnapshots
            .filter(branchSnapshot => branchSnapshot.exists)
            .map(branchSnapshot => {
                const branch = branchSnapshot.data();
                return {
                    id: branchSnapshot.id,
                    name: String(branch.name || ""),
                    color: String(branch.color || "#1e88e5")
                };
            })
    };
});

exports.submitPasswordResetRequest = onCall(async request => {
    const phone = normalizePhone(request.data?.phone);
    if (!/^05\d{8}$/.test(phone)) {
        throw new HttpsError("invalid-argument", "יש להזין מספר טלפון נייד תקין.");
    }

    const requestIp = String(request.rawRequest?.ip || "unknown");
    const ipKey = createHash("sha256").update(requestIp).digest("hex");
    const rateLimitRef = db.collection("password_reset_rate_limits").doc(ipKey);
    await db.runTransaction(async transaction => {
        const now = Date.now();
        const rateLimitSnapshot = await transaction.get(rateLimitRef);
        const rateLimit = rateLimitSnapshot.exists ? rateLimitSnapshot.data() : {};
        const windowStartedAt = Number(rateLimit.windowStartedAt || 0);
        const requestCount = now - windowStartedAt < 15 * 60 * 1000
            ? Number(rateLimit.requestCount || 0)
            : 0;
        if (requestCount >= 5) {
            throw new HttpsError("resource-exhausted", "נשלחו יותר מדי בקשות. יש לנסות שוב מאוחר יותר.");
        }
        transaction.set(rateLimitRef, {
            windowStartedAt: requestCount ? windowStartedAt : now,
            requestCount: requestCount + 1
        });
    });

    const musiciansSnapshot = await db.collection("musicians").get();
    const matchedMusician = musiciansSnapshot.docs.find(musician =>
        normalizePhone(musician.data().phone) === phone
    );
    const requestRef = db.collection("password_reset_requests").doc();
    await requestRef.set({
        userPhone: phone,
        userName: matchedMusician ? String(matchedMusician.data().name || "") : "",
        status: "pending",
        createdAt: FieldValue.serverTimestamp()
    });

    try {
        const adminPhones = await getAdministratorPhones();
        await enqueuePushNotifications(
            adminPhones,
            "🔑 בקשת איפוס סיסמה",
            "התקבלה בקשת איפוס סיסמה במערכת."
        );
    } catch (error) {
        logger.error("Password reset request was saved, but administrator pushes could not be queued", {
            requestId: requestRef.id,
            error: String(error.message || error)
        });
    }

    return { requestId: requestRef.id };
});

exports.notifyAdminsOfCancellationRequest = onCall(async request => {
    const phone = getVerifiedAccountPhone(request);
    if (!phone) {
        throw new HttpsError("unauthenticated", "יש להתחבר ולאמת את מספר הטלפון.");
    }
    const requestId = request.data?.requestId;
    if (typeof requestId !== "string" || !requestId) {
        throw new HttpsError("invalid-argument", "מזהה בקשת הביטול אינו תקין.");
    }

    const cancellationRef = db.collection("cancellation_requests").doc(requestId);
    const cancellationSnapshot = await cancellationRef.get();
    if (!cancellationSnapshot.exists ||
        normalizePhone(cancellationSnapshot.data().musicianPhone) !== phone ||
        cancellationSnapshot.data().status !== "pending") {
        throw new HttpsError("permission-denied", "לא ניתן לשלוח התראה עבור בקשה זו.");
    }

    const eventDate = String(cancellationSnapshot.data().eventDate || "");
    const branchName = String(cancellationSnapshot.data().branchName || "סניף");
    const musicianName = String(cancellationSnapshot.data().musicianName || "איש צוות");
    const adminPhones = await getAdministratorPhones();
    const queued = await enqueuePushNotifications(
        adminPhones,
        "🚨 בקשת ביטול חדשה",
        `${musicianName} ביקש/ה ביטול הופעה בסניף ${branchName} בתאריך ${eventDate}.`
    );
    return { queued };
});

exports.sendBroadcastPush = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לשלוח הודעה.");
    }
    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.admin !== true &&
        request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const message = request.data?.message;
    if (typeof message !== "string" || !message.trim() || message.length > 1000) {
        throw new HttpsError("invalid-argument", "תוכן ההודעה אינו תקין.");
    }
    const tokensSnapshot = await db.collection("push_tokens").get();
    const tokens = [...new Set(tokensSnapshot.docs
        .map(tokenSnapshot => tokenSnapshot.data().token)
        .filter(token => typeof token === "string" && token))];
    for (let offset = 0; offset < tokens.length; offset += 400) {
        const batch = db.batch();
        tokens.slice(offset, offset + 400).forEach(token => {
            batch.set(db.collection("pending_pushes").doc(), {
                token,
                title: "📢 הודעה חדשה לכל הצוות",
                body: message.trim(),
                tabTarget: "notifs",
                createdAt: FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
    }
    return { queued: tokens.length };
});

exports.resetApplicationData = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לאפס את המערכת.");
    }
    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "איפוס המערכת זמין לבעל המערכת בלבד.");
    }
    if (request.data?.confirmation !== "מאפס") {
        throw new HttpsError("failed-precondition", "אישור איפוס המערכת אינו תקין.");
    }

    const deletedCounts = {};
    for (const collectionName of [
        "events",
        "musicians",
        "branches",
        "cancellation_requests",
        "unavailabilities"
    ]) {
        let deletedCount = 0;
        while (true) {
            const snapshot = await db.collection(collectionName).limit(400).get();
            if (snapshot.empty) break;
            const batch = db.batch();
            snapshot.docs.forEach(document => batch.delete(document.ref));
            await batch.commit();
            deletedCount += snapshot.size;
        }
        deletedCounts[collectionName] = deletedCount;
    }
    return { deletedCounts };
});

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

exports.approveCancellationRequest = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לאשר בקשת ביטול.");
    }
    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const { requestId, replacementMusicianId } = request.data || {};
    if (typeof requestId !== "string" || !requestId ||
        typeof replacementMusicianId !== "string" || !replacementMusicianId) {
        throw new HttpsError("invalid-argument", "פרטי אישור בקשת הביטול אינם תקינים.");
    }

    const requestRef = db.collection("cancellation_requests").doc(requestId);
    const approvedRequest = await db.runTransaction(async transaction => {
        const requestSnapshot = await transaction.get(requestRef);
        if (!requestSnapshot.exists || requestSnapshot.data().status !== "pending") {
            throw new HttpsError("failed-precondition", "הבקשה כבר טופלה או שאינה זמינה.");
        }

        const cancellation = requestSnapshot.data();
        if (typeof cancellation.eventId !== "string" || typeof cancellation.eventDate !== "string") {
            throw new HttpsError("failed-precondition", "לבקשת הביטול חסרים פרטי הופעה תקינים.");
        }

        const eventRef = db.collection("events").doc(cancellation.eventId);
        const eventSnapshot = await transaction.get(eventRef);
        if (!eventSnapshot.exists || eventSnapshot.data().date !== cancellation.eventDate) {
            throw new HttpsError("failed-precondition", "ההופעה כבר אינה קיימת או שפרטיה השתנו.");
        }
        const dayEventsQuery = db.collection("events").where("date", "==", eventSnapshot.data().date);
        const dayUnavailabilitiesQuery = db.collection("unavailabilities").where("date", "==", eventSnapshot.data().date);
        const [dayEventsSnapshot, unavailabilitiesSnapshot, musiciansSnapshot] = await Promise.all([
            transaction.get(dayEventsQuery),
            transaction.get(dayUnavailabilitiesQuery),
            transaction.get(db.collection("musicians"))
        ]);

        const musicians = musiciansSnapshot.docs.map(musicianDocument => ({
            id: musicianDocument.id,
            ...musicianDocument.data()
        }));
        const musiciansById = new Map(musicians.map(musician => [musician.id, musician]));
        const event = { id: eventSnapshot.id, ...eventSnapshot.data() };
        const dayEvents = dayEventsSnapshot.docs.map(eventDocument => ({
            id: eventDocument.id,
            ...eventDocument.data()
        }));
        const target = musicians.find(musician =>
            normalizePhone(musician.phone) === normalizePhone(cancellation.musicianPhone)
        );
        const replacement = musiciansById.get(replacementMusicianId);
        if (!target) {
            throw new HttpsError("failed-precondition", "לא ניתן לזהות את איש הצוות שביקש את הביטול.");
        }

        const assignedStaff = Array.isArray(event.assignedStaff) ? event.assignedStaff : [];
        const cancelledEntry = assignedStaff.find(entry =>
            entry === `${target.name} (${target.role})`
        ) || assignedStaff.find(entry =>
            String(entry).startsWith(`${cancellation.musicianName} (`)
        );
        const cancelledRole = cancelledEntry && cancelledEntry.match(/\(([^()]*)\)$/)?.[1];
        if (!cancelledEntry || !cancelledRole) {
            throw new HttpsError("failed-precondition", "איש הצוות כבר אינו משובץ להופעה.");
        }
        const replacementTarget = { ...target, role: cancelledRole };
        const unavailablePhones = new Set(unavailabilitiesSnapshot.docs.map(unavailableDocument =>
            normalizePhone(unavailableDocument.data().phone)
        ));
        validateReplacement(event, replacementTarget, replacement, dayEvents, unavailablePhones);

        const musicianIds = getEventStaffIds(event, musiciansById)
            .filter(musicianId => musicianId !== target.id);
        musicianIds.push(replacement.id);
        const updatedStaff = assignedStaff.filter(entry => entry !== cancelledEntry);
        updatedStaff.push(`${replacement.name} (${replacement.role})`);
        const existingDetails = Array.isArray(event.assignedStaffDetails) && event.assignedStaffDetails.length
            ? event.assignedStaffDetails
            : getEventStaffIds(event, musiciansById)
                .map(musicianId => musiciansById.get(musicianId))
                .filter(Boolean)
                .map(musician => ({
                    musicianId: musician.id,
                    name: musician.name,
                    role: musician.role,
                    phoneId: normalizePhone(musician.phone)
                }));
        const staffDetails = existingDetails.filter(staff => staff.musicianId !== target.id);
        staffDetails.push({
            musicianId: replacement.id,
            name: replacement.name,
            role: replacement.role,
            phoneId: normalizePhone(replacement.phone)
        });

        transaction.update(eventRef, {
            assignedStaff: updatedStaff,
            assignedStaffIds: musicianIds,
            assignedStaffDetails: staffDetails
        });
        transaction.update(requestRef, {
            status: "approved",
            replacementName: replacement.name,
            replacementPhone: replacement.phone,
            resolvedAt: FieldValue.serverTimestamp(),
            resolvedByUid: request.auth.uid
        });

        return {
            requestId,
            musicianPhone: cancellation.musicianPhone,
            musicianName: cancellation.musicianName,
            eventDate: cancellation.eventDate,
            replacementName: replacement.name,
            replacementRole: replacement.role,
            replacementPhone: replacement.phone
        };
    });

    return approvedRequest;
});

exports.notifyStaffOfCancellationResolution = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לשלוח התראה.");
    }
    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.admin !== true &&
        request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const requestId = request.data?.requestId;
    if (typeof requestId !== "string" || !requestId) {
        throw new HttpsError("invalid-argument", "מזהה בקשת הביטול אינו תקין.");
    }
    const cancellationSnapshot = await db.collection("cancellation_requests").doc(requestId).get();
    if (!cancellationSnapshot.exists ||
        !["approved", "rejected"].includes(cancellationSnapshot.data().status)) {
        throw new HttpsError("failed-precondition", "בקשת הביטול עדיין לא הוכרעה.");
    }

    const cancellation = cancellationSnapshot.data();
    const isApproved = cancellation.status === "approved";
    const title = isApproved ? "✅ בקשת הביטול אושרה" : "❌ בקשת הביטול נדחתה";
    const body = isApproved
        ? `בקשתך אושרה. ${cancellation.replacementName || "איש צוות אחר"} יחליף אותך בהופעה.`
        : `בקשתך לביטול הופעה בסניף ${cancellation.branchName || "ההופעה"} נדחתה.`;
    let notificationQueued = false;
    try {
        notificationQueued = (await enqueuePushNotifications(
            [cancellation.musicianPhone],
            title,
            body
        )) > 0;
    } catch (error) {
        logger.error("Cancellation was resolved, but the staff push could not be queued", {
            requestId,
            error: String(error.message || error)
        });
    }
    return { notificationQueued };
});

exports.rejectCancellationRequest = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לדחות בקשת ביטול.");
    }
    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
        throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
    }

    const { requestId } = request.data || {};
    if (typeof requestId !== "string" || !requestId) {
        throw new HttpsError("invalid-argument", "מזהה בקשת הביטול אינו תקין.");
    }
    const requestRef = db.collection("cancellation_requests").doc(requestId);
    const rejectedRequest = await db.runTransaction(async transaction => {
        const requestSnapshot = await transaction.get(requestRef);
        if (!requestSnapshot.exists || requestSnapshot.data().status !== "pending") {
            throw new HttpsError("failed-precondition", "הבקשה כבר טופלה או שאינה זמינה.");
        }
        const cancellation = requestSnapshot.data();
        transaction.update(requestRef, {
            status: "rejected",
            resolvedAt: FieldValue.serverTimestamp(),
            resolvedByUid: request.auth.uid
        });
        return {
            musicianPhone: cancellation.musicianPhone,
            branchName: cancellation.branchName || "ההופעה"
        };
    });

    let notificationQueued = true;
    try {
        notificationQueued = (await enqueuePushNotifications(
            [rejectedRequest.musicianPhone],
            "❌ בקשת הביטול נדחתה",
            `בקשתך לביטול הופעה בסניף ${rejectedRequest.branchName} נדחתה.`
        )) > 0;
    } catch (error) {
        notificationQueued = false;
        logger.error("Cancellation was rejected, but the staff push could not be queued", {
            requestId,
            error: String(error.message || error)
        });
    }
    return { notificationQueued };
});

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
    await db.runTransaction(async transaction => {
        const [musicianSnapshot, branchesSnapshot] = await Promise.all([
            transaction.get(musicianRef),
            transaction.get(db.collection("branches"))
        ]);
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

        transaction.update(musicianRef, { name: name.trim(), role, status });
        const managedBranches = branchesSnapshot.docs.filter(branchSnapshot => {
            const branch = branchSnapshot.data();
            return branch.managerId === musicianId ||
                (normalizePhone(previousMusician.phone) &&
                    normalizePhone(branch.managerPhone) === normalizePhone(previousMusician.phone));
        });
        managedBranches.forEach(branchSnapshot => {
            if (role === "מנהל סניף" && status !== "inactive") {
                transaction.update(branchSnapshot.ref, {
                    managerId: musicianId,
                    managerName: name.trim(),
                    managerPhone: previousMusician.phone
                });
            } else {
                transaction.update(branchSnapshot.ref, {
                    managerId: FieldValue.delete(),
                    managerName: FieldValue.delete(),
                    managerPhone: FieldValue.delete()
                });
            }
        });
    });
    return { musicianId, name: name.trim(), role, status };
});

exports.changeStaffContact = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "יש להתחבר כדי לשנות איש צוות.");
    }
    const callerEmail = String(request.auth.token.email || "").toLowerCase();
    const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
    if (!isSuperOwner && request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
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

    const today = getTodayInJerusalem();
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
        const currentBranchesSnapshot = await transaction.get(db.collection("branches"));

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
        const currentManagedBranches = currentBranchesSnapshot.docs.filter(branchSnapshot => {
            const branch = branchSnapshot.data();
            return branch.managerId === currentTarget.id ||
                (normalizePhone(currentTarget.phone) &&
                    normalizePhone(branch.managerPhone) === normalizePhone(currentTarget.phone));
        });

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
        currentManagedBranches.forEach(branchSnapshot => {
            transaction.update(branchSnapshot.ref, {
                managerId: FieldValue.delete(),
                managerName: FieldValue.delete(),
                managerPhone: FieldValue.delete()
            });
        });
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
    let operation = "אימות מנהל";
    let requestId = "";
    try {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "יש להתחבר כדי לאפס סיסמה.");
        }
        const callerEmail = String(request.auth.token.email || "").toLowerCase();
        const isSuperOwner = callerEmail === `user_${SUPER_OWNER_PHONE}@salonyevani.local`;
        if (!isSuperOwner && request.auth.token.admin !== true && request.auth.token.superOwner !== true) {
            throw new HttpsError("permission-denied", "פעולה זו זמינה למנהלי מערכת בלבד.");
        }

        requestId = request.data && request.data.requestId;
        if (typeof requestId !== "string" || !requestId.trim()) {
            throw new HttpsError("invalid-argument", "בקשת איפוס לא תקינה.");
        }

        operation = "קריאת בקשת האיפוס";
        const resetRequestRef = db.collection("password_reset_requests").doc(requestId);
        const resetRequestSnapshot = await resetRequestRef.get();
        if (!resetRequestSnapshot.exists || resetRequestSnapshot.data().status !== "pending") {
            throw new HttpsError("failed-precondition", "בקשת האיפוס כבר טופלה או שאינה קיימת.");
        }

        const requestedPhone = normalizePhone(resetRequestSnapshot.data().userPhone);
        if (!requestedPhone) {
            throw new HttpsError("failed-precondition", "לבקשה אין מספר טלפון תקין.");
        }

        operation = "איתור חשבון המשתמש";
        const usersSnapshot = await db.collection("users").get();
        const matchingUsers = usersSnapshot.docs.filter(userDocument =>
            normalizePhone(userDocument.data().phone) === requestedPhone
        );
        if (matchingUsers.length !== 1) {
            throw new HttpsError("failed-precondition", "לא נמצא חשבון יחיד התואם למספר הטלפון.");
        }

        const targetUserDocument = matchingUsers[0];
        const processingAt = FieldValue.serverTimestamp();
        operation = "סימון בקשת האיפוס כבטיפול";
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
            operation = "עדכון פרופיל המשתמש";
            await targetUserDocument.ref.update({
                mustChangePassword: true,
                tempPassword: FieldValue.delete()
            });
            operation = "עדכון סיסמת Firebase Authentication";
            await getAuth().updateUser(targetUserDocument.id, { password: temporaryPassword });
        } catch (error) {
            const rollback = await Promise.allSettled([
                resetRequestRef.update({ status: "pending", processingAt: FieldValue.delete() }),
                targetUserDocument.ref.update({
                    mustChangePassword: mustChangePasswordBeforeReset ? true : FieldValue.delete()
                })
            ]);
            rollback.forEach((result, index) => {
                if (result.status === "rejected") {
                    logger.error("Password reset rollback failed", {
                        requestId,
                        rollbackOperation: index === 0 ? "reset request" : "user profile",
                        errorCode: String(result.reason?.code || "unknown"),
                        error: String(result.reason?.message || result.reason)
                    });
                }
            });
            throw error;
        }

        let resetRequestRecorded = true;
        try {
            operation = "עדכון סטטוס בקשת האיפוס";
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
                errorCode: String(recordError.code || "unknown"),
                error: String(recordError.message || recordError)
            });
        }

        return {
            temporaryPassword,
            userName: String(targetUserDocument.data().name || resetRequestSnapshot.data().userName || "המשתמש"),
            resetRequestRecorded
        };
    } catch (error) {
        if (error instanceof HttpsError) throw error;
        const errorCode = String(error.code || "unknown");
        logger.error("Password reset failed", {
            requestId,
            operation,
            errorCode,
            error: String(error.message || error)
        });
        throw new HttpsError(
            "internal",
            `איפוס הסיסמה נכשל בשלב "${operation}" (${errorCode}). יש לבדוק את יומני הפונקציה ואת הרשאות חשבון השירות.`
        );
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

function getEventSingers(eventData) {
    const singerDetails = Array.isArray(eventData.assignedStaffDetails)
        ? eventData.assignedStaffDetails.filter(staff => staff.role === "זמר/ת")
        : [];
    if (singerDetails.length) {
        return new Map(singerDetails.map(staff => [
            staff.musicianId || normalizePhone(staff.phoneId) || String(staff.name || ""),
            String(staff.name || "זמר/ת")
        ]));
    }

    return new Map((Array.isArray(eventData.assignedStaff) ? eventData.assignedStaff : [])
        .map(assignment => String(assignment).match(/^(.*?)\s+\(זמר\/ת\)$/))
        .filter(Boolean)
        .map(match => [match[1], match[1]]));
}

exports.notifyBranchManagerOfSingerChange = onDocumentWritten(
    { document: "events/{eventId}", retry: true },
    async event => {
        const beforeSnapshot = event.data.before;
        const afterSnapshot = event.data.after;
        if (!afterSnapshot.exists) return;

        const after = afterSnapshot.data();
        const beforeSingers = beforeSnapshot.exists
            ? getEventSingers(beforeSnapshot.data())
            : new Map();
        const afterSingers = getEventSingers(after);
        const beforeIds = [...beforeSingers.keys()].sort();
        const afterIds = [...afterSingers.keys()].sort();
        if (JSON.stringify(beforeIds) === JSON.stringify(afterIds)) return;

        const branchId = after.branchId;
        if (typeof branchId !== "string" || !branchId) {
            logger.warn("Singer assignment changed on an event without a branch", {
                eventId: event.params.eventId
            });
            return;
        }

        const branchSnapshot = await db.collection("branches").doc(branchId).get();
        if (!branchSnapshot.exists) {
            logger.warn("Could not notify branch manager because the event branch was not found", {
                eventId: event.params.eventId,
                branchId
            });
            return;
        }
        const branch = branchSnapshot.data();
        let managerPhone = normalizePhone(branch.managerPhone);
        if (!managerPhone && typeof branch.managerId === "string" && branch.managerId) {
            const managerSnapshot = await db.collection("musicians").doc(branch.managerId).get();
            if (managerSnapshot.exists) managerPhone = normalizePhone(managerSnapshot.data().phone);
        }
        if (!managerPhone) return;

        const pushTokensSnapshot = await db.collection("push_tokens").get();
        const managerTokens = pushTokensSnapshot.docs.filter(pushSnapshot =>
            normalizePhone(pushSnapshot.data().userPhone) === managerPhone &&
            typeof pushSnapshot.data().token === "string" &&
            pushSnapshot.data().token
        );
        if (!managerTokens.length) return;

        const previousNames = [...beforeSingers.values()];
        const currentNames = [...afterSingers.values()];
        const eventTime = String(event.time || "לא צוינה");
        const description = `השתנה שיבוץ הזמר להופעה בסניף ${String(branch.name || "שלך")} בתאריך ${String(after.date || "לא צוין")} בשעה ${eventTime}.`;
        const singerLine = currentNames.length
            ? `הזמר/ת כעת: ${currentNames.join(", ")}.`
            : "כרגע לא משובץ/ת זמר/ת.";
        const changeLine = previousNames.length
            ? `לפני השינוי: ${previousNames.join(", ")}. `
            : "";
        const notificationId = `${event.params.eventId}_${event.time.replace(/[^0-9A-Za-z_-]/g, "_")}`;
        const batch = db.batch();
        managerTokens.forEach(pushSnapshot => {
            batch.set(db.collection("pending_pushes").doc(
                `singer_change_${notificationId}_${pushSnapshot.id}`
            ), {
                token: pushSnapshot.data().token,
                title: "עדכון שיבוץ זמר",
                body: `${description} ${changeLine}${singerLine}`,
                tabTarget: "calendar",
                createdAt: FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
    }
);
