"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const db_1 = require("./db");
const PORT = Number(process.env.PORT || 3000);
async function main() {
    await (0, db_1.waitForDatabase)();
    await (0, db_1.migrate)();
    const app = (0, app_1.createApp)();
    app.listen(PORT, () => {
        console.log(`stowage-approval-service listening on port ${PORT}`);
    });
}
main().catch((err) => {
    console.error('fatal: failed to start service', err);
    process.exit(1);
});
