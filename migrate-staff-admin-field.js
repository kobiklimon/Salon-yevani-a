const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT_ID = "salon-yevani-a";
const applyChanges = process.argv.includes("--apply");

initializeApp({ projectId: PROJECT_ID });

async function main() {
    const db = getFirestore();
    const musiciansSnapshot = await db.collection("musicians").get();
    const missingAdminField = musiciansSnapshot.docs.filter(document =>
        !Object.hasOwn(document.data(), "isAdmin")
    );

    console.log(`Project: ${PROJECT_ID}`);
    console.log(`Staff documents: ${musiciansSnapshot.size}`);
    console.log(`Documents missing isAdmin: ${missingAdminField.length}`);

    if (!applyChanges) {
        console.log("Dry run only. Re-run with --apply to add isAdmin: false to missing fields.");
        return;
    }

    let updated = 0;
    let skipped = 0;
    for (const document of missingAdminField) {
        const wasUpdated = await db.runTransaction(async transaction => {
            const currentDocument = await transaction.get(document.ref);
            if (!currentDocument.exists || Object.hasOwn(currentDocument.data(), "isAdmin")) {
                return false;
            }
            transaction.update(document.ref, { isAdmin: false });
            return true;
        });

        if (wasUpdated) updated++;
        else skipped++;
    }

    console.log(`Added isAdmin: false to ${updated} documents.`);
    console.log(`Skipped ${skipped} documents that changed during the migration.`);
}

main().catch(error => {
    console.error("Could not migrate staff isAdmin fields:", error);
    process.exitCode = 1;
});
