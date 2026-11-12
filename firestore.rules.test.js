const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment
} = require("@firebase/rules-unit-testing");
const {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    setDoc,
    updateDoc,
    where
} = require("firebase/firestore");

const projectId = "demo-salon-yevani-rules";
const fixture = {
    staff: { uid: "staff-user", phone: "0501234567", musicianId: "staff-1" },
    otherStaff: { uid: "other-staff-user", phone: "0507654321", musicianId: "staff-2" },
    manager: { uid: "manager-user", phone: "0503333333", musicianId: "manager-1" },
    otherManager: { uid: "other-manager-user", phone: "0502222222", musicianId: "manager-2" },
    admin: { uid: "admin-user", phone: "0504444444", musicianId: "admin-1" },
    owner: { uid: "owner-user", phone: "0547771121", musicianId: "owner-1" }
};

let testEnvironment;

function accountContext(account, claims = {}) {
    return testEnvironment.authenticatedContext(account.uid, {
        phoneVerified: true,
        verifiedPhone: account.phone,
        ...claims
    }).firestore();
}

before(async () => {
    testEnvironment = await initializeTestEnvironment({
        projectId,
        firestore: {
            rules: fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8")
        }
    });

    await testEnvironment.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        const accounts = [
            [fixture.staff, "Alice", "זמר/ת"],
            [fixture.otherStaff, "Dana", "קלידים"],
            [fixture.manager, "Maya", "מנהל סניף"],
            [fixture.otherManager, "Noa", "מנהל סניף"],
            [fixture.admin, "Admin", "זמר/ת"],
            [fixture.owner, "Owner", "זמר/ת"]
        ];

        for (const [account, name, role] of accounts) {
            await setDoc(doc(db, "users", account.uid), {
                phone: account.phone,
                phoneVerified: true,
                musicianId: account.musicianId,
                ...(account.uid === fixture.staff.uid ? { mustChangePassword: true } : {})
            });
            await setDoc(doc(db, "musicians", account.musicianId), {
                name,
                role,
                phone: account.phone,
                status: "active"
            });
        }

        await setDoc(doc(db, "branches", "branch-a"), {
            name: "Branch A",
            managerId: fixture.manager.musicianId,
            managerPhone: fixture.manager.phone
        });
        await setDoc(doc(db, "branches", "branch-b"), {
            name: "Branch B",
            managerId: fixture.otherManager.musicianId,
            managerPhone: fixture.otherManager.phone
        });

        await setDoc(doc(db, "events", "event-staff"), {
            date: "2026-11-20",
            branchId: "branch-a",
            assignedStaffIds: [fixture.staff.musicianId],
            assignedStaff: ["Alice (זמר/ת)"]
        });
        await setDoc(doc(db, "events", "event-other"), {
            date: "2026-11-20",
            branchId: "branch-b",
            assignedStaffIds: [fixture.otherStaff.musicianId],
            assignedStaff: ["Dana (קלידים)"]
        });
        await setDoc(doc(db, "unavailabilities", "staff-unavailable"), {
            phone: fixture.staff.phone,
            name: "Alice",
            date: "2026-11-21",
            createdAt: new Date()
        });
        await setDoc(doc(db, "unavailabilities", "other-unavailable"), {
            phone: fixture.otherStaff.phone,
            name: "Dana",
            date: "2026-11-21",
            createdAt: new Date()
        });
        await setDoc(doc(db, "password_reset_requests", "pending-reset"), {
            userPhone: fixture.staff.phone,
            userName: "Alice",
            status: "pending",
            createdAt: new Date()
        });
    });
});

after(async () => {
    await testEnvironment?.cleanup();
});

test("unauthenticated clients cannot read or write application data", async () => {
    const db = testEnvironment.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, "events", "event-staff")));
    await assertFails(getDocs(collection(db, "branches")));
    await assertFails(setDoc(doc(db, "users", "attacker"), { phone: "0500000000" }));
});

test("verified staff can read only their own profile, schedule, and availability", async () => {
    const db = accountContext(fixture.staff);

    await assertSucceeds(getDoc(doc(db, "users", fixture.staff.uid)));
    await assertFails(getDoc(doc(db, "users", fixture.otherStaff.uid)));
    await assertFails(updateDoc(doc(db, "users", fixture.staff.uid), {
        mustChangePassword: false,
        phone: fixture.otherStaff.phone
    }));
    await assertSucceeds(updateDoc(doc(db, "users", fixture.staff.uid), {
        mustChangePassword: false,
        tempPassword: null
    }));
    await assertSucceeds(getDoc(doc(db, "events", "event-staff")));
    await assertFails(getDoc(doc(db, "events", "event-other")));
    await assertSucceeds(getDocs(query(
        collection(db, "events"),
        where("assignedStaffIds", "array-contains", fixture.staff.musicianId)
    )));
    await assertFails(getDocs(collection(db, "events")));
    await assertSucceeds(getDocs(query(
        collection(db, "unavailabilities"),
        where("phone", "==", fixture.staff.phone)
    )));
    await assertFails(getDoc(doc(db, "unavailabilities", "other-unavailable")));

    await assertSucceeds(setDoc(doc(db, "push_tokens", fixture.staff.uid), {
        token: "staff-push-token",
        userPhone: fixture.staff.phone,
        userName: "Alice",
        updatedAt: new Date()
    }));
    await assertFails(setDoc(doc(db, "pending_pushes", "client-created"), {
        token: "staff-push-token"
    }));
    await assertFails(setDoc(doc(db, "password_reset_requests", "client-created"), {
        userPhone: fixture.staff.phone,
        status: "pending"
    }));
});

test("staff can request cancellation only for an event they are assigned to", async () => {
    const db = accountContext(fixture.staff);

    await assertSucceeds(setDoc(doc(db, "cancellation_requests", "valid-request"), {
        eventId: "event-staff",
        eventDate: "2026-11-20",
        eventTime: "20:00",
        branchId: "branch-a",
        branchName: "Branch A",
        musicianName: "Alice",
        musicianPhone: fixture.staff.phone,
        status: "pending",
        createdAt: new Date()
    }));
    await assertFails(setDoc(doc(db, "cancellation_requests", "forged-request"), {
        eventId: "event-other",
        eventDate: "2026-11-20",
        eventTime: "20:00",
        branchId: "branch-b",
        branchName: "Branch B",
        musicianName: "Alice",
        musicianPhone: fixture.staff.phone,
        status: "pending",
        createdAt: new Date()
    }));
});

test("branch managers are limited to their own branches and schedules", async () => {
    const db = accountContext(fixture.manager);

    await assertSucceeds(getDoc(doc(db, "branches", "branch-a")));
    await assertFails(getDoc(doc(db, "branches", "branch-b")));
    await assertSucceeds(getDocs(query(
        collection(db, "branches"),
        where("managerId", "==", fixture.manager.musicianId)
    )));
    await assertSucceeds(getDocs(query(
        collection(db, "events"),
        where("branchId", "==", "branch-a")
    )));
    await assertFails(getDoc(doc(db, "events", "event-other")));
    await assertFails(setDoc(doc(db, "unavailabilities", "manager-unavailable"), {
        phone: fixture.manager.phone,
        name: "Maya",
        date: "2026-11-22",
        createdAt: new Date()
    }));
});

test("system admins have administrative reads but cannot write server-owned records", async () => {
    const db = accountContext(fixture.admin, { admin: true });

    await assertSucceeds(getDocs(collection(db, "users")));
    await assertSucceeds(getDocs(collection(db, "events")));
    await assertSucceeds(getDocs(collection(db, "branches")));
    await assertSucceeds(getDocs(query(
        collection(db, "password_reset_requests"),
        where("status", "==", "pending")
    )));
    await assertFails(setDoc(doc(db, "musicians", "forged-staff"), {
        name: "Forged",
        phone: "0500000000"
    }));
    await assertFails(setDoc(doc(db, "password_reset_requests", "forged-request"), {
        userPhone: fixture.staff.phone,
        status: "pending"
    }));
    await assertFails(setDoc(doc(db, "settings", "system_status"), { isLocked: true }));
});

test("only the owner can change system settings", async () => {
    const ownerDb = accountContext(fixture.owner, {
        superOwner: true,
        email: "user_0547771121@salonyevani.local"
    });
    const adminDb = accountContext(fixture.admin, { admin: true });

    await assertSucceeds(setDoc(doc(ownerDb, "settings", "system_status"), {
        isLocked: true
    }));
    await assertFails(setDoc(doc(adminDb, "settings", "system_status"), {
        isLocked: true
    }));
});
