        // State Variables
        let salesData = {};
        let expensesData = {};
        let currentDateStr = "";
        let calendarCursor = new Date();
        let pendingConfirmAction = null;
        let pendingConfirmCancel = null;
        let offlineCacheAvailable = false;
        let dataFolderStatus = { connected: false, available: false };
        let formCalcType = "vat";
        let formPaymentType = "Cash";
        let formFeeRate = 0;
        let showDashboardVat = false;
        const ledgerPageSize = 24;
        let ledgerVisibleCount = ledgerPageSize;
        let appInitializationStarted = false;

        window.addEventListener("load", initializeApp, { once: true });
        window.addEventListener("eulaAccepted", initializeApp);
        window.addEventListener("online", updateConnectionStatus);
        window.addEventListener("offline", updateConnectionStatus);
        window.addEventListener("keydown", handleModalKeydown);

        async function initializeApp() {
            if (appInitializationStarted) return;
            const eulaModal = document.getElementById("eula-modal");
            if (eulaModal && !eulaModal.classList.contains("hidden")) return;
            appInitializationStarted = true;
            currentDateStr = todayDateString();
            updateDateDisplay(new Date());
            try {
                await SalesDB.init();
                showDashboardVat = SalesDB.getDashboardVatVisibility();
                await SalesDB.prepareDate(currentDateStr, true);
                await loadStorageData();
                renderDashboard();
                await registerOfflineSupport();
                await updateDataFolderStatus();
                updateConnectionStatus();
            } catch (error) {
                console.error("App initialization failed:", error);
                setAppStatus("Storage error", true);
                showToast(`Could not start the sales database: ${error.message}`);
            }
        }

        async function registerOfflineSupport() {
            if (location.protocol === "file:") {
                setAppStatus("Local file · saved on this device", false);
                return;
            }
            if (!("serviceWorker" in navigator) || !["https:", "http:"].includes(location.protocol)) {
                setAppStatus("Offline app cache unavailable", true);
                return;
            }
            try {
                const manifest = document.createElement("link");
                manifest.rel = "manifest";
                manifest.href = "./manifest.webmanifest";
                document.head.appendChild(manifest);
                const registration = await navigator.serviceWorker.register("./service-worker.js");
                const installing = registration.installing;
                if (installing) {
                    await new Promise((resolve, reject) => {
                        const onStateChange = () => {
                            if (installing.state === "activated") {
                                installing.removeEventListener("statechange", onStateChange);
                                resolve();
                            } else if (installing.state === "redundant") {
                                installing.removeEventListener("statechange", onStateChange);
                                reject(new Error("The offline app files could not be cached."));
                            }
                        };
                        installing.addEventListener("statechange", onStateChange);
                        onStateChange();
                    });
                } else if (!registration.active) {
                    throw new Error("The offline service worker did not activate.");
                }
                offlineCacheAvailable = true;
            } catch (error) {
                console.error("Offline app caching could not be enabled:", error);
                setAppStatus("Offline cache unavailable", true);
                showToast("The app works locally, but offline page caching could not be enabled.");
            }
        }

        function setAppStatus(message, hasError) {
            ["mobileAppStatus", "desktopAppStatus"].forEach(id => {
                const element = document.getElementById(id);
                if (!element) return;
                element.textContent = message;
                if (id === "desktopAppStatus") {
                    element.className = hasError
                        ? "text-xs font-semibold text-amber-800 bg-amber-50 px-3 py-2 rounded-xl border border-amber-200"
                        : "text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-2 rounded-xl border border-emerald-100";
                }
            });
        }

        function updateConnectionStatus() {
            updateDataFolderStatus().catch(error => console.error("Database folder status could not be read:", error));
        }

        async function updateDataFolderStatus() {
            const status = await SalesDB.getDirectoryStatus();
            dataFolderStatus = status;
            if (status.available) {
                setAppStatus(`${navigator.onLine ? "SQLite folder" : "Offline · SQLite folder"} · ${status.name}`, false);
            } else if (status.connected) {
                setAppStatus("Reconnect SQLite folder", true);
            } else if (!status.supported) {
                setAppStatus(status.protocol === "file:"
                    ? "Local storage · file:// blocks folder access"
                    : "Local storage · folder access unavailable", true);
            } else {
                setAppStatus("Local storage · choose data folder", false);
            }
        }

        async function chooseDataFolder() {
            try {
                const result = await SalesDB.chooseDataFolder();
                await SalesDB.prepareDate(currentDateStr, true);
                await loadStorageData();
                renderDashboard();
                await updateDataFolderStatus();
                closeMenuIfOpen();
                showToast(`Daily SQLite files will be saved in ${result.name}.`);
            } catch (error) {
                console.error("Daily database folder could not be selected:", error);
                showToast(`Could not select the data folder: ${error.message}`);
            }
        }

        function todayDateString() {
            const today = new Date();
            return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        }

        function updateDateDisplay(dateObj) {
            document.getElementById("headerDateDisplay").innerText =
                dateObj.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
            const desktopText = dateObj.toLocaleDateString("en-PH", {
                weekday: "long", month: "long", day: "numeric", year: "numeric"
            });
            document.getElementById("desktopDateDisplay").innerText = desktopText;
            document.getElementById("desktopDateLabel").innerText = desktopText;
            document.getElementById("selectedDateButton").innerText =
                dateObj.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
            document.getElementById("desktopDateButtonText").innerText =
                dateObj.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
        }

        async function setCurrentDate(dateValue) {
            const parts = dateValue.split("-").map(Number);
            const selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
            if (Number.isNaN(selectedDate.getTime())) return;
            if (dateValue > todayDateString()) return;
            await SalesDB.prepareDate(dateValue, true);
            currentDateStr = dateValue;
            updateDateDisplay(selectedDate);
            loadStorageData();
            renderDashboard();
            await updateDataFolderStatus();
        }

        async function setDashboardVatVisibility(visible) {
            const previousValue = showDashboardVat;
            showDashboardVat = visible;
            renderDashboard();
            try {
                const result = await SalesDB.setDashboardVatVisibility(currentDateStr, visible);
                if (result.externalError) {
                    showToast(`Setting saved on this device, but folder sync failed: ${result.externalError.message}`);
                } else {
                    showToast(visible ? "Dashboard VAT total is now visible." : "Dashboard VAT total is hidden.");
                }
            } catch (error) {
                showDashboardVat = previousValue;
                renderDashboard();
                console.error("Dashboard VAT setting could not be saved:", error);
                showToast(`Could not save dashboard setting: ${error.message}`);
            }
        }

        function loadStorageData() {
            salesData[currentDateStr] = SalesDB.listSales(currentDateStr);
            expensesData[currentDateStr] = SalesDB.listExpenses(currentDateStr);
        }

        function getTodaySalesList() {
            return salesData[currentDateStr] || [];
        }

        function getTodayExpensesList() {
            return expensesData[currentDateStr] || [];
        }

        function filterLedger() {
            ledgerVisibleCount = ledgerPageSize;
            renderDashboard();
        }

        function resetLedgerFilters() {
            document.getElementById("ledgerSearch").value = "";
            document.getElementById("ledgerStatusFilter").value = "all";
            filterLedger();
        }

        function showMoreSales() {
            ledgerVisibleCount += ledgerPageSize;
            renderDashboard();
        }

        function openCalendar() {
            const [year, month, day] = currentDateStr.split("-").map(Number);
            calendarCursor = new Date(year, month - 1, day);
            renderCalendar();
            showModal("calendarModal", "calendarPanel");
        }

        function closeCalendar() {
            hideModal("calendarModal", "calendarPanel");
        }

        function handleModalKeydown(event) {
            const eulaModal = document.getElementById("eula-modal");
            if (eulaModal && !eulaModal.classList.contains("hidden")) return;
            if (event.key === "F2") {
                const saleModal = document.getElementById("saleModal");
                const isSaleFormField = event.target instanceof HTMLElement
                    && saleModal.contains(event.target)
                    && event.target.matches("input, textarea, select, [contenteditable='true']");
                if (!isSaleFormField && event.target instanceof HTMLElement
                    && event.target.matches("input, textarea, select, [contenteditable='true']")) return;
                const modalIds = ["confirmModal", "calendarModal", "saleModal", "expenseModal", "printReportModal", "menuModal", "backupModal", "noticeModal"];
                if (modalIds.some(id => !document.getElementById(id).classList.contains("pointer-events-none"))) return;
                event.preventDefault();
                openAddModal();
                return;
            }
            if (event.key !== "Escape") return;
            if (!document.getElementById("confirmModal").classList.contains("pointer-events-none")) {
                closeConfirmModal();
            } else if (!document.getElementById("calendarModal").classList.contains("pointer-events-none")) {
                closeCalendar();
            } else if (!document.getElementById("saleModal").classList.contains("pointer-events-none")) {
                closeSaleModal();
            } else if (!document.getElementById("expenseModal").classList.contains("pointer-events-none")) {
                closeExpenseModal();
            } else if (!document.getElementById("printReportModal").classList.contains("pointer-events-none")) {
                closePrintReportModal();
            } else if (!document.getElementById("backupModal").classList.contains("pointer-events-none")) {
                closeBackupHistory();
            } else if (!document.getElementById("noticeModal").classList.contains("pointer-events-none")) {
                closeNoticeModal();
            } else if (!document.getElementById("menuModal").classList.contains("pointer-events-none")) {
                toggleMenuModal();
            }
        }

        function shiftCalendarMonth(offset) {
            calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
            renderCalendar();
        }

        function renderCalendar() {
            const year = calendarCursor.getFullYear();
            const month = calendarCursor.getMonth();
            const today = new Date();
            const nextMonthButton = document.getElementById("nextCalendarMonthButton");
            nextMonthButton.disabled = year > today.getFullYear() ||
                (year === today.getFullYear() && month >= today.getMonth());
            nextMonthButton.classList.toggle("opacity-40", nextMonthButton.disabled);
            nextMonthButton.classList.toggle("cursor-not-allowed", nextMonthButton.disabled);
            document.getElementById("calendarTitle").innerText =
                calendarCursor.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
            const days = document.getElementById("calendarDays");
            days.innerHTML = "";

            for (let blank = 0; blank < new Date(year, month, 1).getDay(); blank += 1) {
                const spacer = document.createElement("span");
                spacer.setAttribute("aria-hidden", "true");
                days.appendChild(spacer);
            }
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            for (let day = 1; day <= daysInMonth; day += 1) {
                const dateValue = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const button = document.createElement("button");
                button.type = "button";
                button.innerText = day;
                button.disabled = dateValue > todayDateString();
                button.setAttribute("role", "gridcell");
                button.setAttribute("aria-label", new Date(year, month, day).toLocaleDateString("en-PH", {
                    weekday: "long", year: "numeric", month: "long", day: "numeric"
                }));
                button.className = button.disabled
                    ? "h-10 rounded-xl text-slate-300 cursor-not-allowed"
                    : dateValue === currentDateStr
                    ? "h-10 rounded-xl bg-blue-600 text-white font-bold shadow-sm"
                    : dateValue === todayDateString()
                        ? "h-10 rounded-xl bg-blue-50 text-blue-700 font-bold ring-1 ring-blue-200 hover:bg-blue-100"
                        : "h-10 rounded-xl text-slate-700 font-semibold hover:bg-slate-100";
                button.onclick = () => selectCalendarDate(dateValue);
                days.appendChild(button);
            }
        }

        async function selectCalendarDate(dateValue) {
            if (dateValue > todayDateString()) return;
            closeCalendar();
            let hasFile = false;
            try {
                hasFile = await SalesDB.hasExternalDateFile(dateValue);
            } catch (error) {
                console.error("Daily SQLite file could not be checked:", error);
                showToast(`Could not check the daily database folder: ${error.message}`);
                return;
            }
            try {
                await updateDataFolderStatus();
            } catch (error) {
                console.error("Database folder permission could not be checked:", error);
                showToast(`Could not check folder access: ${error.message}`);
                return;
            }
            if (dateValue < todayDateString() && !hasFile) {
                showConfirm(
                    "Create this day's ledger?",
                    `There is no LL-${dateSuffix(dateValue)}.sqlite file. Create a separate daily SQLite ledger? If no folder is connected, you will be asked to choose one.`,
                    "Create file",
                    async () => {
                        try {
                            if (!dataFolderStatus.supported) {
                                await SalesDB.prepareDate(dateValue, true);
                                downloadFile(
                                    SalesDB.exportDatabase(dateValue),
                                    `LL-${dateSuffix(dateValue)}.sqlite`,
                                    "application/vnd.sqlite3"
                                );
                                await setCurrentDate(dateValue);
                                return;
                            }
                            if (!dataFolderStatus.connected || !dataFolderStatus.available) {
                                await SalesDB.chooseDataFolder();
                            }
                            await setCurrentDate(dateValue);
                        } catch (error) {
                            await setCurrentDate(todayDateString());
                            if (error.name === "AbortError") {
                                closeConfirmModal(false);
                                showToast("File creation cancelled; returned to today.");
                                return;
                            }
                            throw error;
                        }
                    },
                    () => setCurrentDate(todayDateString()),
                    "No, go to today",
                    "primary"
                );
                return;
            }
            try {
                await setCurrentDate(dateValue);
            } catch (error) {
                console.error("Selected date could not be opened:", error);
                showToast(`Could not open that day's ledger: ${error.message}`);
                await setCurrentDate(todayDateString());
            }
        }

        // RENDER DASHBOARD
        function renderDashboard() {
            const list = getTodaySalesList();
            const expenses = getTodayExpensesList();
            const activeSales = list.filter(item => !item.cancelled);

            let sumOverall = 0, sumNet = 0, sumVat = 0, sumSc = 0;
            let sumCash = 0, sumGcash = 0, sumCard = 0, sumCredit = 0;
            const sumExpenses = expenses.reduce((total, expense) => total + expense.amount, 0);

            activeSales.forEach(item => {
                sumOverall += item.finalTotal;
                sumNet += item.net;
                sumVat += item.vatAmount || 0;
                sumSc += item.scDiscount || 0;
                switch(item.payType) {
                    case 'Cash': sumCash += item.finalTotal; break;
                    case 'GCash': sumGcash += item.finalTotal; break;
                    case 'Card': sumCard += item.finalTotal; break;
                    case 'Credit': sumCredit += item.finalTotal; break;
                }
            });

            // Header stats
            document.getElementById('sumOverallDisplay').innerHTML = formatPHPDisplay(sumOverall);
            document.getElementById('sumNetDisplay').innerHTML = formatPHPDisplay(sumNet);
            document.getElementById('sumVatDisplay').innerHTML = formatPHPDisplay(sumVat);
            document.getElementById('sumScDiscountDisplay').innerHTML = formatPHPDisplay(sumSc);
            document.getElementById('sumExpensesDisplay').innerHTML = formatPHPDisplay(sumExpenses);
            document.getElementById('sumAfterExpensesDisplay').innerHTML = formatPHPDisplay(sumOverall - sumExpenses);
            document.getElementById('expenseEntriesCount').innerText =
                `${expenses.length} ${expenses.length === 1 ? 'expense' : 'expenses'}`;
            document.getElementById('dashboardVatSummary').classList.toggle('hidden', !showDashboardVat);
            document.getElementById('dashboardVatVisibility').checked = showDashboardVat;

            // Desktop breakdown
            document.getElementById('sumCashDesk').innerHTML = formatPHPDisplay(sumCash);
            document.getElementById('sumGcashDesk').innerHTML = formatPHPDisplay(sumGcash);
            document.getElementById('sumCardDesk').innerHTML = formatPHPDisplay(sumCard);
            document.getElementById('sumCreditDesk').innerHTML = formatPHPDisplay(sumCredit);

            // Mobile pills
            document.getElementById('sumCashMobile').innerHTML = formatPHPDisplay(sumCash, 0);
            document.getElementById('sumGcashMobile').innerHTML = formatPHPDisplay(sumGcash, 0);
            document.getElementById('sumCardMobile').innerHTML = formatPHPDisplay(sumCard, 0);
            document.getElementById('sumCreditMobile').innerHTML = formatPHPDisplay(sumCredit, 0);

            document.getElementById('totalEntriesBadge').innerText = `${activeSales.length} ${activeSales.length === 1 ? 'Sale' : 'Sales'}`;
            document.getElementById('desktopEntriesBadge').innerText = `${activeSales.length} sale${activeSales.length !== 1 ? 's' : ''}`;

            // Render Cards
            const container = document.getElementById('salesListContainer');
            const searchTerm = document.getElementById('ledgerSearch').value.trim().toLocaleLowerCase();
            const statusFilter = document.getElementById('ledgerStatusFilter').value;
            const filteredSales = list.filter(item => {
                if (statusFilter === 'active' && item.cancelled) return false;
                if (statusFilter === 'cancelled' && !item.cancelled) return false;
                if (!searchTerm) return true;
                return [item.desc, item.invoiceNo, item.payType]
                    .some(value => String(value || '').toLocaleLowerCase().includes(searchTerm));
            });
            const visibleSales = filteredSales.slice(0, ledgerVisibleCount);
            const pagination = document.getElementById('ledgerPagination');
            document.getElementById('ledgerResultCount').innerText = list.length === filteredSales.length
                ? `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`
                : `${filteredSales.length} of ${list.length} entries`;
            pagination.classList.toggle('hidden', filteredSales.length <= ledgerVisibleCount);
            pagination.classList.toggle('flex', filteredSales.length > ledgerVisibleCount);
            document.getElementById('ledgerPaginationLabel').innerText =
                `Showing ${Math.min(visibleSales.length, filteredSales.length)} of ${filteredSales.length} matching entries`;
            container.innerHTML = '';
            renderExpenses();

            if (list.length === 0) {
                container.innerHTML = `
                    <div class="bg-white rounded-2xl p-8 text-center text-slate-400 border border-slate-200/80 space-y-2 col-span-full">
                        <i class="fa-solid fa-receipt text-3xl text-slate-300"></i>
                        <p class="text-xs font-semibold">No sales entries recorded for this date.</p>
                        <button onclick="openAddModal()" class="text-xs font-bold text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100 hover:bg-blue-100 transition">
                            + Tap to Add First Sale
                        </button>
                    </div>
                `;
                return;
            }

            if (filteredSales.length === 0) {
                container.innerHTML = `
                    <div class="bg-white rounded-2xl p-8 text-center text-slate-500 border border-slate-200/80 space-y-3 col-span-full">
                        <i class="fa-solid fa-magnifying-glass text-2xl text-slate-300"></i>
                        <p class="text-sm font-semibold">No sales match these filters.</p>
                        <button type="button" onclick="resetLedgerFilters()" class="text-xs font-bold text-blue-700 bg-blue-50 px-3 py-2 rounded-lg border border-blue-100 hover:bg-blue-100 transition">
                            Clear search and filters
                        </button>
                    </div>
                `;
                return;
            }

            visibleSales.forEach((item) => {
                const card = document.createElement('div');
                card.className = "ledger-entry-card bg-white rounded-2xl p-4 sm:p-5 border border-slate-200/80 shadow-sm flex flex-col justify-between transition card-hover";

                const calcBadge = item.calcType === 'sc'
                    ? `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200"><i class="fa-solid fa-person-cane"></i> SC/PWD</span>`
                    : `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200"><i class="fa-solid fa-percent"></i> 12% VAT</span>`;

                let payColor = "bg-slate-100 text-slate-700";
                if (item.payType === 'Cash') payColor = "bg-emerald-50 text-emerald-700 border-emerald-200";
                if (item.payType === 'GCash') payColor = "bg-blue-50 text-blue-700 border-blue-200";
                if (item.payType === 'Card') payColor = "bg-purple-50 text-purple-700 border-purple-200";
                if (item.payType === 'Credit') payColor = "bg-amber-50 text-amber-700 border-amber-200";

                const payBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold border ${payColor}">${item.payType}${item.feeRate > 0 ? ` (+${item.feeRate}%)` : ''}</span>`;
                const cancelledBadge = item.cancelled
                    ? `<span class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-red-100 text-red-800 border border-red-200">CANCELLED</span>`
                    : '';

                const invoiceLine = item.invoiceNo ? `<span class="text-[10px] font-semibold text-slate-400 mr-2"><i class="fa-regular fa-file-lines mr-0.5"></i>${escapeHtml(item.invoiceNo)}</span>` : '';

                card.innerHTML = `
                    <div>
                        <div class="flex items-start justify-between mb-3">
                            <div class="space-y-1.5 flex-1 pr-3">
                                <div class="flex items-center flex-wrap gap-1.5">
                                    ${calcBadge}
                                    ${payBadge}
                                    ${cancelledBadge}
                                    ${invoiceLine}
                                </div>
                                <h3 class="text-sm font-extrabold text-slate-900 leading-tight" style="${item.cancelled ? 'text-decoration:line-through;opacity:.6' : ''}">${escapeHtml(item.desc)}</h3>
                                <p class="text-[10px] font-semibold text-slate-400">${item.time || 'Today'}</p>
                            </div>
                            <div class="text-right">
                                <span class="text-lg font-extrabold text-blue-700 block" style="${item.cancelled ? 'text-decoration:line-through;opacity:.6' : ''}">${formatPHPDisplay(item.finalTotal)}</span>
                                <span class="text-[11px] font-medium text-slate-400 block line-through">${formatPHPDisplay(item.gross)}</span>
                            </div>
                        </div>

                        <div id="details-${item.id}" class="hidden pt-3 border-t border-slate-100 text-xs space-y-1.5 font-mono text-slate-600 bg-slate-50 p-3 rounded-xl mb-3">
                            <div class="flex justify-between"><span>Gross Amount:</span><span>${formatPHPDisplay(item.gross)}</span></div>
                            <div class="flex justify-between"><span>Net Sales (÷1.12):</span><span>${formatPHPDisplay(item.net)}</span></div>
                            ${item.calcType === 'sc' 
                                ? `<div class="flex justify-between text-amber-700 font-bold"><span>SC/PWD Disc (20%):</span><span>-${formatPHPDisplay(item.scDiscount)}</span></div>`
                                : `<div class="flex justify-between text-blue-700"><span>12% VAT:</span><span>${formatPHPDisplay(item.vatAmount)}</span></div>`
                            }
                            ${item.feeAmount > 0 
                                ? `<div class="flex justify-between text-emerald-700"><span>Surcharge (${item.feeRate}%):</span><span>+${formatPHPDisplay(item.feeAmount)}</span></div>` 
                                : ''
                            }
                        </div>
                    </div>

                    <div class="flex items-center justify-between pt-3 border-t border-slate-100 mt-auto">
                        <button onclick="toggleCardDetails('${item.id}')" class="text-[11px] font-bold text-slate-500 hover:text-slate-800 flex items-center gap-1.5 touch-active transition-colors">
                            <i class="fa-solid fa-circle-info"></i> Breakdown
                        </button>

                        <div class="flex items-center space-x-3">
                            <button onclick="openEditModal('${item.id}')" class="text-xs font-bold text-blue-600 hover:text-blue-800 p-1 touch-active flex items-center gap-1">
                                <i class="fa-solid fa-pen-to-square"></i> Edit
                            </button>
                            <button onclick="deleteSaleItem('${item.id}')" class="text-xs font-bold text-red-500 hover:text-red-700 p-1 touch-active">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </div>
                `;
                container.appendChild(card);
            });
        }

        function renderExpenses() {
            const container = document.getElementById("expensesListContainer");
            const expenses = getTodayExpensesList();
            container.innerHTML = "";

            if (expenses.length === 0) {
                container.innerHTML = `
                    <div class="bg-white rounded-2xl p-6 text-center text-slate-400 border border-slate-200/80 space-y-2 col-span-full">
                        <i class="fa-solid fa-receipt text-2xl text-slate-300" aria-hidden="true"></i>
                        <p class="text-xs font-semibold">No expenses recorded for this date.</p>
                        <button type="button" onclick="openAddExpenseModal()" class="text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-100 hover:bg-emerald-100 transition">
                            + Add First Expense
                        </button>
                    </div>
                `;
                return;
            }

            expenses.forEach(expense => {
                const card = document.createElement("article");
                card.className = "ledger-entry-card bg-white rounded-2xl p-4 sm:p-5 border border-slate-200/80 shadow-sm flex flex-col justify-between";
                card.innerHTML = `
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <div class="flex flex-wrap items-center gap-1.5 mb-2">
                                <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">${escapeHtml(expense.category)}</span>
                                <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">${escapeHtml(expense.paymentMethod)}</span>
                            </div>
                            <h3 class="text-sm font-extrabold text-slate-900 leading-tight">${escapeHtml(expense.description)}</h3>
                            ${expense.payee ? `<p class="text-xs text-slate-500 mt-1"><span class="font-semibold">Payee / Recipient:</span> ${escapeHtml(expense.payee)}</p>` : ""}
                            ${expense.notes ? `<p class="expense-notes text-xs text-slate-500 mt-1.5">${escapeHtml(expense.notes)}</p>` : ""}
                        </div>
                        <span class="expense-card-amount text-base sm:text-lg">${formatPHPDisplay(expense.amount)}</span>
                    </div>
                    <div class="flex items-center justify-end gap-3 pt-3 mt-3 border-t border-slate-100">
                        <button type="button" onclick="openEditExpenseModal('${expense.id}')" class="text-xs font-bold text-blue-600 hover:text-blue-800 p-1 touch-active flex items-center gap-1">
                            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Edit
                        </button>
                        <button type="button" onclick="deleteExpenseItem('${expense.id}')" aria-label="Delete expense" class="text-xs font-bold text-red-500 hover:text-red-700 p-1 touch-active">
                            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        </button>
                    </div>
                `;
                container.appendChild(card);
            });
        }

        function toggleCardDetails(id) {
            const el = document.getElementById(`details-${id}`);
            if (el) el.classList.toggle('hidden');
        }

        // CALCULATION
        function setCalcType(type) {
            formCalcType = type;
            const btnSc = document.getElementById('btnCalcSc');
            const btnVat = document.getElementById('btnCalcVat');

            if (type === 'sc') {
                btnSc.className = "h-11 rounded-lg text-xs font-bold transition flex items-center justify-center space-x-1.5 bg-white text-amber-700 shadow-sm border border-amber-200";
                btnVat.className = "h-11 rounded-lg text-xs font-bold transition flex items-center justify-center space-x-1.5 text-slate-600 hover:text-slate-900";
            } else {
                btnVat.className = "h-11 rounded-lg text-xs font-bold transition flex items-center justify-center space-x-1.5 bg-white text-blue-700 shadow-sm border border-blue-200";
                btnSc.className = "h-11 rounded-lg text-xs font-bold transition flex items-center justify-center space-x-1.5 text-slate-600 hover:text-slate-900";
            }
            calculatePreview();
        }

        function setPaymentType(type) {
            formPaymentType = type;
            const btnCash = document.getElementById('btnPayCash');
            const btnGcash = document.getElementById('btnPayGcash');
            const btnCard = document.getElementById('btnPayCard');
            const btnCredit = document.getElementById('btnPayCredit');

            [btnCash, btnGcash, btnCard, btnCredit].forEach(btn => {
                btn.className = "h-11 rounded-xl border text-xs font-bold transition flex flex-col items-center justify-center border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100";
            });

            if (type === 'Cash') btnCash.className = "h-11 rounded-xl border-2 text-xs font-bold transition flex flex-col items-center justify-center border-emerald-500 bg-emerald-50 text-emerald-800 shadow-sm";
            if (type === 'GCash') btnGcash.className = "h-11 rounded-xl border-2 text-xs font-bold transition flex flex-col items-center justify-center border-blue-500 bg-blue-50 text-blue-800 shadow-sm";
            if (type === 'Card') btnCard.className = "h-11 rounded-xl border-2 text-xs font-bold transition flex flex-col items-center justify-center border-purple-500 bg-purple-50 text-purple-800 shadow-sm";
            if (type === 'Credit') btnCredit.className = "h-11 rounded-xl border-2 text-xs font-bold transition flex flex-col items-center justify-center border-amber-500 bg-amber-50 text-amber-800 shadow-sm";

            if (type === 'Credit' || type === 'Card') {
                setFeeRate(0);
            } else {
                setFeeRate(0);
            }
            calculatePreview();
        }

        function setFeeRate(rate) {
            formFeeRate = parseFloat(rate) || 0;
            document.getElementById('creditFeeDisplayBadge').innerText = formFeeRate + '%';

            const btn0 = document.getElementById('btnFee0');
            const btn3 = document.getElementById('btnFee3');
            const btn5 = document.getElementById('btnFee5');
            const btnCustom = document.getElementById('btnFeeCustom');
            const customWrap = document.getElementById('customFeeInputWrapper');

            [btn0, btn3, btn5, btnCustom].forEach(btn => {
                btn.className = "h-9 text-xs font-bold rounded-lg border border-amber-300 bg-white text-amber-800 hover:bg-amber-100 transition";
            });

            if (rate === 0) btn0.className = "h-9 text-xs font-bold rounded-lg bg-amber-600 text-white shadow-sm";
            else if (rate === 3) btn3.className = "h-9 text-xs font-bold rounded-lg bg-amber-600 text-white shadow-sm";
            else if (rate === 5) btn5.className = "h-9 text-xs font-bold rounded-lg bg-amber-600 text-white shadow-sm";
            else btnCustom.className = "h-9 text-xs font-bold rounded-lg bg-amber-600 text-white shadow-sm";

            if (rate !== 0 && rate !== 3 && rate !== 5) {
                customWrap.classList.remove('hidden');
            } else {
                customWrap.classList.add('hidden');
            }

            calculatePreview();
        }

        function toggleCustomFeeInput() {
            document.getElementById('customFeeInputWrapper').classList.remove('hidden');
            document.getElementById('inputCustomFee').focus();
        }

        function handleCustomFeeChange() {
            const val = parseFloat(document.getElementById('inputCustomFee').value) || 0;
            setFeeRate(val);
        }

        function setPreviewCurrency(elementId, amount, prefix = '') {
            const element = document.getElementById(elementId);
            const symbol = document.createElement('span');
            symbol.className = 'preview-currency-symbol';
            symbol.textContent = '₱';
            symbol.setAttribute('aria-hidden', 'true');

            element.replaceChildren(
                document.createTextNode(prefix),
                symbol,
                document.createTextNode(formatPHP(amount).slice(1))
            );
        }

        function sanitizeGrossInput() {
            const input = document.getElementById('inputAmount');
            const value = input.value.replace(/[^\d.]/g, '');
            const decimalIndex = value.indexOf('.');
            input.value = decimalIndex === -1
                ? value
                : `${value.slice(0, decimalIndex)}.${value.slice(decimalIndex + 1).replace(/\./g, '').slice(0, 2)}`;
            calculatePreview();
        }

        function calculatePreview() {
            const gross = parseFloat(document.getElementById('inputAmount').value) || 0;
            const net = gross / 1.12;

            let scDiscount = 0;
            let vatAmount = 0;
            let discountedNet = net;

            if (formCalcType === 'sc') {
                scDiscount = net * 0.20;
                discountedNet = net - scDiscount;
                document.getElementById('prevScRow').classList.remove('hidden');
                document.getElementById('prevVatRow').classList.add('hidden');
            } else {
                vatAmount = gross - net;
                discountedNet = gross;
                document.getElementById('prevScRow').classList.add('hidden');
                document.getElementById('prevVatRow').classList.remove('hidden');
            }

            const feeAmount = discountedNet * (formFeeRate / 100);
            const finalTotal = discountedNet + feeAmount;

            setPreviewCurrency('prevNet', net);
            setPreviewCurrency('prevSc', scDiscount, '-');
            setPreviewCurrency('prevVat', vatAmount);
            document.getElementById('prevFeeRateText').innerText = formFeeRate + '%';
            setPreviewCurrency('prevFee', feeAmount, '+');
            setPreviewCurrency('prevFinalDue', finalTotal);

            return { gross, net, scDiscount, vatAmount, feeAmount, finalTotal };
        }

        // MODALS
        function openAddModal() {
            document.getElementById('editItemId').value = '';
            document.getElementById('modalTitle').innerText = 'New Sale Entry';
            document.getElementById('saleCancellationButton').classList.add('hidden');
            document.getElementById('saleForm').reset();
            document.getElementById('saleForm').scrollTop = 0;
            document.getElementById('inputInvoice').value = generateInvoiceNumber();

            setCalcType('vat');
            setPaymentType('Cash');
            setFeeRate(0);

            showModal('saleModal', 'saleModalPanel');
            setTimeout(() => document.getElementById('inputDesc').focus(), 300);
        }

        function openAddExpenseModal() {
            document.getElementById("expenseEditId").value = "";
            document.getElementById("expenseForm").reset();
            document.getElementById("expenseModalTitle").innerText = "Add Expense";
            document.getElementById("expensePayee").value = "";
            document.getElementById("expenseCategory").value = "Supplies";
            document.getElementById("expensePaymentMethod").value = "Cash";
            showModal("expenseModal", "expenseModalPanel");
            window.setTimeout(() => document.getElementById("expenseDescription").focus(), 100);
        }

        function openEditExpenseModal(id) {
            const expense = SalesDB.listExpenses(currentDateStr).find(item => item.id === id);
            if (!expense) return;
            document.getElementById("expenseForm").reset();
            document.getElementById("expenseEditId").value = expense.id;
            document.getElementById("expenseModalTitle").innerText = "Edit Expense";
            document.getElementById("expenseDescription").value = expense.description;
            document.getElementById("expensePayee").value = expense.payee || "";
            document.getElementById("expenseCategory").value = expense.category;
            document.getElementById("expenseAmount").value = expense.amount;
            document.getElementById("expensePaymentMethod").value = expense.paymentMethod;
            document.getElementById("expenseNotes").value = expense.notes;
            showModal("expenseModal", "expenseModalPanel");
            window.setTimeout(() => document.getElementById("expenseDescription").focus(), 100);
        }

        function closeExpenseModal() {
            const modal = document.getElementById("expenseModal");
            if (document.activeElement instanceof HTMLElement && modal.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            hideModal("expenseModal", "expenseModalPanel");
        }

        async function handleExpenseSubmit(event) {
            event.preventDefault();
            const id = document.getElementById("expenseEditId").value;
            const expense = {
                description: document.getElementById("expenseDescription").value.trim(),
                payee: document.getElementById("expensePayee").value.trim(),
                category: document.getElementById("expenseCategory").value,
                amount: Number(document.getElementById("expenseAmount").value),
                paymentMethod: document.getElementById("expensePaymentMethod").value,
                notes: document.getElementById("expenseNotes").value.trim()
            };
            try {
                const result = await SalesDB.saveExpense(currentDateStr, expense, id || undefined);
                await loadStorageData();
                renderDashboard();
                closeExpenseModal();
                showToast(result.externalError
                    ? `Expense saved on this device, but folder sync failed: ${result.externalError.message}`
                    : id ? "Expense updated." : "Expense recorded.");
            } catch (error) {
                console.error("Expense could not be saved:", error);
                showToast(`Could not save expense: ${error.message}`);
            }
        }

        function deleteExpenseItem(id) {
            showConfirm("Delete expense?", "This expense will be permanently removed from this device.", "Delete", async () => {
                try {
                    const result = await SalesDB.deleteExpense(currentDateStr, id);
                    await loadStorageData();
                    renderDashboard();
                    showToast(result.externalError
                        ? `Expense deleted locally, but folder sync failed: ${result.externalError.message}`
                        : "Expense deleted.");
                } catch (error) {
                    console.error("Expense could not be deleted:", error);
                    throw new Error(`Could not delete expense: ${error.message}`);
                }
            });
        }

        function dateSuffix(dateString) {
            const [year, month, day] = dateString.split("-");
            return `${month}${day}${year}`;
        }

        function generateInvoiceNumber() {
            const prefix = `INV-${dateSuffix(currentDateStr)}-`;
            const sequencePattern = new RegExp(`^${prefix}(\\d+)$`);
            const largestSequence = getTodaySalesList().reduce((largest, sale) => {
                const match = sale.invoiceNo.match(sequencePattern);
                return match ? Math.max(largest, Number(match[1])) : largest;
            }, 0);
            return `${prefix}${String(largestSequence + 1).padStart(4, "0")}`;
        }

        function openEditModal(id) {
            const list = getTodaySalesList();
            const item = list.find(x => x.id === id);
            if (!item) return;

            document.getElementById('editItemId').value = item.id;
            document.getElementById('modalTitle').innerText = 'Edit Sale Entry';
            const cancellationButton = document.getElementById('saleCancellationButton');
            cancellationButton.classList.remove('hidden');
            cancellationButton.innerText = item.cancelled ? 'Restore Sale' : 'Cancel Sale';
            cancellationButton.className = item.cancelled
                ? 'flex-1 h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition touch-active'
                : 'flex-1 h-12 rounded-xl border sale-cancel-button font-bold text-sm transition touch-active';
            document.getElementById('inputDesc').value = item.desc.toLocaleUpperCase();
            document.getElementById('inputAmount').value = item.gross;
            document.getElementById('inputInvoice').value = item.invoiceNo || '';

            setCalcType(item.calcType);
            setPaymentType(item.payType);
            setFeeRate(item.feeRate || 0);

            document.getElementById('saleForm').scrollTop = 0;
            showModal('saleModal', 'saleModalPanel');
        }

        function closeSaleModal() {
            const saleModal = document.getElementById('saleModal');
            if (document.activeElement instanceof HTMLElement && saleModal.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            hideModal('saleModal', 'saleModalPanel');
        }

        function toggleMenuModal() {
            const modal = document.getElementById('menuModal');
            if (modal.classList.contains('pointer-events-none')) {
                showModal('menuModal', 'menuModalPanel');
            } else {
                hideModal('menuModal', 'menuModalPanel');
            }
        }

        function showModal(backdropId, panelId) {
            const backdrop = document.getElementById(backdropId);
            const panel = document.getElementById(panelId);
            panel.scrollTop = 0;
            document.body.classList.add("modal-open");
            backdrop.classList.remove('pointer-events-none', 'opacity-0');
            backdrop.classList.add('opacity-100');
            panel.classList.remove('translate-y-full');
            panel.classList.add('translate-y-0');
            const firstButton = panel.querySelector("button");
            if (firstButton) window.setTimeout(() => firstButton.focus(), 50);
        }

        function hideModal(backdropId, panelId) {
            const backdrop = document.getElementById(backdropId);
            const panel = document.getElementById(panelId);
            panel.classList.remove('translate-y-0');
            panel.classList.add('translate-y-full');
            backdrop.classList.remove('opacity-100');
            backdrop.classList.add('opacity-0');
            setTimeout(() => {
                backdrop.classList.add('pointer-events-none');
                const modalIds = ["saleModal", "expenseModal", "printReportModal", "menuModal", "calendarModal", "confirmModal", "noticeModal", "backupModal"];
                const anotherModalIsOpen = modalIds.some(id =>
                    !document.getElementById(id).classList.contains("pointer-events-none")
                );
                if (!anotherModalIsOpen) document.body.classList.remove("modal-open");
            }, 250);
        }

        // FORM SUBMIT
        async function handleFormSubmit(e) {
            e.preventDefault();

            const invoice = document.getElementById('inputInvoice').value.trim();
            const desc = document.getElementById('inputDesc').value.trim().toLocaleUpperCase();
            const editId = document.getElementById('editItemId').value;
            const calc = calculatePreview();

            if (!desc || calc.gross <= 0) return;

            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

            const sale = {
                invoiceNo: invoice,
                desc,
                gross: calc.gross,
                calcType: formCalcType,
                payType: formPaymentType,
                net: calc.net,
                scDiscount: calc.scDiscount,
                vatAmount: calc.vatAmount,
                feeRate: formFeeRate,
                feeAmount: calc.feeAmount,
                finalTotal: calc.finalTotal,
                time: timeStr,
                cancelled: editId
                    ? Boolean(getTodaySalesList().find(item => String(item.id) === editId)?.cancelled)
                    : false
            };
            try {
                const result = await SalesDB.saveSale(currentDateStr, sale, editId || undefined);
                await loadStorageData();
                renderDashboard();
                closeSaleModal();
                showToast(result.externalError
                    ? `Sale saved on this device, but folder sync failed: ${result.externalError.message}`
                    : editId ? "Sale entry updated!" : "New sale recorded!");
            } catch (error) {
                console.error("Sale could not be saved:", error);
                showToast(`Could not save sale: ${error.message}`);
            }
        }

        function cancelSaleFromEdit() {
            const id = Number(document.getElementById('editItemId').value);
            const item = getTodaySalesList().find(sale => sale.id === id);
            if (!item) return;
            const cancelled = !item.cancelled;
            showConfirm(
                cancelled ? "Cancel this sale?" : "Restore this sale?",
                cancelled
                    ? "This sale will remain in the ledger with a strike-through and be excluded from totals."
                    : "This sale will be included in the ledger totals again.",
                cancelled ? "Cancel sale" : "Restore sale",
                async () => {
                    const result = await SalesDB.setSaleCancelled(currentDateStr, id, cancelled);
                    await loadStorageData();
                    renderDashboard();
                    closeSaleModal();
                    showToast(result.externalError
                        ? `Sale ${cancelled ? "cancelled" : "restored"} on this device, but folder sync failed: ${result.externalError.message}`
                        : `Sale ${cancelled ? "cancelled" : "restored"}.`);
                },
                null,
                "Keep editing",
                cancelled ? "danger" : "success"
            );
        }

        function deleteSaleItem(id) {
            showConfirm("Delete sale?", "This sale will be permanently removed from this device.", "Delete", async () => {
                const result = await SalesDB.deleteSale(currentDateStr, id);
                await loadStorageData();
                renderDashboard();
                showToast(result.externalError
                    ? `Sale deleted locally, but folder sync failed: ${result.externalError.message}`
                    : "Sale item deleted.");
            });
        }

        function clearCurrentDaySales() {
            showConfirm("Clear this day's ledger?", `All sales and expenses for ${currentDateStr} will be permanently removed from this device.`, "Clear ledger", async () => {
                const result = await SalesDB.clearDate(currentDateStr);
                await loadStorageData();
                renderDashboard();
                closeMenuIfOpen();
                showToast(result.externalError
                    ? `Ledger cleared locally, but folder sync failed: ${result.externalError.message}`
                    : "Day ledger cleared.");
            });
        }

        function showConfirm(title, message, actionLabel, action, cancelAction = null, cancelLabel = "Cancel", variant = "danger") {
            document.getElementById("confirmTitle").innerText = title;
            document.getElementById("confirmMessage").innerText = message;
            document.getElementById("confirmActionButton").innerText = actionLabel;
            document.getElementById("confirmCancelButton").innerText = cancelLabel;
            const primary = variant === "primary";
            const success = variant === "success";
            document.getElementById("confirmIconContainer").className = primary
                ? "w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4"
                : success
                    ? "w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-4"
                    : "w-12 h-12 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center mb-4";
            document.getElementById("confirmIcon").className = `fa-solid ${primary ? "fa-folder-plus" : success ? "fa-rotate-left" : "fa-trash-can"} text-lg`;
            document.getElementById("confirmActionButton").className = primary
                ? "w-1/2 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm"
                : success
                    ? "w-1/2 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm"
                    : "w-1/2 h-11 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm";
            pendingConfirmAction = action;
            pendingConfirmCancel = cancelAction;
            showModal("confirmModal", "confirmPanel");
        }

        function closeConfirmModal(runCancelAction = true) {
            const cancelAction = pendingConfirmCancel;
            pendingConfirmAction = null;
            pendingConfirmCancel = null;
            hideModal("confirmModal", "confirmPanel");
            if (runCancelAction && cancelAction) {
                Promise.resolve(cancelAction()).catch(error => {
                    console.error("Cancel action failed:", error);
                    showToast(`Could not return to today: ${error.message}`);
                });
            }
        }

        async function runConfirmAction() {
            if (!pendingConfirmAction) return;
            const button = document.getElementById("confirmActionButton");
            button.disabled = true;
            try {
                await pendingConfirmAction();
                closeConfirmModal(false);
            } catch (error) {
                console.error("Confirmed action failed:", error);
                showToast(`Action failed: ${error.message}`);
            } finally {
                button.disabled = false;
            }
        }

        function closeMenuIfOpen() {
            const modal = document.getElementById("menuModal");
            if (!modal.classList.contains("pointer-events-none")) toggleMenuModal();
        }

        async function exportSummaryCSV() {
            const list = getTodaySalesList();
            const expenses = getTodayExpensesList();
            if (list.length === 0 && expenses.length === 0) {
                showNotice("There are no sales or expenses for the selected date.");
                return;
            }

            const activeSales = list.filter(item => !item.cancelled);
            const dailyNetTotal = activeSales.reduce((total, item) => total + item.net, 0);
            const dailyVatTotal = activeSales.reduce((total, item) => total + (item.vatAmount || 0), 0);
            const dailyExpenseTotal = expenses.reduce((total, expense) => total + expense.amount, 0);
            const dailyCollectedTotal = activeSales.reduce((total, item) => total + item.finalTotal, 0);
            const salesAfterExpenses = (dailyCollectedTotal - dailyExpenseTotal).toFixed(2);
            const rows = [
                ["Record Type", "ID", "Invoice No.", "Date", "Time", "Description", "Payee / Recipient", "Category", "Calc Type", "Payment Method", "Amount (PHP)", "Gross (PHP)", "Net Sales (PHP)", "SC Discount (PHP)", "VAT (PHP)", "Fee Rate (%)", "Fee Amount (PHP)", "Final Collectible (PHP)", "Status", "Daily Net Sales Total (PHP)", "Daily VAT Total (PHP)", "Daily Expenses Total (PHP)", "Sales After Expenses (PHP)", "Dashboard VAT Visible"],
                ...list.map(item => [
                    "Sale", item.id, item.invoiceNo, dateSuffix(currentDateStr), item.time, item.desc, "", "",
                    item.calcType, item.payType, "", item.gross.toFixed(2), item.net.toFixed(2), item.scDiscount.toFixed(2),
                    item.vatAmount.toFixed(2), item.feeRate, item.feeAmount.toFixed(2), item.finalTotal.toFixed(2),
                    item.cancelled ? "Cancelled" : "Active", dailyNetTotal.toFixed(2), dailyVatTotal.toFixed(2),
                    dailyExpenseTotal.toFixed(2), salesAfterExpenses,
                    showDashboardVat ? "Yes" : "No"
                ]),
                ...expenses.map(expense => [
                    "Expense", expense.id, "", dateSuffix(currentDateStr), "", expense.description, expense.payee, expense.category,
                    "", expense.paymentMethod, expense.amount.toFixed(2), "", "", "", "", "", "", "", "Active",
                    dailyNetTotal.toFixed(2), dailyVatTotal.toFixed(2), dailyExpenseTotal.toFixed(2),
                    salesAfterExpenses,
                    showDashboardVat ? "Yes" : "No"
                ])
            ];
            const filename = `LL-${dateSuffix(currentDateStr)}.csv`;
            const contents = rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
            try {
                const savedToFolder = await SalesDB.saveExternalFile(filename, contents);
                if (!savedToFolder) downloadFile(contents, filename, "text/csv;charset=utf-8");
                closeMenuIfOpen();
                showToast(savedToFolder ? `CSV saved to the daily data folder: ${filename}` : `Downloaded ${filename}. Choose a data folder for automatic saving.`);
            } catch (error) {
                console.error("CSV export failed:", error);
                showToast(`Could not save CSV: ${error.message}`);
            }
        }

        function csvEscape(value) {
            return `"${String(value ?? "").replace(/"/g, '""')}"`;
        }

        function openPrintReportModal() {
            if (getTodaySalesList().length === 0 && getTodayExpensesList().length === 0) {
                showNotice("There are no sales or expenses for the selected date.");
                return;
            }
            document.getElementById("printReportForm").reset();
            document.getElementById("reportCompanyName").value = "";
            document.getElementById("reportDateAdded").value = todayDateString();
            showModal("printReportModal", "printReportPanel");
            window.setTimeout(() => document.getElementById("reportCompanyName").focus(), 100);
        }

        function closePrintReportModal() {
            hideModal("printReportModal", "printReportPanel");
        }

        async function exportPrintableReport(event) {
            event.preventDefault();
            const companyName = document.getElementById("reportCompanyName").value.trim();
            const dateAdded = document.getElementById("reportDateAdded").value;
            if (!companyName || !dateAdded) return;

            const sales = getTodaySalesList();
            const activeSales = sales.filter(sale => !sale.cancelled);
            const cancelledSales = sales.filter(sale => sale.cancelled);
            const expenses = getTodayExpensesList();
            const sum = (items, getter) => items.reduce((total, item) => total + getter(item), 0);
            const grossSales = sum(activeSales, sale => sale.gross);
            const netSales = sum(activeSales, sale => sale.net);
            const vatTotal = sum(activeSales, sale => sale.vatAmount || 0);
            const discountTotal = sum(activeSales, sale => sale.scDiscount || 0);
            const feeTotal = sum(activeSales, sale => sale.feeAmount || 0);
            const collectedTotal = sum(activeSales, sale => sale.finalTotal);
            const expenseTotal = sum(expenses, expense => expense.amount);
            const methods = ["Cash", "GCash", "Card", "Credit", "Other"];
            const rows = [
                ["LUMENS LEDGER — DAILY PRINT REPORT"],
                ["Company", companyName],
                ["Date Added", formatReportDate(dateAdded)],
                ["Ledger Date", formatReportDate(currentDateStr)],
                [],
                ["DAILY SUMMARY"],
                ["Metric", "Value"],
                ["Active Sales Count", activeSales.length],
                ["Cancelled Sales Count", cancelledSales.length],
                ["Expense Count", expenses.length],
                ["Gross Sales (PHP)", grossSales.toFixed(2)],
                ["Net Sales (PHP)", netSales.toFixed(2)],
                ["VAT Collected (PHP)", vatTotal.toFixed(2)],
                ["SC/PWD Discounts (PHP)", discountTotal.toFixed(2)],
                ["Surcharges / Fees (PHP)", feeTotal.toFixed(2)],
                ["Total Sales Collected (PHP)", collectedTotal.toFixed(2)],
                ["Total Expenses (PHP)", expenseTotal.toFixed(2)],
                ["Sales Collected After Expenses (PHP)", (collectedTotal - expenseTotal).toFixed(2)],
                [],
                ["PAYMENT METHOD BREAKDOWN"],
                ["Payment Method", "Sales Collected (PHP)", "Expenses by Payment Method (PHP)", "Net After Expenses (PHP)"],
                ...methods.map(method => {
                    const salesByMethod = sum(activeSales.filter(sale => sale.payType === method), sale => sale.finalTotal);
                    const expensesByMethod = sum(expenses.filter(expense => expense.paymentMethod === method), expense => expense.amount);
                    return [method, salesByMethod.toFixed(2), expensesByMethod.toFixed(2), (salesByMethod - expensesByMethod).toFixed(2)];
                }),
                [],
                ["SALES DETAIL"],
                ["Time", "Invoice No.", "Description", "Payment Method", "Gross (PHP)", "Net Sales (PHP)", "SC/PWD Discount (PHP)", "VAT (PHP)", "Fees (PHP)", "Collected (PHP)", "Status"],
                ...sales.map(sale => [
                    sale.time, sale.invoiceNo, sale.desc, sale.payType, sale.gross.toFixed(2),
                    sale.net.toFixed(2), sale.scDiscount.toFixed(2), sale.vatAmount.toFixed(2), sale.feeAmount.toFixed(2),
                    sale.finalTotal.toFixed(2), sale.cancelled ? "Cancelled" : "Active"
                ]),
                [],
                ["EXPENSE DETAIL"],
                ["Description", "Payee / Recipient", "Category", "Payment Method", "Amount (PHP)", "Notes"],
                ...expenses.map(expense => [
                    expense.description, expense.payee, expense.category,
                    expense.paymentMethod, expense.amount.toFixed(2), expense.notes
                ])
            ];
            const filename = `LL-${dateSuffix(currentDateStr)}-REPORT.csv`;
            const contents = `\uFEFF${rows.map(row => row.map(csvEscape).join(",")).join("\r\n")}`;
            try {
                const savedToFolder = await SalesDB.saveExternalFile(filename, contents);
                if (!savedToFolder) downloadFile(contents, filename, "text/csv;charset=utf-8");
                closePrintReportModal();
                closeMenuIfOpen();
                showToast(savedToFolder
                    ? `Printable report saved to the daily data folder: ${filename}`
                    : `Downloaded printable report: ${filename}`);
            } catch (error) {
                console.error("Printable CSV report could not be saved:", error);
                showToast(`Could not save printable report: ${error.message}`);
            }
        }

        function formatReportDate(dateString) {
            const [year, month, day] = dateString.split("-").map(Number);
            return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
                year: "numeric", month: "long", day: "numeric"
            });
        }

        function exportSqliteDatabase() {
            try {
                if (SalesDB.getSalesCount(currentDateStr) === 0 && SalesDB.getExpenseCount(currentDateStr) === 0) {
                    showNotice("There are no sales or expenses in the database to export.");
                    return;
                }
                saveDayDatabaseExport();
            } catch (error) {
                console.error("SQLite export failed:", error);
                showToast(`Could not export database: ${error.message}`);
            }
        }

        async function saveDayDatabaseExport() {
            const filename = `LL-${dateSuffix(currentDateStr)}.sqlite`;
            try {
                const bytes = SalesDB.exportDatabase(currentDateStr);
                const savedToFolder = await SalesDB.saveExternalFile(filename, bytes);
                if (!savedToFolder) downloadFile(bytes, filename, "application/vnd.sqlite3");
                closeMenuIfOpen();
                showToast(savedToFolder ? `SQLite file saved to the daily data folder: ${filename}` : `Downloaded ${filename}. Choose a data folder for automatic saving.`);
            } catch (error) {
                console.error("SQLite export failed:", error);
                showToast(`Could not save SQLite file: ${error.message}`);
            }
        }

        function importSqliteDatabase(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = "";
            if (!file) return;
            showConfirm(
                "Replace this day's ledger?",
                `Importing "${file.name}" replaces the sales and expenses for ${currentDateStr}. Older SQLite files without an expenses table leave this day's expenses unchanged.`,
                "Import daily ledger",
                async () => {
                    try {
                        await SalesDB.importDateDatabase(currentDateStr, await file.arrayBuffer());
                        showDashboardVat = SalesDB.getDashboardVatVisibility();
                        salesData = {};
                        await loadStorageData();
                        renderDashboard();
                        showToast("Daily SQLite ledger imported.");
                    } catch (error) {
                        console.error("SQLite import failed:", error);
                        throw new Error(`Could not import database: ${error.message}`);
                    }
                }
            );
        }

        function downloadFile(contents, filename, type) {
            const url = URL.createObjectURL(new Blob([contents], { type }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        function showNotice(message) {
            closeMenuIfOpen();
            document.getElementById("noticeMessage").innerText = message;
            showModal("noticeModal", "noticePanel");
        }

        function closeNoticeModal() {
            hideModal("noticeModal", "noticePanel");
        }

        async function showBackupHistory() {
            closeMenuIfOpen();
            const list = document.getElementById("backupList");
            list.innerHTML = '<p class="text-sm text-slate-500">Loading backups…</p>';
            showModal("backupModal", "backupPanel");
            try {
                const backups = await SalesDB.listBackups();
                list.replaceChildren();
                if (backups.length === 0) {
                    list.innerHTML = '<p class="text-sm text-slate-500">No automatic backups have been created yet. A snapshot is saved after database changes.</p>';
                    return;
                }
                backups.forEach(backup => {
                    const row = document.createElement("div");
                    row.className = "flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3";
                    const details = document.createElement("div");
                    details.className = "min-w-0";
                    const date = document.createElement("p");
                    date.className = "text-sm font-bold text-slate-800";
                    date.textContent = backup.date;
                    const filename = document.createElement("p");
                    filename.className = "text-xs text-slate-500";
                    filename.textContent = backup.filename;
                    details.append(date, filename);
                    const downloadButton = document.createElement("button");
                    downloadButton.type = "button";
                    downloadButton.className = "shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white";
                    downloadButton.innerHTML = '<i class="fa-solid fa-download mr-1"></i> Download';
                    downloadButton.addEventListener("click", () => downloadBackup(backup.filename));
                    row.append(details, downloadButton);
                    list.appendChild(row);
                });
            } catch (error) {
                console.error("Automatic backup history could not be loaded:", error);
                list.innerHTML = '<p class="text-sm text-red-600">Could not load automatic backups.</p>';
                showToast(`Could not load backups: ${error.message}`);
            }
        }

        async function downloadBackup(filename) {
            try {
                downloadFile(await SalesDB.getBackup(filename), filename, "application/vnd.sqlite3");
            } catch (error) {
                console.error("Automatic backup could not be downloaded:", error);
                showToast(`Could not download backup: ${error.message}`);
            }
        }

        function closeBackupHistory() {
            hideModal("backupModal", "backupPanel");
        }

        function printLedger() {
            const previousTitle = document.title;
            document.title = `LL-${dateSuffix(currentDateStr)}`;
            window.addEventListener("afterprint", () => {
                document.title = previousTitle;
            }, { once: true });
            window.print();
        }

        // UTILS
        function formatPHP(amount) {
            return '₱' + (isNaN(amount) ? 0 : amount).toLocaleString('en-PH', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
        }

        function formatPHPDisplay(amount, fractionDigits = 2) {
            const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;
            const formatted = value.toLocaleString('en-PH', {
                minimumFractionDigits: fractionDigits,
                maximumFractionDigits: fractionDigits
            });
            return `<span class="currency-value"><span class="currency-value-sign" aria-hidden="true">₱</span>${formatted}</span>`;
        }

        function escapeHtml(text) {
            return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }

        function showToast(msg) {
            const toast = document.getElementById('toast');
            document.getElementById('toastMsg').innerText = msg;
            toast.classList.remove('-translate-y-20', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');

            setTimeout(() => {
                toast.classList.remove('translate-y-0', 'opacity-100');
                toast.classList.add('-translate-y-20', 'opacity-0');
            }, 2500);
        }
