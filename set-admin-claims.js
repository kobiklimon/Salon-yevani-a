const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

async function main() {
    const [uid, action] = process.argv.slice(2);
    if (!uid || !["admin", "superOwner", "removeAdmin"].includes(action)) {
        throw new Error("Usage: node set-admin-claims.js <firebase-auth-uid> <admin|superOwner|removeAdmin>");
    }

    const auth = getAuth();
    const user = await auth.getUser(uid);
    const claims = { ...(user.customClaims || {}) };

    if (action === "removeAdmin") {
        delete claims.admin;
        delete claims.superOwner;
    } else {
        claims[action] = true;
        if (action === "superOwner") claims.admin = true;
    }

    await auth.setCustomUserClaims(uid, claims);
    console.log(`Updated custom claims for ${uid}: ${action}`);
}

main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
});
