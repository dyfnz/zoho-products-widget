/**
 * Distributor Product Lookup Widget
 * For Zoho CRM Quotes module integration
 * Updated: December 2025 - UI Redesign with Products to Quote Queue
 */

// =====================================================
// CONFIGURATION
// =====================================================
const PROXY_BASE = 'https://tydxdpntshbobomemzxj.supabase.co/functions/v1/ingram-proxy';
const PAGE_SIZE = 50;

// Distributor configurations
const DISTRIBUTORS = {
    ingram: {
        name: 'Ingram Micro',
        apiPrefix: '/api',
        color: '#0ea5e9'
    },
    tdsynnex: {
        name: 'TD SYNNEX',
        apiPrefix: '/tdsynnex',
        color: '#10b981',
        disabled: true
    },
    arrow: {
        name: 'Arrow',
        apiPrefix: '/arrow',
        color: '#f59e0b',
        disabled: true
    }
};

// =====================================================
// STATE MANAGEMENT
// =====================================================
const state = {
    currentDistributor: 'ingram',
    // Filters
    manufacturer: '',
    category: '',
    subcategory: '',
    skuType: '',
    skuKeyword: '',
    // Filter loading state
    loadingFilters: {
        category: false,
        subcategory: false
    },
    filterParams: {
        category: '',
        subcategory: ''
    },
    // Pagination and products
    currentPage: 1,
    selectedProducts: new Map(), // Current page selections
    queuedProducts: [], // Persistent queue across searches (array for ordering)
    isAuthenticated: false,
    pendingResponseId: null,
    parentContext: null,
    currentProducts: [],
    pricingData: {}
};

let searchTimeout = null;
let draggedItem = null;

// =====================================================
// ZOHO SDK INITIALIZATION
// =====================================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('Widget DOM loaded, initializing...');
    initZohoSDK();
    initEventListeners();
    initDragAndDrop();
    checkProxyStatus();
    updateQueueUI();
});

function initZohoSDK() {
    if (typeof ZOHO === 'undefined') {
        console.warn('ZOHO SDK not loaded. Running in standalone mode.');
        showStatus('Running in standalone mode (Zoho SDK not available)', 'info');
        return;
    }

    ZOHO.embeddedApp.init();
    console.log('ZOHO.embeddedApp.init() called');

    ZOHO.embeddedApp.on("PageLoad", function(data) {
        console.log('PageLoad event received:', data);
        state.parentContext = data;
        showStatus('Widget loaded. Select a manufacturer to begin.', 'info');
    });

    ZOHO.embeddedApp.on("NotifyAndWait", function(data) {
        console.log('NotifyAndWait event received:', data);
        state.pendingResponseId = data.id;
        state.parentContext = data.data || {};
        showStatus('Ready to search. Select products and click "Add to Queue".', 'info');
    });
}

// =====================================================
// EVENT LISTENERS
// =====================================================
function initEventListeners() {
    const mfrSearch = document.getElementById('manufacturerSearch');
    if (mfrSearch) {
        mfrSearch.addEventListener('input', debounceManufacturerSearch);
    }

    const skuSearch = document.getElementById('skuSearch');
    if (skuSearch) {
        skuSearch.addEventListener('input', () => {
            state.skuKeyword = skuSearch.value.trim();
        });
    }

    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.addEventListener('change', toggleSelectAll);
    }
}

// =====================================================
// DRAG AND DROP FOR QUEUE
// =====================================================
function initDragAndDrop() {
    const queueItems = document.getElementById('queueItems');
    if (!queueItems) return;

    queueItems.addEventListener('dragstart', handleDragStart);
    queueItems.addEventListener('dragend', handleDragEnd);
    queueItems.addEventListener('dragover', handleDragOver);
    queueItems.addEventListener('drop', handleDrop);
}

function handleDragStart(e) {
    if (!e.target.classList.contains('queue-item')) return;

    draggedItem = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', e.target.dataset.partNumber);
}

function handleDragEnd(e) {
    if (draggedItem) {
        draggedItem.classList.remove('dragging');
        draggedItem = null;
    }
    document.querySelectorAll('.queue-item').forEach(item => {
        item.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const afterElement = getDragAfterElement(e.clientY);
    const queueItems = document.getElementById('queueItems');

    if (draggedItem) {
        if (afterElement == null) {
            queueItems.appendChild(draggedItem);
        } else {
            queueItems.insertBefore(draggedItem, afterElement);
        }
    }
}

function handleDrop(e) {
    e.preventDefault();

    // Reorder state.queuedProducts based on new DOM order
    const newOrder = [];
    document.querySelectorAll('.queue-item').forEach(item => {
        const partNumber = item.dataset.partNumber;
        const product = state.queuedProducts.find(p =>
            (p.ingramPartNumber || p.vendorPartNumber) === partNumber
        );
        if (product) {
            newOrder.push(product);
        }
    });

    state.queuedProducts = newOrder;
    console.log('[Queue] Reordered:', state.queuedProducts.map(p => p.vendorPartNumber));
}

function getDragAfterElement(y) {
    const draggableElements = [...document.querySelectorAll('.queue-item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// =====================================================
// DISTRIBUTOR SELECTION
// =====================================================
function selectDistributor(distributor) {
    if (DISTRIBUTORS[distributor]?.disabled) {
        showStatus(`${DISTRIBUTORS[distributor].name} integration coming soon`, 'info');
        return;
    }

    state.currentDistributor = distributor;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.distributor === distributor);
    });

    resetFilters();
    showStatus(`Switched to ${DISTRIBUTORS[distributor].name}. Search for a manufacturer.`, 'info');
}

// =====================================================
// PROXY STATUS CHECK
// =====================================================
async function checkProxyStatus() {
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');

    try {
        const response = await fetch(`${PROXY_BASE}?action=status`);
        const data = await response.json();

        if (data.authenticated) {
            indicator.classList.add('connected');
            statusText.textContent = 'Connected';
            state.isAuthenticated = true;
        } else if (data.configured) {
            statusText.textContent = 'Not authenticated';
            await authenticate();
        } else {
            statusText.textContent = 'Not configured';
            showStatus('Proxy server not configured. Check credentials.', 'error');
        }
    } catch (error) {
        indicator.classList.remove('connected');
        statusText.textContent = 'Offline';
        showStatus('Cannot connect to proxy server.', 'error');
    }
}

async function authenticate() {
    try {
        const response = await fetch(`${PROXY_BASE}?action=auth`);
        const data = await response.json();

        if (data.success) {
            document.getElementById('statusIndicator').classList.add('connected');
            document.getElementById('statusText').textContent = 'Connected';
            state.isAuthenticated = true;
            showStatus('Authentication successful. Search for a manufacturer.', 'success');
        }
    } catch (error) {
        showStatus('Authentication failed: ' + error.message, 'error');
    }
}

// =====================================================
// MANUFACTURER SEARCH
// =====================================================
function debounceManufacturerSearch() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(searchManufacturers, 300);
}

async function searchManufacturers() {
    const searchTerm = document.getElementById('manufacturerSearch').value.trim();
    const select = document.getElementById('manufacturerSelect');

    if (searchTerm.length < 2) {
        select.innerHTML = '<option value="">Type 2+ characters to search...</option>';
        document.getElementById('mfrCount').textContent = '';
        return;
    }

    showStatus(`Searching manufacturers matching "${searchTerm}"...`, 'loading');

    try {
        const response = await fetch(
            `${PROXY_BASE}?action=manufacturers&search=${encodeURIComponent(searchTerm)}`
        );
        const data = await response.json();

        select.innerHTML = '<option value="">-- Select a manufacturer --</option>';

        if (data.manufacturers && data.manufacturers.length > 0) {
            data.manufacturers.forEach(mfr => {
                const option = document.createElement('option');
                option.value = mfr;
                option.textContent = mfr;
                select.appendChild(option);
            });
            document.getElementById('mfrCount').textContent = `(${data.manufacturers.length})`;
            showStatus(`Found ${data.manufacturers.length} manufacturers`, 'success');
        } else {
            select.innerHTML = '<option value="">No manufacturers found</option>';
            document.getElementById('mfrCount').textContent = '(0)';
            showStatus('No manufacturers found. Try a different search term.', 'info');
        }
    } catch (error) {
        showStatus('Error searching: ' + error.message, 'error');
    }
}

// =====================================================
// MANUFACTURER SELECTION
// =====================================================
async function onManufacturerSelect() {
    const select = document.getElementById('manufacturerSelect');
    state.manufacturer = select.value;

    resetOptionalFilters();
    resetProducts();

    if (!state.manufacturer) {
        document.getElementById('optionalFiltersRow').style.display = 'none';
        document.getElementById('skuActionsRow').style.display = 'none';
        return;
    }

    document.getElementById('optionalFiltersRow').style.display = 'flex';
    document.getElementById('skuActionsRow').style.display = 'flex';

    showStatus(`Manufacturer: ${state.manufacturer}. Loading categories...`, 'loading');

    await loadFilterOptions('category');

    showStatus(`Manufacturer: ${state.manufacturer}. Use filters below or click Load Products.`, 'success');
}

// =====================================================
// FILTER LOADING
// =====================================================
async function loadFilterOptions(filterType) {
    const currentParams = `${state.manufacturer}|${state.category}|${state.subcategory}|${state.skuType}`;

    if (state.loadingFilters[filterType]) return;
    if (state.filterParams[filterType] === currentParams) return;

    state.loadingFilters[filterType] = true;

    let url = `${PROXY_BASE}?vendor=${encodeURIComponent(state.manufacturer)}`;
    let selectEl, countEl, dataKey;

    switch (filterType) {
        case 'category':
            url += `&action=categories`;
            if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
            if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
            selectEl = document.getElementById('categorySelect');
            countEl = document.getElementById('catCount');
            dataKey = 'categories';
            break;

        case 'subcategory':
            url += `&action=subcategories`;
            if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
            if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
            selectEl = document.getElementById('subcategorySelect');
            countEl = document.getElementById('subCatCount');
            dataKey = 'subcategories';
            break;

        default:
            state.loadingFilters[filterType] = false;
            return;
    }

    const currentValue = selectEl.value;
    selectEl.innerHTML = '<option value="">Loading...</option>';

    try {
        const response = await fetch(url);
        const data = await response.json();

        selectEl.innerHTML = '<option value="">-- Any --</option>';

        const items = data[dataKey] || [];
        if (items.length > 0) {
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = item;
                option.textContent = item;
                selectEl.appendChild(option);
            });
            countEl.textContent = `(${items.length})`;

            if (currentValue && items.includes(currentValue)) {
                selectEl.value = currentValue;
            }
        } else {
            countEl.textContent = '(0)';
        }

        state.filterParams[filterType] = currentParams;

    } catch (error) {
        console.error(`Error loading ${filterType}:`, error);
        selectEl.innerHTML = '<option value="">-- Error --</option>';
    }

    state.loadingFilters[filterType] = false;
}

function formatSKUType(type) {
    switch (type) {
        case 'IM::physical':
        case 'IM::Physical':
        case 'Physical':
            return 'Physical';
        case 'IM::digital':
        case 'IM::Digital':
        case 'Digital':
            return 'Digital';
        case 'IM::subscription':
        case 'IM::Subscription':
        case 'Subscription':
            return 'Subscription';
        default:
            return type || '-';
    }
}

async function onFilterChange(filterType) {
    const selectEl = document.getElementById(
        filterType === 'category' ? 'categorySelect' :
        filterType === 'subcategory' ? 'subcategorySelect' :
        'skuTypeSelect'
    );

    state[filterType] = selectEl.value;

    if (filterType !== 'category') state.filterParams.category = '';
    if (filterType !== 'subcategory') state.filterParams.subcategory = '';

    resetProducts();

    if (filterType === 'category' && state.category) {
        await loadFilterOptions('subcategory');
    }
}

// =====================================================
// PRODUCTS LOADING
// =====================================================
async function loadProducts(page = 1) {
    if (!state.manufacturer) {
        showStatus('Please select a manufacturer first', 'error');
        return;
    }

    state.currentPage = page;
    const productsSection = document.getElementById('productsSection');
    productsSection.style.display = 'block';
    showStatus('Loading products with pricing...', 'loading');

    try {
        let url = `${PROXY_BASE}?action=productsWithPricing&vendor=${encodeURIComponent(state.manufacturer)}&page=${page}`;
        if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
        if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
        if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
        if (state.skuKeyword && state.skuKeyword.length >= 2) {
            url += `&keyword=${encodeURIComponent(state.skuKeyword)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (data.products && data.products.length > 0) {
            displayProductsWithPricing(data.products, data.pagination);
            showStatus('', '');
        } else {
            document.getElementById('productsBody').innerHTML =
                '<tr><td colspan="7" class="no-results">No products found</td></tr>';
            document.getElementById('pagination').innerHTML = '';
            document.getElementById('productCount').textContent = '0 products';
            showStatus('No products found with current filters', 'info');
        }
    } catch (error) {
        showStatus('Error loading products: ' + error.message, 'error');
    }
}

function displayProductsWithPricing(products, pagination) {
    const tbody = document.getElementById('productsBody');
    tbody.innerHTML = '';

    const sortedProducts = [...products].sort((a, b) => {
        const partA = (a.vendorPartNumber || '').toLowerCase();
        const partB = (b.vendorPartNumber || '').toLowerCase();
        return partA.localeCompare(partB, undefined, { numeric: true, sensitivity: 'base' });
    });

    state.currentProducts = sortedProducts;
    state.pricingData = {};

    sortedProducts.forEach((product, index) => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const isSelected = state.selectedProducts.has(partNumber);
        const isQueued = state.queuedProducts.some(p =>
            (p.ingramPartNumber || p.vendorPartNumber) === partNumber
        );

        const pricingData = product.pricingData;
        const msrp = pricingData?.pricing?.retailPrice;
        const msrpDisplay = msrp
            ? `<span class="price-available">$${msrp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
            : '<span class="price-unavailable">-</span>';

        if (pricingData && product.ingramPartNumber) {
            state.pricingData[product.ingramPartNumber] = pricingData;
        }

        const tr = document.createElement('tr');
        tr.className = isSelected ? 'selected' : '';
        if (isQueued) tr.classList.add('queued');
        tr.id = `product-row-${index}`;
        tr.innerHTML = `
            <td class="col-checkbox">
                <input type="checkbox"
                       onchange="toggleProduct('${partNumber}', this.checked)"
                       ${isSelected ? 'checked' : ''}
                       ${isQueued ? 'disabled title="Already in queue"' : ''}>
            </td>
            <td class="col-part"><strong>${product.vendorPartNumber || '-'}</strong></td>
            <td class="col-desc">${(product.description || '-').substring(0, 40)}${(product.description || '').length > 40 ? '...' : ''}</td>
            <td class="col-mfr">${product.vendorName || state.manufacturer}</td>
            <td class="col-sku">${product.ingramPartNumber || '-'}</td>
            <td class="col-price">${msrpDisplay}</td>
            <td class="col-action">
                <button class="info-btn" onclick="showProductDetails(${index})" title="View details">i</button>
            </td>
        `;
        tbody.appendChild(tr);

        tr.dataset.product = JSON.stringify(product);
    });

    document.getElementById('productCount').textContent =
        `${pagination.totalRecords.toLocaleString()} products`;

    renderPagination(pagination);
    updateSelectedCount();
}

function renderPagination(pagination) {
    const paginationDiv = document.getElementById('pagination');

    if (pagination.totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }

    paginationDiv.innerHTML = `
        <button onclick="loadProducts(${pagination.page - 1})"
                ${pagination.page === 1 ? 'disabled' : ''} class="btn-secondary btn-small">
            Previous
        </button>
        <span>Page ${pagination.page} of ${pagination.totalPages}</span>
        <button onclick="loadProducts(${pagination.page + 1})"
                ${pagination.page >= pagination.totalPages ? 'disabled' : ''} class="btn-secondary btn-small">
            Next
        </button>
    `;
}

// =====================================================
// PRODUCT SELECTION
// =====================================================
function toggleProduct(partNumber, isChecked) {
    const rows = document.querySelectorAll('#productsBody tr');

    rows.forEach(row => {
        const productData = row.dataset.product;
        if (productData) {
            const product = JSON.parse(productData);
            const pn = product.ingramPartNumber || product.vendorPartNumber;

            if (pn === partNumber) {
                if (isChecked) {
                    state.selectedProducts.set(partNumber, product);
                    row.classList.add('selected');
                } else {
                    state.selectedProducts.delete(partNumber);
                    row.classList.remove('selected');
                }
            }
        }
    });

    updateSelectedCount();
}

function toggleSelectAll() {
    const selectAllChecked = document.getElementById('selectAll').checked;
    const checkboxes = document.querySelectorAll('#productsBody input[type="checkbox"]:not(:disabled)');

    checkboxes.forEach(cb => {
        cb.checked = selectAllChecked;
        const row = cb.closest('tr');
        const productData = row.dataset.product;

        if (productData) {
            const product = JSON.parse(productData);
            const partNumber = product.ingramPartNumber || product.vendorPartNumber;

            if (selectAllChecked) {
                state.selectedProducts.set(partNumber, product);
                row.classList.add('selected');
            } else {
                state.selectedProducts.delete(partNumber);
                row.classList.remove('selected');
            }
        }
    });

    updateSelectedCount();
}

function updateSelectedCount() {
    const count = state.selectedProducts.size;
    document.getElementById('selectedCount').textContent = count;

    const addToQueueBtn = document.getElementById('addToQueueBtn');
    if (addToQueueBtn) {
        addToQueueBtn.disabled = count === 0;
    }
}

// =====================================================
// QUEUE MANAGEMENT
// =====================================================
function addSelectedToQueue() {
    const selectedArray = Array.from(state.selectedProducts.values());

    if (selectedArray.length === 0) {
        showStatus('No products selected', 'error');
        return;
    }

    let addedCount = 0;
    selectedArray.forEach(product => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const alreadyQueued = state.queuedProducts.some(p =>
            (p.ingramPartNumber || p.vendorPartNumber) === partNumber
        );

        if (!alreadyQueued) {
            // Enrich product with pricing data if available
            const pricingData = product.pricingData || state.pricingData?.[product.ingramPartNumber];
            const enrichedProduct = { ...product, pricingData };
            state.queuedProducts.push(enrichedProduct);
            addedCount++;
        }
    });

    // Clear current selection
    state.selectedProducts.clear();
    updateSelectedCount();

    // Uncheck all checkboxes
    document.querySelectorAll('#productsBody input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.closest('tr').classList.remove('selected');
    });
    document.getElementById('selectAll').checked = false;

    // Refresh product display to show queued items as disabled
    if (state.currentProducts.length > 0) {
        displayProductsWithPricing(state.currentProducts, {
            totalRecords: state.currentProducts.length,
            page: state.currentPage,
            totalPages: 1
        });
    }

    updateQueueUI();

    if (addedCount > 0) {
        showStatus(`Added ${addedCount} product(s) to queue`, 'success');
    } else {
        showStatus('Products already in queue', 'info');
    }
}

function removeFromQueue(partNumber) {
    state.queuedProducts = state.queuedProducts.filter(p =>
        (p.ingramPartNumber || p.vendorPartNumber) !== partNumber
    );
    updateQueueUI();

    // Re-enable checkbox in products table if visible
    document.querySelectorAll('#productsBody input[type="checkbox"][disabled]').forEach(cb => {
        const row = cb.closest('tr');
        const productData = row.dataset.product;
        if (productData) {
            const product = JSON.parse(productData);
            const pn = product.ingramPartNumber || product.vendorPartNumber;
            if (pn === partNumber) {
                cb.disabled = false;
                cb.title = '';
                row.classList.remove('queued');
            }
        }
    });
}

function clearQueue() {
    state.queuedProducts = [];
    updateQueueUI();

    // Re-enable all disabled checkboxes
    document.querySelectorAll('#productsBody input[type="checkbox"][disabled]').forEach(cb => {
        cb.disabled = false;
        cb.title = '';
        cb.closest('tr').classList.remove('queued');
    });

    showStatus('Queue cleared', 'info');
}

function updateQueueUI() {
    const queueCount = state.queuedProducts.length;

    document.getElementById('queueCount').textContent = queueCount;
    document.getElementById('queueTotalCount').textContent = queueCount;

    const queueEmpty = document.getElementById('queueEmpty');
    const queueList = document.getElementById('queueList');
    const queueFooter = document.getElementById('queueFooter');
    const clearQueueBtn = document.getElementById('clearQueueBtn');

    if (queueCount === 0) {
        queueEmpty.style.display = 'flex';
        queueList.style.display = 'none';
        queueFooter.style.display = 'none';
        clearQueueBtn.style.display = 'none';
    } else {
        queueEmpty.style.display = 'none';
        queueList.style.display = 'block';
        queueFooter.style.display = 'block';
        clearQueueBtn.style.display = 'block';

        renderQueueItems();
    }
}

function renderQueueItems() {
    const queueItems = document.getElementById('queueItems');
    queueItems.innerHTML = '';

    state.queuedProducts.forEach((product, index) => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const msrp = product.pricingData?.pricing?.retailPrice || product.retailPrice;
        const msrpDisplay = msrp
            ? `$${msrp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '-';

        const li = document.createElement('li');
        li.className = 'queue-item';
        li.draggable = true;
        li.dataset.partNumber = partNumber;
        li.dataset.index = index;

        li.innerHTML = `
            <div class="queue-item-drag">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
                    <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
                </svg>
            </div>
            <div class="queue-item-info">
                <div class="queue-item-part">${product.vendorPartNumber || '-'}</div>
                <div class="queue-item-desc">${(product.description || '-').substring(0, 35)}${(product.description || '').length > 35 ? '...' : ''}</div>
                <div class="queue-item-mfr">${product.vendorName || state.manufacturer}</div>
            </div>
            <div class="queue-item-price">${msrpDisplay}</div>
            <button class="queue-item-remove" onclick="removeFromQueue('${partNumber}')" title="Remove from queue">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
            </button>
        `;

        queueItems.appendChild(li);
    });
}

function submitQueue() {
    if (state.queuedProducts.length === 0) {
        showStatus('No products in queue', 'error');
        return;
    }

    const formattedProducts = state.queuedProducts.map(product => {
        const pricingData = product.pricingData || state.pricingData?.[product.ingramPartNumber] || {};
        const msrp = pricingData?.pricing?.retailPrice || product.retailPrice || null;

        return {
            Product_Code: product.vendorPartNumber || '',
            Product_Name: product.description || '',
            Manufacturer: product.vendorName || state.manufacturer,
            Ingram_Micro_SKU: product.ingramPartNumber || '',
            MSRP: msrp,
            Category: product.category || state.category || '',
            Subcategory: product.subCategory || state.subcategory || '',
            UPC: pricingData?.upc || product.upcCode || '',
            Description: product.extraDescription || pricingData?.description || '',
            Last_Sync_Source: DISTRIBUTORS[state.currentDistributor]?.name || 'Ingram Micro',
            Quantity: 1
        };
    });

    console.log('Sending queued products to parent:', formattedProducts);

    if (typeof $Client !== 'undefined') {
        $Client.close({
            products: formattedProducts,
            distributor: state.currentDistributor
        });
    } else {
        console.log('Standalone mode - would send:', formattedProducts);
        showStatus(`Queued ${formattedProducts.length} products (standalone mode)`, 'info');
    }
}

// =====================================================
// BATCH PRICING (fallback)
// =====================================================
async function fetchBatchPricing(products) {
    const partNumbers = products
        .map(p => p.ingramPartNumber)
        .filter(pn => pn);

    if (partNumbers.length === 0) return;

    try {
        const response = await fetch(`${PROXY_BASE}?action=pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partNumbers, sandbox: false })
        });

        const data = await response.json();
        state.pricingData = {};

        if (Array.isArray(data)) {
            data.forEach(item => {
                state.pricingData[item.ingramPartNumber] = item;
            });
        }
    } catch (error) {
        console.error('[Pricing] Error:', error);
    }
}

// =====================================================
// PRODUCT DETAILS
// =====================================================
async function showProductDetails(productIndex) {
    const product = state.currentProducts[productIndex];
    if (!product) {
        console.error('Product not found at index:', productIndex);
        return;
    }

    const ingramPn = product.ingramPartNumber;
    console.log(`[Details] Loading details for ${ingramPn}...`);

    const detailsSection = document.getElementById('productDetailsSection');
    detailsSection.style.display = 'block';
    detailsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let pricingData = state.pricingData?.[ingramPn];
    let productDetails = null;

    if (ingramPn) {
        const fetchPromises = [];

        if (!pricingData) {
            fetchPromises.push(
                fetch(`${PROXY_BASE}?action=pricing`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ partNumbers: [ingramPn], sandbox: false })
                })
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data) && data.length > 0) {
                        pricingData = data[0];
                        state.pricingData[ingramPn] = pricingData;
                    }
                })
                .catch(err => console.error('[Details] Error fetching pricing:', err))
            );
        }

        fetchPromises.push(
            fetch(`${PROXY_BASE}?action=productDetails&ingramPartNumber=${encodeURIComponent(ingramPn)}`)
                .then(res => res.json())
                .then(data => {
                    if (data && !data.error) {
                        productDetails = data;
                    }
                })
                .catch(err => console.error('[Details] Error fetching product details:', err))
        );

        await Promise.all(fetchPromises);
    }

    const fullProductData = { ...product, pricingData, productDetails };

    const isAuthorized = product.authorizedToPurchase === 'true' ||
                         product.authorizedToPurchase === true ||
                         pricingData?.productAuthorized === true;
    const authorizedText = isAuthorized ? 'Yes' : 'No';
    const authorizedClass = isAuthorized ? 'authorized-yes' : 'authorized-no';

    document.getElementById('detailsTitle').textContent = product.description || 'No Description';
    document.getElementById('detailsSubtitle').innerHTML = `
        <strong>Ingram SKU:</strong> ${ingramPn || 'N/A'} |
        <strong>Vendor Part:</strong> ${product.vendorPartNumber || 'N/A'} |
        <strong>Manufacturer:</strong> ${product.vendorName || state.manufacturer} |
        <strong>Authorized:</strong> <span class="${authorizedClass}">${authorizedText}</span>
    `;

    const longDesc = product.extraDescription || pricingData?.description || '';
    const longDescEl = document.getElementById('detailsLongDesc');
    if (longDesc) {
        longDescEl.innerHTML = `<strong>Long Description:</strong> ${longDesc}`;
        longDescEl.style.display = 'block';
    } else {
        longDescEl.style.display = 'none';
    }

    const renderGrid = (elementId, fields) => {
        const grid = document.getElementById(elementId);
        if (grid) {
            grid.innerHTML = fields.map(f => `
                <div class="field-mapping-item">
                    <span class="field-label">${f.label}</span>
                    <span class="field-value">${f.value}</span>
                </div>
            `).join('');
        }
    };

    const yesNo = (val) => {
        if (val === true) return 'Yes';
        if (val === false) return 'No';
        if (typeof val === 'string') {
            const lower = val.toLowerCase();
            if (lower === 'true' || lower === 'yes') return 'Yes';
            if (lower === 'false' || lower === 'no') return 'No';
        }
        return '-';
    };

    const formatCurrency = (val) => {
        if (val === null || val === undefined) return '-';
        return `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const productInfoFields = [
        { label: 'Product Name', value: product.description || '-' },
        { label: 'Category', value: product.category || state.category || '-' },
        { label: 'Subcategory', value: product.subCategory || state.subcategory || '-' },
        { label: 'Product Type', value: product.productType || '-' },
        { label: 'SKU Type', value: formatSKUType(product.type) },
        { label: 'Product Class', value: pricingData?.productClass || product.productClass || '-' },
        { label: 'Replacement SKU', value: product.replacementSku || '-' }
    ];
    renderGrid('productInfoGrid', productInfoFields);

    const msrpValue = formatCurrency(pricingData?.pricing?.retailPrice);
    const customerPriceValue = formatCurrency(pricingData?.pricing?.customerPrice);

    let subscriptionPriceValue = '-';
    if (pricingData?.subscriptionPrice && Array.isArray(pricingData.subscriptionPrice) && pricingData.subscriptionPrice.length > 0) {
        const subPrice = pricingData.subscriptionPrice[0];
        if (subPrice?.options?.[0]?.resourcePricing?.[0]?.msrp) {
            subscriptionPriceValue = formatCurrency(subPrice.options[0].resourcePricing[0].msrp);
        }
    }

    const pricingFields = [
        { label: 'MSRP', value: msrpValue },
        { label: 'Customer Price', value: customerPriceValue },
        { label: 'Subscription Price', value: subscriptionPriceValue }
    ];
    renderGrid('pricingGrid', pricingFields);

    const discountsGroup = document.getElementById('discountsGroup');
    const discountsBody = document.getElementById('discountsBody');

    let allDiscounts = [];
    if (pricingData?.discounts && Array.isArray(pricingData.discounts)) {
        pricingData.discounts.forEach(discountGroup => {
            if (discountGroup.specialPricing && Array.isArray(discountGroup.specialPricing)) {
                allDiscounts.push(...discountGroup.specialPricing);
            }
        });
    }

    if (allDiscounts.length > 0) {
        discountsGroup.style.display = 'block';
        discountsBody.innerHTML = allDiscounts.map(d => `
            <tr>
                <td>${d.discountType || '-'}</td>
                <td>${d.specialBidNumber || '-'}</td>
                <td class="text-right">${formatCurrency(d.specialPricingDiscount)}</td>
                <td class="text-right">${d.specialPricingAvailableQuantity ?? '-'}</td>
                <td>${d.specialPricingEffectiveDate || '-'}</td>
                <td>${d.specialPricingExpirationDate || '-'}</td>
            </tr>
        `).join('');
    } else {
        discountsGroup.style.display = 'none';
    }

    const availabilityFields = [
        { label: 'Available Qty', value: pricingData?.availability?.totalAvailability ?? '-' },
        { label: 'In Stock', value: yesNo(pricingData?.availability?.available) }
    ];
    renderGrid('availabilityGrid', availabilityFields);

    const indicators = productDetails?.indicators || {};

    const flagsFields = [
        { label: 'Digital Product', value: yesNo(indicators.isDigitalType || product.type === 'IM::Digital' || product.type === 'IM::digital') },
        { label: 'License Product', value: yesNo(indicators.isLicenseProduct) },
        { label: 'Service SKU', value: yesNo(indicators.isServiceSku) },
        { label: 'Has Bundle', value: yesNo(indicators.hasBundle || pricingData?.bundlePartIndicator) },
        { label: 'Direct Ship', value: yesNo(product.directShip || indicators.isDirectship) },
        { label: 'Discontinued', value: yesNo(product.discontinued || indicators.isDiscontinuedProduct) },
        { label: 'New Product', value: yesNo(product.newProduct || indicators.isNewProduct) }
    ];
    renderGrid('flagsGrid', flagsFields);

    const warehouseSection = document.getElementById('warehouseSection');
    const warehouseBody = document.getElementById('warehouseBody');

    if (pricingData?.availability?.availabilityByWarehouse?.length > 0) {
        warehouseSection.style.display = 'block';
        warehouseBody.innerHTML = pricingData.availability.availabilityByWarehouse.map(wh => `
            <tr>
                <td>${wh.warehouseId}</td>
                <td>${wh.location || '-'}</td>
                <td class="text-right">${wh.quantityAvailable ?? 0}</td>
                <td class="text-right">${wh.quantityBackordered ?? 0}</td>
            </tr>
        `).join('');
    } else {
        warehouseSection.style.display = 'none';
    }

    document.getElementById('rawApiResponse').textContent = JSON.stringify(fullProductData, null, 2);
}

function hideProductDetails() {
    document.getElementById('productDetailsSection').style.display = 'none';
}

// =====================================================
// ACTION HANDLERS (Legacy support)
// =====================================================
function addSelectedProducts() {
    // Legacy function - now redirects to queue workflow
    addSelectedToQueue();
}

function cancelSelection() {
    console.log('Cancel clicked');

    if (typeof $Client !== 'undefined') {
        $Client.close({ cancelled: true, products: [] });
    }

    state.selectedProducts.clear();
    state.queuedProducts = [];
    updateSelectedCount();
    updateQueueUI();
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================
function resetFilters() {
    state.manufacturer = '';
    state.currentPage = 1;

    document.getElementById('manufacturerSearch').value = '';
    document.getElementById('manufacturerSelect').innerHTML =
        '<option value="">Type to search manufacturers...</option>';
    document.getElementById('mfrCount').textContent = '';

    document.getElementById('optionalFiltersRow').style.display = 'none';
    document.getElementById('skuActionsRow').style.display = 'none';

    resetOptionalFilters();
    resetProducts();

    document.getElementById('productsSection').style.display = 'none';
    showStatus('Select a manufacturer to begin', 'info');
}

function resetOptionalFilters() {
    state.category = '';
    state.subcategory = '';
    state.skuType = '';
    state.skuKeyword = '';

    state.filterParams.category = '';
    state.filterParams.subcategory = '';

    const catSelect = document.getElementById('categorySelect');
    if (catSelect) {
        catSelect.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('catCount').textContent = '';
    }

    const subSelect = document.getElementById('subcategorySelect');
    if (subSelect) {
        subSelect.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('subCatCount').textContent = '';
    }

    const skuTypeSelect = document.getElementById('skuTypeSelect');
    if (skuTypeSelect) {
        skuTypeSelect.value = '';
    }

    const skuSearch = document.getElementById('skuSearch');
    if (skuSearch) {
        skuSearch.value = '';
    }
}

function resetProducts() {
    document.getElementById('productsBody').innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    document.getElementById('productCount').textContent = '0 products';
    document.getElementById('productDetailsSection').style.display = 'none';

    // Only clear current page selection, NOT the queue
    state.selectedProducts.clear();
    state.currentProducts = [];
    state.pricingData = {};

    updateSelectedCount();

    // Reset select all checkbox
    const selectAll = document.getElementById('selectAll');
    if (selectAll) selectAll.checked = false;
}

function showStatus(message, type) {
    const el = document.getElementById('filterStatus');
    if (!el) return;

    el.className = `status-bar ${type}`;
    el.innerHTML = `<span class="status-message">${message}</span>`;

    if (!message) {
        el.style.display = 'none';
    } else {
        el.style.display = 'flex';
    }
}
