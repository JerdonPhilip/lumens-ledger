(function () {
    "use strict";

    const databaseName = "ph-sales-tracker";
    const storeName = "files";
    const backupStoreName = "daily-backups";
    const dailyDatabaseStoreName = "daily-databases";
    const databaseKey = "sales.sqlite";
    const directoryHandleKey = "daily-database-folder";
    const legacyKey = "ph_sales_tracker_v3";
    const requiredColumns = [
        "id", "sale_date", "invoice_no", "description", "gross", "calc_type",
        "pay_type", "net", "sc_discount", "vat_amount", "fee_rate",
        "fee_amount", "final_total", "time"
    ];
    const legacyExpenseColumns = ["id", "expense_date", "description", "category", "amount", "payment_method", "notes"];
    const schema = `
        CREATE TABLE IF NOT EXISTS sales (
            id TEXT PRIMARY KEY NOT NULL,
            sale_date TEXT NOT NULL CHECK(length(sale_date) = 8),
            invoice_no TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL,
            gross REAL NOT NULL,
            calc_type TEXT NOT NULL CHECK(calc_type IN ('vat', 'sc')),
            pay_type TEXT NOT NULL CHECK(pay_type IN ('Cash', 'GCash', 'Card', 'Credit')),
            net REAL NOT NULL,
            sc_discount REAL NOT NULL DEFAULT 0,
            vat_amount REAL NOT NULL DEFAULT 0,
            fee_rate REAL NOT NULL DEFAULT 0,
            fee_amount REAL NOT NULL DEFAULT 0,
            final_total REAL NOT NULL,
            time TEXT NOT NULL DEFAULT '',
            cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS sales_by_date ON sales(sale_date, id DESC);
        CREATE TABLE IF NOT EXISTS expenses (
            id TEXT PRIMARY KEY NOT NULL,
            expense_date TEXT NOT NULL CHECK(length(expense_date) = 8),
            description TEXT NOT NULL,
            payee TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'Other',
            amount REAL NOT NULL CHECK(amount > 0),
            payment_method TEXT NOT NULL DEFAULT 'Cash'
                CHECK(payment_method IN ('Cash', 'GCash', 'Card', 'Credit', 'Other')),
            notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS expenses_by_date ON expenses(expense_date, id DESC);
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO settings (key, value) VALUES ('show_dashboard_vat', '0');
        PRAGMA user_version = 6;
    `;

    let SQL;
    let database;
    let indexedDatabase;

    function requireDatabase() {
        if (!database) throw new Error("The SQLite database is not ready. Reload the app and check its startup error.");
        return database;
    }

    function createUuidV4() {
        if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
            throw new Error("This browser cannot securely generate UUID record IDs.");
        }
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
        return [
            hex.slice(0, 4).join(""),
            hex.slice(4, 6).join(""),
            hex.slice(6, 8).join(""),
            hex.slice(8, 10).join(""),
            hex.slice(10, 16).join("")
        ].join("-");
    }

    function isUuidV4(value) {
        return typeof value === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    function openIndexedDatabase() {
        if (indexedDatabase) return indexedDatabase;
        indexedDatabase = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 3);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(storeName)) {
                    request.result.createObjectStore(storeName);
                }
                if (!request.result.objectStoreNames.contains(backupStoreName)) {
                    request.result.createObjectStore(backupStoreName);
                }
                if (!request.result.objectStoreNames.contains(dailyDatabaseStoreName)) {
                    request.result.createObjectStore(dailyDatabaseStoreName);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Could not open local database storage."));
            request.onblocked = () => reject(new Error("Local database storage is blocked by another open tab."));
        });
        return indexedDatabase;
    }

    async function readStoredDatabase() {
        const idb = await openIndexedDatabase();
        return new Promise((resolve, reject) => {
            const transaction = idb.transaction(storeName, "readonly");
            const request = transaction.objectStore(storeName).get(databaseKey);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error("Could not read the saved SQLite database."));
            transaction.onerror = () => reject(transaction.error || new Error("Could not read the saved SQLite database."));
        });
    }

    function getLocalDateString() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }

    function getDateSuffix(date) {
        const [year, month, day] = date.split("-");
        return `${month}${day}${year}`;
    }

    function getDailyFilename(date) {
        assertDate(date);
        return `LL-${getDateSuffix(date)}.sqlite`;
    }

    async function readStoredValue(store, key) {
        const idb = await openIndexedDatabase();
        return new Promise((resolve, reject) => {
            const transaction = idb.transaction(store, "readonly");
            const request = transaction.objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error("Could not read local database settings."));
            transaction.onerror = () => reject(transaction.error || new Error("Could not read local database settings."));
        });
    }

    async function writeStoredValue(store, key, value) {
        const idb = await openIndexedDatabase();
        return new Promise((resolve, reject) => {
            const transaction = idb.transaction(store, "readwrite");
            transaction.objectStore(store).put(value, key);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error("Could not save local database settings."));
            transaction.onabort = () => reject(transaction.error || new Error("Saving local database settings was aborted."));
        });
    }

    async function getDirectoryHandle() {
        return readStoredValue(storeName, directoryHandleKey);
    }

    async function getDirectoryStatus() {
        const handle = await getDirectoryHandle();
        if (!handle) return {
            supported: typeof window.showDirectoryPicker === "function",
            secureContext: window.isSecureContext,
            protocol: window.location.protocol,
            connected: false,
            available: false,
            name: ""
        };
        const permission = typeof handle.queryPermission === "function"
            ? await handle.queryPermission({ mode: "readwrite" })
            : "prompt";
        return {
            supported: typeof window.showDirectoryPicker === "function",
            secureContext: window.isSecureContext,
            protocol: window.location.protocol,
            connected: true,
            available: permission === "granted",
            name: handle.name || "Selected folder"
        };
    }

    async function chooseDataFolder() {
        if (typeof window.showDirectoryPicker !== "function") {
            throw new Error("This browser does not provide folder access for this page. Keep using browser storage and downloads, or open the app from localhost or HTTPS in a recent Chromium-based browser.");
        }
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        const permission = await handle.requestPermission({ mode: "readwrite" });
        if (permission !== "granted") throw new Error("Folder access was not granted.");
        await writeStoredValue(storeName, directoryHandleKey, handle);
        const dates = listDatabaseDates();
        for (const date of dates) {
            const filename = getDailyFilename(date);
            try {
                await handle.getFileHandle(filename);
            } catch (error) {
                if (error.name !== "NotFoundError") throw error;
                await writeDirectoryFile(handle, filename, exportDateDatabase(date));
            }
        }
        return { name: handle.name || "Selected folder", migratedDates: dates.length };
    }

    async function getGrantedDirectory() {
        const handle = await getDirectoryHandle();
        if (!handle) return null;
        const permission = typeof handle.queryPermission === "function"
            ? await handle.queryPermission({ mode: "readwrite" })
            : "prompt";
        return permission === "granted" ? handle : null;
    }

    async function writeDirectoryFile(handle, filename, contents) {
        if (filename !== filename.split(/[\\/]/).pop()) throw new TypeError("A file name cannot include a folder path.");
        const fileHandle = await handle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(contents);
            await writable.close();
        } catch (error) {
            await writable.abort();
            throw error;
        }
    }

    async function saveExternalFile(filename, contents) {
        const handle = await getGrantedDirectory();
        if (!handle) return false;
        await writeDirectoryFile(handle, filename, contents);
        return true;
    }

    async function hasExternalDateFile(date) {
        const handle = await getGrantedDirectory();
        if (!handle) return false;
        try {
            await handle.getFileHandle(getDailyFilename(date));
            return true;
        } catch (error) {
            if (error.name === "NotFoundError") return false;
            throw error;
        }
    }

    async function readExternalDateFile(handle, date) {
        const fileHandle = await handle.getFileHandle(getDailyFilename(date));
        return new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
    }

    async function writeStoredDatabase(bytes, backupDate = getLocalDateString(), dailyBytes) {
        const idb = await openIndexedDatabase();
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const filename = `LL-${getDateSuffix(backupDate)}.sqlite`;
        return new Promise((resolve, reject) => {
            const transaction = idb.transaction([storeName, backupStoreName, dailyDatabaseStoreName], "readwrite");
            transaction.objectStore(storeName).put(data, databaseKey);
            if (dailyBytes) {
                const dailyData = dailyBytes.buffer.slice(dailyBytes.byteOffset, dailyBytes.byteOffset + dailyBytes.byteLength);
                transaction.objectStore(dailyDatabaseStoreName).put(dailyData, filename);
                transaction.objectStore(backupStoreName).put({
                    date: getDateSuffix(backupDate),
                    filename,
                    savedAt: new Date().toISOString(),
                    data: dailyData
                }, filename);
            }
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error("Could not save the SQLite database."));
            transaction.onabort = () => reject(transaction.error || new Error("Saving the SQLite database was aborted."));
        });
    }

    function assertDate(date) {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new TypeError("Sale date must use YYYY-MM-DD format.");
        }
        const [year, month, day] = date.split("-").map(Number);
        const parsed = new Date(year, month - 1, day);
        if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
            throw new TypeError("Sale date must be a valid calendar date.");
        }
    }

    function toStorageDate(date) {
        assertDate(date);
        const [year, month, day] = date.split("-");
        return `${month}${day}${year}`;
    }

    function fromStorageDate(date) {
        if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
            assertDate(date);
            return date;
        }
        if (typeof date !== "string" || !/^\d{8}$/.test(date)) {
            throw new TypeError("Saved sale date must use MMDDYYYY format.");
        }
        const month = Number(date.slice(0, 2));
        const day = Number(date.slice(2, 4));
        const year = Number(date.slice(4, 8));
        const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        assertDate(isoDate);
        return isoDate;
    }

    function assertSale(sale) {
        if (!sale || typeof sale !== "object" || typeof sale.desc !== "string" || !sale.desc.trim()) {
            throw new TypeError("A sale must include a description.");
        }
        if (sale.cancelled !== undefined && typeof sale.cancelled !== "boolean") {
            throw new TypeError("Sale cancellation status must be a boolean.");
        }
        if ((sale.invoiceNo !== undefined && typeof sale.invoiceNo !== "string") ||
            (sale.time !== undefined && typeof sale.time !== "string")) {
            throw new TypeError("Invoice number and time must be text.");
        }
        if (!Number.isFinite(Number(sale.gross)) || Number(sale.gross) <= 0) {
            throw new TypeError("Sale gross amount must be greater than zero.");
        }
        if (!["vat", "sc"].includes(sale.calcType) ||
            !["Cash", "GCash", "Card", "Credit"].includes(sale.payType)) {
            throw new TypeError("Sale calculation or payment type is invalid.");
        }
        for (const key of ["net", "scDiscount", "vatAmount", "feeRate", "feeAmount", "finalTotal"]) {
            if (!Number.isFinite(Number(sale[key]))) {
                throw new TypeError(`Sale field "${key}" must be a number.`);
            }
        }
    }

    function assertExpense(expense) {
        if (!expense || typeof expense !== "object" ||
            typeof expense.description !== "string" || !expense.description.trim()) {
            throw new TypeError("An expense must include a description.");
        }
        if (typeof expense.category !== "string" || !expense.category.trim()) {
            throw new TypeError("An expense must include a category.");
        }
        if (expense.payee !== undefined && typeof expense.payee !== "string") {
            throw new TypeError("Expense payee must be text.");
        }
        if (!Number.isFinite(Number(expense.amount)) || Number(expense.amount) <= 0) {
            throw new TypeError("Expense amount must be greater than zero.");
        }
        if (!["Cash", "GCash", "Card", "Credit", "Other"].includes(expense.paymentMethod)) {
            throw new TypeError("Expense payment method is invalid.");
        }
        if (expense.notes !== undefined && typeof expense.notes !== "string") {
            throw new TypeError("Expense notes must be text.");
        }
    }

    function toExpense(row) {
        return {
            id: String(row.id),
            description: row.description,
            payee: row.payee || "",
            category: row.category,
            amount: Number(row.amount),
            paymentMethod: row.payment_method,
            notes: row.notes || ""
        };
    }

    function hasExpensesTable(candidate) {
        return candidate.exec(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expenses'"
        ).length > 0;
    }

    function getTableColumns(candidate, tableName) {
        return getTableInfo(candidate, tableName).map(column => column.name);
    }

    function getTableInfo(candidate, tableName) {
        const result = candidate.exec(`PRAGMA table_info(${tableName})`);
        return result.length
            ? result[0].values.map(row => ({ name: row[1], type: row[2], primaryKey: row[5] === 1 }))
            : [];
    }

    function toSale(row) {
        return {
            id: String(row.id),
            invoiceNo: row.invoice_no,
            desc: row.description,
            gross: Number(row.gross),
            calcType: row.calc_type,
            payType: row.pay_type,
            net: Number(row.net),
            scDiscount: Number(row.sc_discount),
            vatAmount: Number(row.vat_amount),
            feeRate: Number(row.fee_rate),
            feeAmount: Number(row.fee_amount),
            finalTotal: Number(row.final_total),
            time: row.time,
            cancelled: Number(row.cancelled || 0) === 1
        };
    }

    function migrateSchema(candidate) {
        const names = getTableColumns(candidate, "sales");
        if (!names.includes("cancelled")) {
            candidate.run("ALTER TABLE sales ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1))");
        }
        const versionResult = candidate.exec("PRAGMA user_version");
        const version = versionResult.length ? Number(versionResult[0].values[0][0]) : 0;
        if (version < 3) {
            candidate.run(`
                BEGIN TRANSACTION;
                DROP TABLE IF EXISTS sales_v3;
                CREATE TABLE sales_v3 (
                    id INTEGER PRIMARY KEY,
                    sale_date TEXT NOT NULL CHECK(length(sale_date) = 8),
                    invoice_no TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL,
                    gross REAL NOT NULL,
                    calc_type TEXT NOT NULL CHECK(calc_type IN ('vat', 'sc')),
                    pay_type TEXT NOT NULL CHECK(pay_type IN ('Cash', 'GCash', 'Card', 'Credit')),
                    net REAL NOT NULL,
                    sc_discount REAL NOT NULL DEFAULT 0,
                    vat_amount REAL NOT NULL DEFAULT 0,
                    fee_rate REAL NOT NULL DEFAULT 0,
                    fee_amount REAL NOT NULL DEFAULT 0,
                    final_total REAL NOT NULL,
                    time TEXT NOT NULL DEFAULT '',
                    cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1))
                );
                INSERT INTO sales_v3 (
                    id, sale_date, invoice_no, description, gross, calc_type, pay_type,
                    net, sc_discount, vat_amount, fee_rate, fee_amount, final_total, time, cancelled
                )
                SELECT
                    id,
                    CASE WHEN length(sale_date) = 10
                        THEN substr(sale_date, 6, 2) || substr(sale_date, 9, 2) || substr(sale_date, 1, 4)
                        ELSE sale_date
                    END,
                    invoice_no, description, gross, calc_type, pay_type, net, sc_discount,
                    vat_amount, fee_rate, fee_amount, final_total, time, cancelled
                FROM sales;
                DROP INDEX IF EXISTS sales_by_date;
                DROP TABLE sales;
                ALTER TABLE sales_v3 RENAME TO sales;
                CREATE INDEX sales_by_date ON sales(sale_date, id DESC);
                COMMIT;
            `);
        }
        candidate.run(`
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY,
                expense_date TEXT NOT NULL CHECK(length(expense_date) = 8),
                description TEXT NOT NULL,
                payee TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'Other',
                amount REAL NOT NULL CHECK(amount > 0),
                payment_method TEXT NOT NULL DEFAULT 'Cash'
                    CHECK(payment_method IN ('Cash', 'GCash', 'Card', 'Credit', 'Other')),
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS expenses_by_date ON expenses(expense_date, id DESC);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO settings (key, value) VALUES ('show_dashboard_vat', '0');
        `);
        const expenseNames = getTableColumns(candidate, "expenses");
        if (!expenseNames.includes("payee")) {
            candidate.run("ALTER TABLE expenses ADD COLUMN payee TEXT NOT NULL DEFAULT ''");
        }
        migrateRecordIdsToUuidV4(candidate);
        candidate.run("PRAGMA user_version = 6");
    }

    function migrateRecordIdsToUuidV4(candidate) {
        const sales = [];
        const salesStatement = candidate.prepare("SELECT * FROM sales");
        try {
            while (salesStatement.step()) {
                const row = salesStatement.getAsObject();
                sales.push({ ...toSale(row), storedDate: row.sale_date });
            }
        } finally {
            salesStatement.free();
        }
        const expenses = [];
        const expensesStatement = candidate.prepare("SELECT * FROM expenses");
        try {
            while (expensesStatement.step()) {
                const row = expensesStatement.getAsObject();
                expenses.push({ ...toExpense(row), storedDate: row.expense_date });
            }
        } finally {
            expensesStatement.free();
        }
        const salesIdColumn = getTableInfo(candidate, "sales").find(column => column.name === "id");
        const expensesIdColumn = getTableInfo(candidate, "expenses").find(column => column.name === "id");
        if (salesIdColumn?.type === "TEXT" && salesIdColumn.primaryKey &&
            expensesIdColumn?.type === "TEXT" && expensesIdColumn.primaryKey &&
            sales.every(sale => isUuidV4(sale.id)) && expenses.every(expense => isUuidV4(expense.id))) return;

        candidate.run("BEGIN TRANSACTION");
        try {
            candidate.run(`
                DROP INDEX IF EXISTS sales_by_date;
                DROP INDEX IF EXISTS expenses_by_date;
                CREATE TABLE sales_uuid_v6 (
                    id TEXT PRIMARY KEY NOT NULL,
                    sale_date TEXT NOT NULL CHECK(length(sale_date) = 8),
                    invoice_no TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL,
                    gross REAL NOT NULL,
                    calc_type TEXT NOT NULL CHECK(calc_type IN ('vat', 'sc')),
                    pay_type TEXT NOT NULL CHECK(pay_type IN ('Cash', 'GCash', 'Card', 'Credit')),
                    net REAL NOT NULL,
                    sc_discount REAL NOT NULL DEFAULT 0,
                    vat_amount REAL NOT NULL DEFAULT 0,
                    fee_rate REAL NOT NULL DEFAULT 0,
                    fee_amount REAL NOT NULL DEFAULT 0,
                    final_total REAL NOT NULL,
                    time TEXT NOT NULL DEFAULT '',
                    cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1))
                );
                CREATE TABLE expenses_uuid_v6 (
                    id TEXT PRIMARY KEY NOT NULL,
                    expense_date TEXT NOT NULL CHECK(length(expense_date) = 8),
                    description TEXT NOT NULL,
                    payee TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT 'Other',
                    amount REAL NOT NULL CHECK(amount > 0),
                    payment_method TEXT NOT NULL
                        CHECK(payment_method IN ('Cash', 'GCash', 'Card', 'Credit', 'Other')),
                    notes TEXT NOT NULL DEFAULT ''
                );
            `);
            const saleInsert = candidate.prepare(`
                INSERT INTO sales_uuid_v6 (
                    id, sale_date, invoice_no, description, gross, calc_type, pay_type,
                    net, sc_discount, vat_amount, fee_rate, fee_amount, final_total, time, cancelled
                ) VALUES (
                    :id, :sale_date, :invoice_no, :description, :gross, :calc_type, :pay_type,
                    :net, :sc_discount, :vat_amount, :fee_rate, :fee_amount, :final_total, :time, :cancelled
                )
            `);
            try {
                for (const sale of sales) {
                    saleInsert.run({
                        ":id": isUuidV4(sale.id) ? sale.id : createUuidV4(),
                        ":sale_date": sale.storedDate,
                        ":invoice_no": sale.invoiceNo || "",
                        ":description": sale.desc,
                        ":gross": sale.gross,
                        ":calc_type": sale.calcType,
                        ":pay_type": sale.payType,
                        ":net": sale.net,
                        ":sc_discount": sale.scDiscount,
                        ":vat_amount": sale.vatAmount,
                        ":fee_rate": sale.feeRate,
                        ":fee_amount": sale.feeAmount,
                        ":final_total": sale.finalTotal,
                        ":time": sale.time || "",
                        ":cancelled": sale.cancelled ? 1 : 0
                    });
                }
            } finally {
                saleInsert.free();
            }
            const expenseInsert = candidate.prepare(`
                INSERT INTO expenses_uuid_v6 (
                    id, expense_date, description, payee, category, amount, payment_method, notes
                ) VALUES (
                    :id, :expense_date, :description, :payee, :category, :amount, :payment_method, :notes
                )
            `);
            try {
                for (const expense of expenses) {
                    expenseInsert.run({
                        ":id": isUuidV4(expense.id) ? expense.id : createUuidV4(),
                        ":expense_date": expense.storedDate,
                        ":description": expense.description,
                        ":payee": expense.payee,
                        ":category": expense.category,
                        ":amount": expense.amount,
                        ":payment_method": expense.paymentMethod,
                        ":notes": expense.notes
                    });
                }
            } finally {
                expenseInsert.free();
            }
            candidate.run(`
                DROP TABLE sales;
                DROP TABLE expenses;
                ALTER TABLE sales_uuid_v6 RENAME TO sales;
                ALTER TABLE expenses_uuid_v6 RENAME TO expenses;
                CREATE INDEX sales_by_date ON sales(sale_date, id DESC);
                CREATE INDEX expenses_by_date ON expenses(expense_date, id DESC);
                COMMIT;
            `);
        } catch (error) {
            candidate.run("ROLLBACK");
            throw error;
        }
    }

    function readDashboardVatSetting(candidate) {
        const result = candidate.exec("SELECT value FROM settings WHERE key = 'show_dashboard_vat'");
        return result.length && result[0].values.length
            ? result[0].values[0][0] === "1"
            : false;
    }

    function writeDashboardVatSetting(candidate, visible) {
        candidate.run(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('show_dashboard_vat', ?)",
            [visible ? "1" : "0"]
        );
    }

    function getDashboardVatVisibility() {
        return readDashboardVatSetting(requireDatabase());
    }

    async function setDashboardVatVisibility(date, visible) {
        assertDate(date);
        if (typeof visible !== "boolean") throw new TypeError("Dashboard VAT visibility must be a boolean.");
        const previousBytes = requireDatabase().export();
        writeDashboardVatSetting(database, visible);
        try {
            return await persistDate(date);
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    function getSaleById(id) {
        const statement = database.prepare("SELECT * FROM sales WHERE id = :id");
        try {
            statement.bind({ ":id": String(id) });
            return statement.step() ? toSale(statement.getAsObject()) : null;
        } finally {
            statement.free();
        }
    }

    function getExpenseById(id) {
        const statement = database.prepare("SELECT * FROM expenses WHERE id = :id");
        try {
            statement.bind({ ":id": String(id) });
            return statement.step() ? toExpense(statement.getAsObject()) : null;
        } finally {
            statement.free();
        }
    }

    function addSaleRow(date, sale) {
        assertDate(date);
        assertSale(sale);
        const id = isUuidV4(sale.id) ? sale.id : createUuidV4();
        sale.id = id;
        const statement = database.prepare(`
            INSERT INTO sales (
                id, sale_date, invoice_no, description, gross, calc_type, pay_type,
                net, sc_discount, vat_amount, fee_rate, fee_amount, final_total, time, cancelled
            ) VALUES (
                :id, :sale_date, :invoice_no, :description, :gross, :calc_type, :pay_type,
                :net, :sc_discount, :vat_amount, :fee_rate, :fee_amount, :final_total, :time, :cancelled
            )
        `);
        try {
            const values = {
                ":id": id,
                ":sale_date": toStorageDate(date),
                ":invoice_no": sale.invoiceNo || "",
                ":description": sale.desc.trim(),
                ":gross": Number(sale.gross),
                ":calc_type": sale.calcType,
                ":pay_type": sale.payType,
                ":net": Number(sale.net),
                ":sc_discount": Number(sale.scDiscount),
                ":vat_amount": Number(sale.vatAmount),
                ":fee_rate": Number(sale.feeRate),
                ":fee_amount": Number(sale.feeAmount),
                ":final_total": Number(sale.finalTotal),
                ":time": sale.time || "",
                ":cancelled": sale.cancelled ? 1 : 0
            };
            statement.run(values);
        } finally {
            statement.free();
        }
    }

    function addExpenseRow(date, expense) {
        assertDate(date);
        assertExpense(expense);
        const id = isUuidV4(expense.id) ? expense.id : createUuidV4();
        expense.id = id;
        const statement = database.prepare(`
            INSERT INTO expenses (
                id, expense_date, description, payee, category, amount, payment_method, notes
            ) VALUES (
                :id, :expense_date, :description, :payee, :category, :amount, :payment_method, :notes
            )
        `);
        try {
            const values = {
                ":id": id,
                ":expense_date": toStorageDate(date),
                ":description": expense.description.trim(),
                ":payee": (expense.payee || "").trim(),
                ":category": expense.category.trim(),
                ":amount": Number(expense.amount),
                ":payment_method": expense.paymentMethod,
                ":notes": expense.notes || ""
            };
            statement.run(values);
        } finally {
            statement.free();
        }
    }

    function migrateLegacyData(legacy) {
        if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
            throw new TypeError("Existing sales data is not in a supported format.");
        }
        for (const [date, sales] of Object.entries(legacy)) {
            assertDate(date);
            if (!Array.isArray(sales)) throw new TypeError(`Existing sales for ${date} are invalid.`);
            for (const item of sales) {
                const migrated = {
                    ...item,
                    invoiceNo: String(item.invoiceNo || ""),
                    scDiscount: Number(item.scDiscount || 0),
                    vatAmount: Number(item.vatAmount || 0),
                    feeRate: Number(item.feeRate || 0),
                    feeAmount: Number(item.feeAmount || 0),
                    time: String(item.time || "")
                };
                assertSale(migrated);
                addSaleRow(date, migrated);
            }
        }
    }

    function checkDatabase(candidate) {
        const integrity = candidate.exec("PRAGMA quick_check");
        if (!integrity.length || integrity[0].values[0][0] !== "ok") {
            throw new Error("The selected file is not a valid SQLite database.");
        }
        const names = getTableColumns(candidate, "sales");
        if (requiredColumns.some(column => !names.includes(column))) {
            throw new Error("The SQLite file does not contain a compatible sales table.");
        }
        if (hasExpensesTable(candidate)) {
            const columns = getTableColumns(candidate, "expenses");
            if (legacyExpenseColumns.some(column => !columns.includes(column))) {
                throw new Error("The SQLite file contains an incompatible expenses table.");
            }
            const expenses = candidate.prepare("SELECT * FROM expenses");
            try {
                while (expenses.step()) {
                    const row = expenses.getAsObject();
                    fromStorageDate(row.expense_date);
                    assertExpense(toExpense(row));
                }
            } finally {
                expenses.free();
            }
        }
        const statement = candidate.prepare("SELECT * FROM sales");
        try {
            while (statement.step()) {
                const row = statement.getAsObject();
                fromStorageDate(row.sale_date);
                assertSale(toSale(row));
            }
        } finally {
            statement.free();
        }
    }

    async function init() {
        if (!window.indexedDB) throw new Error("This browser does not support offline database storage.");
        if (typeof window.initSqlJs !== "function") throw new Error("The local SQLite engine could not be loaded.");
        SQL = await window.initSqlJs();
        const stored = await readStoredDatabase();
        if (stored) {
            database = new SQL.Database(new Uint8Array(stored));
            checkDatabase(database);
            migrateSchema(database);
            await writeStoredDatabase(database.export());
        } else {
            database = new SQL.Database();
            database.run(schema);
            const legacyText = localStorage.getItem(legacyKey);
            if (legacyText !== null) {
                let legacyData;
                try {
                    legacyData = JSON.parse(legacyText);
                } catch (error) {
                    throw new Error(`Saved legacy sales data could not be parsed: ${error.message}`);
                }
                migrateLegacyData(legacyData);
            }
            await writeStoredDatabase(database.export());
            if (legacyText !== null) localStorage.removeItem(legacyKey);
        }
        for (const date of listDatabaseDates()) {
            await writeStoredDatabase(database.export(), date, exportDateDatabase(date));
        }
    }

    function listSales(date) {
        assertDate(date);
        const statement = requireDatabase().prepare("SELECT * FROM sales WHERE sale_date = :date ORDER BY rowid DESC");
        const results = [];
        try {
            statement.bind({ ":date": toStorageDate(date) });
            while (statement.step()) results.push(toSale(statement.getAsObject()));
        } finally {
            statement.free();
        }
        return results;
    }

    function listExpenses(date) {
        assertDate(date);
        const statement = requireDatabase().prepare(
            "SELECT * FROM expenses WHERE expense_date = :date ORDER BY rowid DESC"
        );
        const results = [];
        try {
            statement.bind({ ":date": toStorageDate(date) });
            while (statement.step()) results.push(toExpense(statement.getAsObject()));
        } finally {
            statement.free();
        }
        return results;
    }

    function listDatabaseDates() {
        const result = requireDatabase().exec(`
            SELECT sale_date AS date FROM sales
            UNION
            SELECT expense_date AS date FROM expenses
            ORDER BY date
        `);
        return result.length
            ? result[0].values.map(row => fromStorageDate(row[0])).sort()
            : [];
    }

    function exportDateDatabase(date) {
        assertDate(date);
        const dailyDatabase = new SQL.Database();
        dailyDatabase.run(schema);
        const statement = dailyDatabase.prepare(`
            INSERT INTO sales (
                id, sale_date, invoice_no, description, gross, calc_type, pay_type,
                net, sc_discount, vat_amount, fee_rate, fee_amount, final_total, time, cancelled
            ) VALUES (
                :id, :sale_date, :invoice_no, :description, :gross, :calc_type, :pay_type,
                :net, :sc_discount, :vat_amount, :fee_rate, :fee_amount, :final_total, :time,
                :cancelled
            )
        `);
        try {
            for (const sale of listSales(date)) {
                statement.run({
                    ":id": sale.id,
                    ":sale_date": toStorageDate(date),
                    ":invoice_no": sale.invoiceNo || "",
                    ":description": sale.desc,
                    ":gross": sale.gross,
                    ":calc_type": sale.calcType,
                    ":pay_type": sale.payType,
                    ":net": sale.net,
                    ":sc_discount": sale.scDiscount,
                    ":vat_amount": sale.vatAmount,
                    ":fee_rate": sale.feeRate,
                    ":fee_amount": sale.feeAmount,
                    ":final_total": sale.finalTotal,
                    ":time": sale.time || "",
                    ":cancelled": sale.cancelled ? 1 : 0
                });
            }
            const expenseStatement = dailyDatabase.prepare(`
                INSERT INTO expenses (
                    id, expense_date, description, payee, category, amount, payment_method, notes
                ) VALUES (
                    :id, :expense_date, :description, :payee, :category, :amount, :payment_method, :notes
                )
            `);
            try {
                for (const expense of listExpenses(date)) {
                    expenseStatement.run({
                        ":id": expense.id,
                        ":expense_date": toStorageDate(date),
                        ":description": expense.description,
                        ":payee": expense.payee,
                        ":category": expense.category,
                        ":amount": expense.amount,
                        ":payment_method": expense.paymentMethod,
                        ":notes": expense.notes
                    });
                }
            } finally {
                expenseStatement.free();
            }
            const settings = database.exec("SELECT key, value FROM settings");
            if (settings.length) {
                const settingStatement = dailyDatabase.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)");
                try {
                    for (const [key, value] of settings[0].values) {
                        settingStatement.run({ ":key": key, ":value": value });
                    }
                } finally {
                    settingStatement.free();
                }
            }
            return dailyDatabase.export();
        } finally {
            statement.free();
            dailyDatabase.close();
        }
    }

    async function persistDate(date, saveExternal = true) {
        const dailyBytes = exportDateDatabase(date);
        await writeStoredDatabase(database.export(), date, dailyBytes);
        let externalError = null;
        let handle = null;
        try {
            handle = await getGrantedDirectory();
        } catch (error) {
            externalError = error;
        }
        if (handle && saveExternal) {
            try {
                await writeDirectoryFile(handle, getDailyFilename(date), dailyBytes);
            } catch (error) {
                externalError = error;
            }
        }
        return { externalSaved: Boolean(handle && saveExternal && !externalError), externalError };
    }

    async function prepareDate(date, createIfMissing = false) {
        assertDate(date);
        const handle = await getGrantedDirectory();
        if (handle) {
            try {
                const bytes = await readExternalDateFile(handle, date);
                const result = await importDateDatabase(date, bytes, false, false);
                return { exists: true, external: true, ...result };
            } catch (error) {
                if (error.name !== "NotFoundError") throw error;
            }
        }

        if (createIfMissing) {
            const result = await persistDate(date);
            if (handle && !result.externalSaved) {
                throw result.externalError || new Error(`Could not create ${getDailyFilename(date)} in the selected folder.`);
            }
            return { exists: false, external: Boolean(handle) };
        }
        return { exists: false, external: false };
    }

    async function importDateDatabase(date, buffer, saveExternal = true, importSettings = true) {
        assertDate(date);
        const candidate = new SQL.Database(new Uint8Array(buffer));
        const externalSales = [];
        const externalExpenses = [];
        let includesExpenses = false;
        let showDashboardVat = false;
        try {
            checkDatabase(candidate);
            includesExpenses = hasExpensesTable(candidate);
            migrateSchema(candidate);
            showDashboardVat = readDashboardVatSetting(candidate);
            const statement = candidate.prepare("SELECT * FROM sales");
            try {
                while (statement.step()) {
                    const row = statement.getAsObject();
                    if (fromStorageDate(row.sale_date) !== date) throw new Error(`The file ${getDailyFilename(date)} contains sales for another date.`);
                    externalSales.push(toSale(row));
                }
            } finally {
                statement.free();
            }
            if (includesExpenses) {
                const expenseStatement = candidate.prepare("SELECT * FROM expenses");
                try {
                    while (expenseStatement.step()) {
                        const row = expenseStatement.getAsObject();
                        if (fromStorageDate(row.expense_date) !== date) {
                            throw new Error(`The file ${getDailyFilename(date)} contains expenses for another date.`);
                        }
                        externalExpenses.push(toExpense(row));
                    }
                } finally {
                    expenseStatement.free();
                }
            }
        } finally {
            candidate.close();
        }

        const previousBytes = database.export();
        try {
            const deleteStatement = database.prepare("DELETE FROM sales WHERE sale_date = :date");
            try {
                deleteStatement.run({ ":date": toStorageDate(date) });
            } finally {
                deleteStatement.free();
            }
            if (includesExpenses) {
                const deleteExpenses = database.prepare("DELETE FROM expenses WHERE expense_date = :date");
                try {
                    deleteExpenses.run({ ":date": toStorageDate(date) });
                } finally {
                    deleteExpenses.free();
                }
            }
            if (importSettings) writeDashboardVatSetting(database, showDashboardVat);
            externalSales.forEach(sale => addSaleRow(date, { ...sale, id: undefined }));
            externalExpenses.forEach(expense => addExpenseRow(date, { ...expense, id: undefined }));
            return await persistDate(date, saveExternal);
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function saveSale(date, sale, id) {
        assertDate(date);
        assertSale(sale);
        requireDatabase();
        const previousBytes = database.export();
        if (id !== undefined && id !== null && id !== "") {
            const statement = database.prepare(`
                UPDATE sales SET
                    invoice_no = :invoice_no, description = :description, gross = :gross,
                    calc_type = :calc_type, pay_type = :pay_type, net = :net,
                    sc_discount = :sc_discount, vat_amount = :vat_amount,
                    fee_rate = :fee_rate, fee_amount = :fee_amount,
                    final_total = :final_total, cancelled = :cancelled
                WHERE id = :id AND sale_date = :sale_date
            `);
            try {
                statement.run({
                    ":invoice_no": sale.invoiceNo || "",
                    ":description": sale.desc.trim(),
                    ":gross": Number(sale.gross),
                    ":calc_type": sale.calcType,
                    ":pay_type": sale.payType,
                    ":net": Number(sale.net),
                    ":sc_discount": Number(sale.scDiscount),
                    ":vat_amount": Number(sale.vatAmount),
                    ":fee_rate": Number(sale.feeRate),
                    ":fee_amount": Number(sale.feeAmount),
                    ":final_total": Number(sale.finalTotal),
                    ":cancelled": sale.cancelled ? 1 : 0,
                    ":id": String(id),
                    ":sale_date": toStorageDate(date)
                });
            } finally {
                statement.free();
            }

            if (database.getRowsModified() !== 1) throw new Error("The sale no longer exists for this date.");
        } else {
            addSaleRow(date, sale);
        }
        try {
            const persistence = await persistDate(date);
            return { sale: id ? getSaleById(id) : getSaleById(sale.id), ...persistence };
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function saveExpense(date, expense, id) {
        assertDate(date);
        assertExpense(expense);
        requireDatabase();
        const previousBytes = database.export();
        try {
            if (id !== undefined && id !== null && id !== "") {
                const statement = database.prepare(`
                    UPDATE expenses SET
                        description = :description, payee = :payee, category = :category, amount = :amount,
                        payment_method = :payment_method, notes = :notes
                    WHERE id = :id AND expense_date = :expense_date
                `);
                try {
                    statement.run({
                        ":description": expense.description.trim(),
                        ":payee": (expense.payee || "").trim(),
                        ":category": expense.category.trim(),
                        ":amount": Number(expense.amount),
                        ":payment_method": expense.paymentMethod,
                        ":notes": expense.notes || "",
                        ":id": String(id),
                        ":expense_date": toStorageDate(date)
                    });
                } finally {
                    statement.free();
                }
                if (database.getRowsModified() !== 1) throw new Error("The expense no longer exists for this date.");
            } else {
                addExpenseRow(date, expense);
            }
            const persistence = await persistDate(date);
            return { expense: getExpenseById(id || expense.id), ...persistence };
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function deleteExpense(date, id) {
        assertDate(date);
        requireDatabase();
        const previousBytes = database.export();
        try {
            const statement = database.prepare(
                "DELETE FROM expenses WHERE expense_date = :date AND id = :id"
            );
            try {
                statement.run({ ":date": toStorageDate(date), ":id": String(id) });
            } finally {
                statement.free();
            }
            if (database.getRowsModified() !== 1) throw new Error("The expense could not be found.");
            return await persistDate(date);
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function setSaleCancelled(date, id, cancelled) {
        assertDate(date);
        requireDatabase();
        const previousBytes = database.export();
        const statement = database.prepare("UPDATE sales SET cancelled = :cancelled WHERE sale_date = :date AND id = :id");
        try {
            statement.run({ ":cancelled": cancelled ? 1 : 0, ":date": toStorageDate(date), ":id": String(id) });
        } finally {
            statement.free();
        }
        if (database.getRowsModified() !== 1) throw new Error("The sale could not be found.");
        try {
            const persistence = await persistDate(date);
            return { sale: getSaleById(id), ...persistence };
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function deleteSale(date, id) {
        assertDate(date);
        requireDatabase();
        const previousBytes = database.export();
        const statement = database.prepare("DELETE FROM sales WHERE sale_date = :date AND id = :id");
        try {
            statement.run({ ":date": toStorageDate(date), ":id": String(id) });
        } finally {
            statement.free();
        }
        if (database.getRowsModified() !== 1) throw new Error("The sale could not be found.");
        try {
            return await persistDate(date);
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function clearDate(date) {
        assertDate(date);
        requireDatabase();
        const previousBytes = database.export();
        try {
            const statement = database.prepare("DELETE FROM sales WHERE sale_date = :date");
            try {
                statement.run({ ":date": toStorageDate(date) });
            } finally {
                statement.free();
            }
            const expenseStatement = database.prepare("DELETE FROM expenses WHERE expense_date = :date");
            try {
                expenseStatement.run({ ":date": toStorageDate(date) });
            } finally {
                expenseStatement.free();
            }
            return await persistDate(date);
        } catch (error) {
            database.close();
            database = new SQL.Database(previousBytes);
            throw error;
        }
    }

    async function importDatabase(buffer) {
        if (!SQL) throw new Error("The SQLite engine is not ready. Reload the app and check its startup error.");
        const candidate = new SQL.Database(new Uint8Array(buffer));
        let replaced = false;
        try {
            checkDatabase(candidate);
            migrateSchema(candidate);
            const previous = database;
            database = candidate;
            replaced = true;
            try {
                await writeStoredDatabase(database.export());
            } catch (error) {
                database = previous;
                replaced = false;
                throw error;
            }
            previous.close();
            for (const date of listDatabaseDates()) {
                await writeStoredDatabase(database.export(), date, exportDateDatabase(date));
            }
        } catch (error) {
            if (!replaced) candidate.close();
            throw error;
        }
    }

    async function listBackups() {
        const idb = await openIndexedDatabase();
        return new Promise((resolve, reject) => {
            const transaction = idb.transaction(backupStoreName, "readonly");
            const backups = [];
            const request = transaction.objectStore(backupStoreName).openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    backups.sort((a, b) => fromStorageDate(b.date).localeCompare(fromStorageDate(a.date)));
                    resolve(backups);
                    return;
                }
                const { date, filename, savedAt } = cursor.value;
                const storageDate = /^\d{8}$/.test(date) ? date : toStorageDate(date);
                backups.push({ date: storageDate, filename, savedAt });
                cursor.continue();
            };
            request.onerror = () => reject(request.error || new Error("Could not read automatic backups."));
            transaction.onerror = () => reject(transaction.error || new Error("Could not read automatic backups."));
        });
    }

    async function getBackup(filename) {
        const idb = await openIndexedDatabase();
        return new Promise((resolve, reject) => {
            const transaction = idb.transaction(backupStoreName, "readonly");
            const request = transaction.objectStore(backupStoreName).get(filename);
            request.onsuccess = () => {
                if (!request.result) {
                    reject(new Error("That automatic backup could not be found."));
                    return;
                }
                resolve(new Uint8Array(request.result.data));
            };
            request.onerror = () => reject(request.error || new Error("Could not read the selected backup."));
            transaction.onerror = () => reject(transaction.error || new Error("Could not read the selected backup."));
        });
    }

    function getSalesCount(date) {
        if (date) assertDate(date);
        const result = date
            ? requireDatabase().exec("SELECT COUNT(*) FROM sales WHERE sale_date = ?", [toStorageDate(date)])
            : requireDatabase().exec("SELECT COUNT(*) FROM sales");
        return Number(result[0].values[0][0]);
    }

    function getExpenseCount(date) {
        if (date) assertDate(date);
        const result = date
            ? requireDatabase().exec("SELECT COUNT(*) FROM expenses WHERE expense_date = ?", [toStorageDate(date)])
            : requireDatabase().exec("SELECT COUNT(*) FROM expenses");
        return Number(result[0].values[0][0]);
    }

    function exportDatabase(date) {
        return date ? exportDateDatabase(date) : requireDatabase().export();
    }

    window.SalesDB = {
        init,
        listSales,
        listExpenses,
        listDatabaseDates,
        prepareDate,
        hasExternalDateFile,
        importDateDatabase,
        getDirectoryStatus,
        chooseDataFolder,
        saveExternalFile,
        saveSale,
        saveExpense,
        deleteExpense,
        setSaleCancelled,
        deleteSale,
        clearDate,
        importDatabase,
        getDashboardVatVisibility,
        setDashboardVatVisibility,
        listBackups,
        getBackup,
        getSalesCount,
        getExpenseCount,
        exportDatabase
    };
}());
